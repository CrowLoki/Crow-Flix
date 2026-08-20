import type {
  HlsConfig,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  RetryConfig,
} from "hls.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PLAYBACK_METADATA_BYTES } from "./boundedResponse";
import { createTauriHlsLoader } from "./TauriHlsLoader";
import type { MediaFetcher } from "./nativeFetch";
import type { StreamSource } from "./types";

const source: StreamSource = {
  id: "hls-test",
  url: "https://origin.test/master.m3u8?origin-token=secret",
  referrer: "https://secret-referrer.test/watch",
  userAgent: "Secret Agent Value",
};

const context: LoaderContext = {
  url: source.url,
  responseType: "text",
  type: "manifest" as LoaderContext["type"],
};

const config: LoaderConfiguration = {
  loadPolicy: {
    maxTimeToFirstByteMs: 1_000,
    maxLoadTimeMs: 2_000,
    timeoutRetry: null,
    errorRetry: null,
  },
  maxRetry: 0,
  timeout: 2_000,
  retryDelay: 0,
  maxRetryDelay: 0,
};

function retryConfig(
  timeoutRetry: RetryConfig | null,
  errorRetry: RetryConfig | null,
  maxTimeToFirstByteMs = 50,
  maxLoadTimeMs = 500,
): LoaderConfiguration {
  return {
    ...config,
    timeout: maxLoadTimeMs,
    loadPolicy: {
      maxTimeToFirstByteMs,
      maxLoadTimeMs,
      timeoutRetry,
      errorRetry,
    },
  };
}

