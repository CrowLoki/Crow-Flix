import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { classifySource } from "./logic";
import type { PlaybackKind, StreamSource } from "./types";

export type FetchImplementation = (
  input: URL | Request | string,
  init?: RequestInit & { maxRedirections?: number; connectTimeout?: number },
) => Promise<Response>;

export type MediaFetcher = (
  input: string,
  source: StreamSource,
  init?: RequestInit,
) => Promise<Response>;

export const DEFAULT_NATIVE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/131.0.0.0 Safari/537.36";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function withSourceHeaders(
  source: StreamSource,
  initialHeaders?: HeadersInit,
  includeRestricted = true,
): Headers {
  const headers = new Headers(initialHeaders);
  if (includeRestricted && !headers.has("User-Agent")) {
    headers.set("User-Agent", source.userAgent || DEFAULT_NATIVE_USER_AGENT);
  }
  if (includeRestricted && source.referrer && !headers.has("Referer")) {
    headers.set("Referer", source.referrer);
  }
  // The native plugin interprets an empty unsafe Origin header as "remove it".
  // This prevents providers from rejecting Tauri's synthetic webview origin.
  if (includeRestricted && !headers.has("Origin")) headers.set("Origin", "");
  return headers;
}

/**
 * Injectable at the transport boundary so unit tests never need a live Tauri
 * IPC runtime. Browser previews deliberately use the browser's native fetch.
 */
export function createMediaFetcher(
  nativeImplementation: FetchImplementation = tauriFetch,
  browserImplementation: typeof globalThis.fetch = globalThis.fetch,
  useNative: () => boolean = isTauriRuntime,
): MediaFetcher {
  return (input, source, init = {}) => {
    const native = useNative();
    const headers = withSourceHeaders(source, init.headers, native);
    if (native) {
      return nativeImplementation(input, {
        ...init,
        headers,
        connectTimeout: 10_000,
        maxRedirections: 8,
      });
    }
    return browserImplementation(input, { ...init, headers });
  };
}

export const mediaFetch = createMediaFetcher();

export type ProbeResult = {
  kind: PlaybackKind;
  url: string;
  mimeType: string;
};

export async function probeSource(
  source: StreamSource,
  fetcher: MediaFetcher = mediaFetch,
  parentSignal?: AbortSignal,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Probe timed out", "TimeoutError")), 8_000);

  try {
    const response = await fetcher(source.url, source, {
      method: "GET",
      headers: { Range: "bytes=0-4095", Accept: "*/*" },
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(`Probe returned HTTP ${response.status}`);
    }

    const bytes = await readPrefix(response, 8_192, controller.signal);
    const mimeType = response.headers.get("content-type") || "";
    const sample = new TextDecoder().decode(bytes);
    const finalSource = { ...source, url: response.url || source.url };
    return {
      kind: classifySource(finalSource, mimeType, sample),
      url: finalSource.url,
      mimeType,
    };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
    controller.abort();
  }
}

async function readPrefix(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array((await response.arrayBuffer()).slice(0, limit));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        const slice = value.subarray(0, Math.min(value.length, limit - length));
        chunks.push(slice);
        length += slice.length;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
