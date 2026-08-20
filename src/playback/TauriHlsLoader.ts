import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse,
  LoaderStats,
  NullableNetworkDetails,
  RetryConfig,
} from "hls.js";
import {
  declaredResponseLength,
  playbackResponseLimit,
  readBoundedResponse,
  ResponseBodyUnavailableError,
  ResponseSizeLimitError,
} from "./boundedResponse";
import { mediaFetch, type MediaFetcher } from "./nativeFetch";
import type { StreamSource } from "./types";

type HlsLoaderConstructor = new (config: HlsConfig) => Loader<LoaderContext>;
type RetryKind = "timeout" | "error";

function freshStats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

export function createTauriHlsLoader(
  source: StreamSource,
  fetcher: MediaFetcher = mediaFetch,
): HlsLoaderConstructor {
  return class TauriHlsLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats: LoaderStats = freshStats();
    private controller: AbortController | null = null;
    private callbacks: LoaderCallbacks<LoaderContext> | null = null;
    private config: LoaderConfiguration | null = null;
    private responseHeaders = new Headers();
    private requestTimer: ReturnType<typeof setTimeout> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private requestSerial = 0;
    private finished = true;

    constructor(_config: HlsConfig) {}

    load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      this.abort(false);
      this.context = context;
      this.config = config;
      this.callbacks = callbacks;
      this.stats = freshStats();
      this.finished = false;
      this.startRequest();
    }

    abort(notify = true): void {
      if (this.finished && !this.controller && !this.retryTimer) return;
      const activeContext = this.context;
      const activeCallbacks = this.callbacks;
      this.stats.aborted = true;
      this.finished = true;
      this.invalidateRequest();
      if (notify && activeContext) {
        activeCallbacks?.onAbort?.(this.stats, activeContext, null);
      }
    }

    destroy(): void {
      this.abort(false);
      this.context = null;
      this.config = null;
      this.callbacks = null;
    }

    getCacheAge(): number | null {
      const ageHeader = this.responseHeaders.get("age");
      if (ageHeader === null || !ageHeader.trim()) return null;
      const age = Number(ageHeader);
      return Number.isFinite(age) && age >= 0 ? age : null;
    }

    getResponseHeader(name: string): string | null {
      return this.responseHeaders.get(name);
    }

    private startRequest(): void {
      const context = this.context;
      const config = this.config;
      if (this.finished || !context || !config) return;

      this.clearRequestTimer();
      this.controller?.abort();
      const controller = new AbortController();
      this.controller = controller;
      const serial = ++this.requestSerial;
      const attemptStart = performance.now();
      this.stats.aborted = false;
      this.stats.loaded = 0;
      this.stats.total = 0;
      this.stats.chunkCount = 0;
      this.stats.loading = { start: attemptStart, first: 0, end: 0 };

      const headers = new Headers(context.headers);
      if (context.rangeStart !== undefined) {
        const last = context.rangeEnd !== undefined ? context.rangeEnd - 1 : "";
        headers.set("Range", `bytes=${context.rangeStart}-${last}`);
      }

      const maxLoadTime = boundedDuration(
        config.loadPolicy?.maxLoadTimeMs,
        boundedDuration(config.timeout, 20_000),
      );
      const firstByteTime = Math.min(
        boundedDuration(config.loadPolicy?.maxTimeToFirstByteMs, maxLoadTime),
        maxLoadTime,
      );
      this.requestTimer = setTimeout(
        () => this.handleTimeout(serial),
        firstByteTime,
      );

      void fetcher(context.url, source, {
        method: "GET",
        headers,
        signal: controller.signal,
      }).then(async (response) => {
        if (!this.isCurrent(serial)) return;
        this.stats.loading.first = Math.max(performance.now(), attemptStart);
        this.responseHeaders = response.headers;
        this.clearRequestTimer();

        if (!response.ok) {
          const loaderResponse: LoaderResponse = {
            url: response.url || context.url,
            code: response.status,
          };
          this.handleError(
            serial,
            loaderResponse,
            response,
            { code: response.status, text: `HTTP ${response.status}` },
          );
          return;
        }

        const elapsed = this.stats.loading.first - attemptStart;
        const remainingLoadTime = Math.max(0, maxLoadTime - elapsed);
        if (!remainingLoadTime) {
          this.handleTimeout(serial);
          return;
        }
        this.requestTimer = setTimeout(
          () => this.handleTimeout(serial),
          remainingLoadTime,
        );

        const buffer = await readBoundedResponse(
          response,
          playbackResponseLimit(context.responseType),
          "The HLS response",
        );
        if (!this.isCurrent(serial)) return;
        this.clearRequestTimer();

        this.stats.loaded = buffer.byteLength;
        this.stats.total = declaredResponseLength(response) ?? buffer.byteLength;
        this.stats.chunkCount = buffer.byteLength ? 1 : 0;
        this.stats.loading.end = Math.max(performance.now(), this.stats.loading.first);
        const transferMs = Math.max(1, this.stats.loading.end - this.stats.loading.first);
        this.stats.bwEstimate = (this.stats.total * 8_000) / transferMs;

        let data: string | ArrayBuffer | object = buffer;
        if (context.responseType === "text" || context.responseType === "json") {
          const decoded = new TextDecoder().decode(buffer);
          if (context.responseType === "text") {
            data = decoded;
          } else {
            try {
              data = JSON.parse(decoded) as object;
            } catch {
              this.handleError(
                serial,
                { url: response.url || context.url, code: response.status },
                response,
                { code: response.status, text: "Invalid JSON response" },
              );
              return;
            }
          }
        }
        if (typeof data === "string" || data instanceof ArrayBuffer) {
          this.callbacks?.onProgress?.(this.stats, context, data, response);
        }
        this.finishRequest();
        this.callbacks?.onSuccess(
          { url: response.url || context.url, data, code: response.status },
          this.stats,
          context,
          response,
        );
      }).catch((error: unknown) => {
        if (!this.isCurrent(serial)) return;
        this.clearRequestTimer();
        if (controller.signal.aborted) return;
        const responseCode = error instanceof ResponseSizeLimitError ? 413 : 0;
        const safeReadFailure = error instanceof ResponseSizeLimitError
          || error instanceof ResponseBodyUnavailableError;
        this.handleError(
          serial,
          { url: context.url, code: responseCode },
          null,
          {
            code: responseCode,
            text: safeReadFailure
              ? error.message
              : "Network request failed",
          },
        );
      });
    }

    private handleTimeout(serial: number): void {
      if (!this.isCurrent(serial) || !this.context) return;
      this.stats.loading.end = performance.now();
      const retry = this.config?.loadPolicy?.timeoutRetry;
      if (this.canRetry(retry, "timeout")) {
        this.scheduleRetry(retry);
        return;
      }

      const context = this.context;
      const callbacks = this.callbacks;
      this.finishRequest();
      callbacks?.onTimeout(this.stats, context, null);
    }

    private handleError(
      serial: number,
      response: LoaderResponse,
      networkDetails: NullableNetworkDetails,
      error: { code: number; text: string },
    ): void {
      if (!this.isCurrent(serial) || !this.context) return;
      this.stats.loading.end = performance.now();
      const retry = this.config?.loadPolicy?.errorRetry;
      if (this.canRetry(retry, "error", response)) {
        this.scheduleRetry(retry);
        return;
      }

      const context = this.context;
      const callbacks = this.callbacks;
      this.finishRequest();
      callbacks?.onError(error, context, networkDetails, this.stats);
    }

    private canRetry(
      retryConfig: RetryConfig | null | undefined,
      kind: RetryKind,
      response?: LoaderResponse,
    ): retryConfig is RetryConfig {
      if (!retryConfig) return false;
      const retryCount = this.stats.retry;
      const code = response?.code;
      const defaultDecision =
        retryCount < retryConfig.maxNumRetry
        && (kind === "timeout" || code === 0 || code === undefined || code < 400 || code > 499);
      return retryConfig.shouldRetry
        ? retryConfig.shouldRetry(
          retryConfig,
          retryCount,
          kind === "timeout",
          response,
          defaultDecision,
        )
        : defaultDecision;
    }

    private scheduleRetry(retryConfig: RetryConfig): void {
      const retryCount = this.stats.retry;
      const factor = retryConfig.backoff === "linear" ? 1 : 2 ** retryCount;
      const delay = Math.min(
        boundedDuration(factor * retryConfig.retryDelayMs, 0),
        boundedDuration(retryConfig.maxRetryDelayMs, 0),
      );
      this.stats.retry += 1;
      this.invalidateRequest(false);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.finished) this.startRequest();
      }, delay);
    }

    private isCurrent(serial: number): boolean {
      return !this.finished && serial === this.requestSerial;
    }

    private finishRequest(): void {
      this.finished = true;
      this.invalidateRequest();
    }

    private invalidateRequest(clearRetry = true): void {
      this.requestSerial += 1;
      this.clearRequestTimer();
      if (clearRetry && this.retryTimer) clearTimeout(this.retryTimer);
      if (clearRetry) this.retryTimer = null;
      this.controller?.abort();
      this.controller = null;
    }

    private clearRequestTimer(): void {
      if (this.requestTimer) clearTimeout(this.requestTimer);
      this.requestTimer = null;
    }
  };
}

function boundedDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value || 0) >= 0 ? value || 0 : fallback;
}