describe("Tauri HLS loader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the final redirected URL used to resolve relative playlists", async () => {
    const response = new Response("#EXTM3U\nsegment.ts", { status: 200 });
    Object.defineProperty(response, "url", {
      value: "https://cdn.test/path/final.m3u8?cdn-token=hidden",
    });
    const fetcher: MediaFetcher = vi.fn(async () => response);
    const Loader = createTauriHlsLoader(source, fetcher);
    const loader = new Loader({} as HlsConfig);

    const finalUrl = await new Promise<string>((resolve, reject) => {
      loader.load(context, config, {
        onSuccess: (result) => resolve(result.url),
        onError: (error) => reject(new Error(error.text)),
        onTimeout: () => reject(new Error("timed out")),
      });
    });

    expect(finalUrl).toBe("https://cdn.test/path/final.m3u8?cdn-token=hidden");
    loader.destroy();
  });

  it("parses JSON response contexts for content steering and interstitial metadata", async () => {
    const fetcher: MediaFetcher = vi.fn(async () => new Response(
      JSON.stringify({ VERSION: 1, "PATHWAY-PRIORITY": ["cdn-a"] }),
      { status: 200, headers: { Age: "42" } },
    ));
    const Loader = createTauriHlsLoader(source, fetcher);
    const loader = new Loader({} as HlsConfig);
    const jsonContext = { ...context, responseType: "json" };

    const data = await new Promise<object>((resolve, reject) => {
      loader.load(jsonContext, config, {
        onSuccess: (result) => resolve(result.data as object),
        onError: (error) => reject(new Error(error.text)),
        onTimeout: () => reject(new Error("timed out")),
      });
    });

    expect(data).toEqual({ VERSION: 1, "PATHWAY-PRIORITY": ["cdn-a"] });
    expect(loader.getCacheAge?.()).toBe(42);
    loader.destroy();
  });

  it("reports invalid JSON through the loader error callback", async () => {
    const fetcher: MediaFetcher = vi.fn(async () => new Response(
      "{not-json",
      { status: 200 },
    ));
    const Loader = createTauriHlsLoader(source, fetcher);
    const loader = new Loader({} as HlsConfig);
    const jsonContext = { ...context, responseType: "json" };

    const error = await new Promise<{ code: number; text: string }>((resolve, reject) => {
      loader.load(jsonContext, config, {
        onSuccess: () => reject(new Error("unexpected success")),
        onError: resolve,
        onTimeout: () => reject(new Error("timed out")),
      });
    });

    expect(error).toEqual({ code: 200, text: "Invalid JSON response" });
    loader.destroy();
  });

  it("rejects an oversized manifest from Content-Length without retrying it", async () => {
    const fetcher: MediaFetcher = vi.fn(async () => new Response("#EXTM3U", {
      status: 200,
      headers: {
        "content-length": String(MAX_PLAYBACK_METADATA_BYTES + 1),
      },
    }));
    const Loader = createTauriHlsLoader(source, fetcher);
    const loader = new Loader({} as HlsConfig);

    const error = await new Promise<{ code: number; text: string }>((resolve, reject) => {
      loader.load(context, config, {
        onSuccess: () => reject(new Error("unexpected success")),
        onError: resolve,
        onTimeout: () => reject(new Error("timed out")),
      });
    });

    expect(error).toEqual({
      code: 413,
      text: "The HLS response is larger than CrowFlix's 4 MiB safety limit.",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    loader.destroy();
  });

  it("returns null when the response does not provide an Age header", () => {
    const Loader = createTauriHlsLoader(source, vi.fn());
    const loader = new Loader({} as HlsConfig);

    expect(loader.getCacheAge?.()).toBeNull();
    loader.destroy();
  });

  it("reports HTTP status without leaking URL or source header values", async () => {
    const response = new Response("denied", { status: 403 });
    Object.defineProperty(response, "url", { value: source.url });
    const fetcher: MediaFetcher = vi.fn(async () => response);
    const Loader = createTauriHlsLoader(source, fetcher);
    const loader = new Loader({} as HlsConfig);

    const error = await new Promise<{ code: number; text: string }>((resolve, reject) => {
      const callbacks: LoaderCallbacks<LoaderContext> = {
        onSuccess: () => reject(new Error("unexpected success")),
        onError: (failure) => resolve(failure),
        onTimeout: () => reject(new Error("timed out")),
      };
      loader.load(context, config, callbacks);
    });

    expect(error).toEqual({ code: 403, text: "HTTP 403" });
    expect(JSON.stringify(error)).not.toContain("origin-token");
    expect(JSON.stringify(error)).not.toContain(source.userAgent);
    expect(JSON.stringify(error)).not.toContain(source.referrer);
    loader.destroy();
  });

  it("enforces maxTimeToFirstByteMs and aborts the stale native request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let requestSignal: AbortSignal | undefined;
    const fetcher: MediaFetcher = vi.fn((_url, _source, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const Loader = createTauriHlsLoader(source, fetcher);
    const loader = new Loader({} as HlsConfig);
    const onTimeout = vi.fn();
    const onError = vi.fn();
    loader.load(context, retryConfig(null, null), {
      onSuccess: vi.fn(),
      onError,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(true);
    loader.destroy();
  });

  it("retries a first-byte timeout after the configured backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attempt = 0;
    const callTimes: number[] = [];
    const fetcher: MediaFetcher = vi.fn((_url, _source, init) => {
      attempt += 1;
      callTimes.push(Date.now());
      if (attempt === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(new Response("#EXTM3U", { status: 200 }));
    });
    const Loader = createTauriHlsLoader(source, fetcher);
    const loader = new Loader({} as HlsConfig);
    const onSuccess = vi.fn();
    loader.load(
      context,
      retryConfig(
        { maxNumRetry: 1, retryDelayMs: 20, maxRetryDelayMs: 20 },
        null,
        10,
      ),
      {
        onSuccess,
        onError: vi.fn(),
        onTimeout: vi.fn(),
      },
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(19);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(callTimes).toEqual([0, 30]);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(loader.stats.retry).toBe(1);
    loader.destroy();
  });

  it("applies capped exponential errorRetry backoff to retryable HTTP errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const callTimes: number[] = [];
    const fetcher: MediaFetcher = vi.fn(async () => {
      callTimes.push(Date.now());
      return callTimes.length < 3
        ? new Response("temporarily unavailable", { status: 503 })
        : new Response("#EXTM3U", { status: 200 });
    });
    const Loader = createTauriHlsLoader(source, fetcher);
    const loader = new Loader({} as HlsConfig);
    const onSuccess = vi.fn();
    loader.load(
      context,
      retryConfig(
        null,
        {
          maxNumRetry: 2,
          retryDelayMs: 10,
          maxRetryDelayMs: 15,
          backoff: "exponential",
        },
      ),
      {
        onSuccess,
        onError: vi.fn(),
        onTimeout: vi.fn(),
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15);
    await Promise.resolve();
    await Promise.resolve();

    expect(callTimes).toEqual([0, 10, 25]);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(loader.stats.retry).toBe(2);
    loader.destroy();
  });

  it("ignores a late response after manual abort", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetcher: MediaFetcher = vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    const Loader = createTauriHlsLoader(source, fetcher);
    const loader = new Loader({} as HlsConfig);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onTimeout = vi.fn();
    const onAbort = vi.fn();
    loader.load(context, config, { onSuccess, onError, onTimeout, onAbort });

    loader.abort();
    resolveRequest?.(new Response("#EXTM3U", { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(onAbort).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    loader.destroy();
  });
});
