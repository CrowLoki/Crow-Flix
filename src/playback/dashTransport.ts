import type { MediaPlayerClass } from "dashjs";
import {
  declaredResponseLength,
  playbackResponseLimit,
  readBoundedResponse,
  ResponseSizeLimitError,
  safePlaybackReadError,
} from "./boundedResponse";
import { mediaFetch, type MediaFetcher } from "./nativeFetch";
import type { StreamSource } from "./types";

type DashRequest = {
  method: string;
  url: string;
  responseType?: XMLHttpRequestResponseType;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  timeout?: number;
  body?: BodyInit | null;
  customData?: {
    abort?: () => void;
    onabort?: () => void;
    onloadend?: () => void;
    onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void;
    ontimeout?: () => void;
  };
};

type DashResponse = {
  url?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  data?: unknown;
};

type DashXhrLoaderInstance = {
  load: (request: DashRequest, response: DashResponse) => boolean;
  abort: () => void;
  getXhr: () => null;
  reset: () => void;
  resetInitialSettings: () => void;
};

type DashLoaderFactory = (() => DashXhrLoaderInstance) & {
  __dashjs_factory_name?: string;
};

/**
 * dash.js 5.2.0 routes ordinary manifests, initialization data and media
 * segments through XHRLoader. Replacing that class keeps those requests in the
 * same native HTTP path as HLS, including per-source headers and redirects.
 *
 * Low-latency DASH's partial FetchLoader remains disabled through the player
 * settings in the controller because its streaming box contract is internal.
 */
export function installNativeDashTransport(
  player: MediaPlayerClass,
  source: StreamSource,
  fetcher: MediaFetcher = mediaFetch,
): void {
  const NativeXhrLoader: DashLoaderFactory = function NativeXhrLoader() {
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let activeRequest: DashRequest | null = null;

    const takeActiveRequest = (expected?: DashRequest) => {
      if (!activeRequest || (expected && activeRequest !== expected)) return null;
      const request = activeRequest;
      const requestController = controller;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      controller = null;
      activeRequest = null;
      return { request, controller: requestController };
    };

    const abort = () => {
      const active = takeActiveRequest();
      if (!active) return;
      active.controller?.abort();
      active.request.customData?.onabort?.();
    };

    return {
      load(request, target) {
        abort();
        activeRequest = request;
        controller = new AbortController();
        request.customData ||= {};
        request.customData.abort = abort;
        const headers = new Headers(request.headers);
        const timeoutMs = Math.max(1_000, request.timeout || 20_000);

        timeout = setTimeout(() => {
          const active = takeActiveRequest(request);
          if (!active) return;
          active.controller?.abort();
          request.customData?.ontimeout?.();
          request.customData?.onloadend?.();
        }, timeoutMs);

        void fetcher(request.url, source, {
          method: request.method || "GET",
          headers,
          credentials: request.credentials,
          body: request.body,
          signal: controller.signal,
        }).then(async (response) => {
          if (activeRequest !== request) return;
          const { data, byteLength } = await dashResponseData(response, request.responseType);
          const active = takeActiveRequest(request);
          if (!active) return;
          target.url = response.url || request.url;
          target.status = response.status;
          target.statusText = response.statusText;
          target.headers = Object.fromEntries(response.headers.entries());
          target.data = data;
          const loaded = byteLength;
          const total = declaredResponseLength(response) ?? loaded;
          request.customData?.onprogress?.({
            lengthComputable: total > 0,
            loaded,
            total,
          });
          request.customData?.onloadend?.();
        }).catch((error: unknown) => {
          const active = takeActiveRequest(request);
          if (!active) return;
          if (active.controller?.signal.aborted) return;
          active.controller?.abort();
          target.url = request.url;
          target.status = error instanceof ResponseSizeLimitError ? 413 : 0;
          target.statusText = safePlaybackReadError(error);
          target.data = null;
          request.customData?.onloadend?.();
        });
        return true;
      },
      abort,
      getXhr: () => null,
      reset: abort,
      resetInitialSettings: abort,
    };
  };
  NativeXhrLoader.__dashjs_factory_name = "XHRLoader";
  player.extend("XHRLoader", NativeXhrLoader as unknown as object, false);
}

async function dashResponseData(
  response: Response,
  responseType: XMLHttpRequestResponseType = "",
): Promise<{ data: unknown; byteLength: number }> {
  const buffer = await readBoundedResponse(
    response,
    playbackResponseLimit(responseType),
    "The DASH response",
  );
  const byteLength = buffer.byteLength;
  switch (responseType) {
    case "arraybuffer":
      return { data: buffer, byteLength };
    case "blob":
      return {
        data: new Blob([buffer], {
          type: response.headers.get("content-type") || "",
        }),
        byteLength,
      };
    case "json":
      return {
        data: JSON.parse(new TextDecoder().decode(buffer)) as unknown,
        byteLength,
      };
    case "document":
    case "text":
    case "":
      return { data: new TextDecoder().decode(buffer), byteLength };
    default:
      return { data: buffer, byteLength };
  }
}
