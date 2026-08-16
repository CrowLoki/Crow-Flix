import { RelayError } from "./errors";
import { loadAutoEpg } from "./epg";
import { rewriteM3u8 } from "./m3u8";
import { concatChunks, readBounded } from "./streams";
import { fetchValidated, validateExternalUrl } from "./urls";

const SERVICE_VERSION = "0.1.0";

/** /fetch response cap (spec: 32 MiB, streamed-bounded). */
const FETCH_MAX_BYTES = 32 * 1024 * 1024;
/** HLS playlist cap; media segments stream through unbounded. */
const PLAYLIST_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_UA_LENGTH = 512;
const MAX_REFERER_LENGTH = 2_048;

const RELAY_UA = "crowflix-relay/0.1.0";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function json(payload: unknown, status = 200, cacheControl = "no-store"): Response {
  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", cacheControl);
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof RelayError) {
    return json({ error: error.message }, error.status);
  }
  // Deliberately do not log here: upstream URLs may carry query credentials.
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "The relay failed unexpectedly.";
  return json({ error: message }, 502);
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) {
    throw new RelayError(400, `Provide the ${name} parameter.`);
  }
  return value;
}

function sanitizeHeaderParam(
  url: URL,
  name: string,
  maxLength: number,
): string | null {
  const value = url.searchParams.get(name);
  if (value === null) return null;
  if (value.length === 0 || value.length > maxLength) {
    throw new RelayError(400, `The ${name} parameter is not usable.`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new RelayError(400, `The ${name} parameter is not usable.`);
    }
  }
  return value;
}

function handleHealth(): Response {
  return json({ ok: true, service: "crowflix-relay", version: SERVICE_VERSION });
}

async function handleEpg(url: URL): Promise<Response> {
  const country = url.searchParams.get("country") ?? "";
  const idsParam = url.searchParams.get("ids") ?? "";
  const result = await loadAutoEpg(country, idsParam.split(","));
  // Guide files update roughly hourly; a short cache saves Worker CPU.
  return json(result, 200, "public, max-age=300");
}

async function handleFetch(url: URL): Promise<Response> {
  const target = validateExternalUrl(requiredParam(url, "url"));
  const response = await fetchValidated(target, {
    headers: { Accept: "*/*", "User-Agent": RELAY_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new RelayError(
      502,
      `The upstream server responded ${response.status}.`,
    );
  }
  const { data, truncated } = await readBounded(response.body, FETCH_MAX_BYTES);
  if (truncated) {
    throw new RelayError(
      502,
      "That response exceeded the 32 MiB relay limit.",
    );
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set(
    "Content-Type",
    response.headers.get("content-type") ?? "text/plain; charset=utf-8",
  );
  return new Response(data, { status: 200, headers });
}

function isPlaylistTarget(url: URL, contentType: string): boolean {
  if (contentType.toLowerCase().includes("mpegurl")) return true;
  const path = url.pathname.toLowerCase();
  return path.endsWith(".m3u8") || path.endsWith(".m3u");
}

function startsWithExtm3u(bytes: Uint8Array): boolean {
  let offset = 0;
  // Skip a UTF-8 byte-order mark (EF BB BF) if present.
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    offset = 3;
  }
  const marker = "#EXTM3U";
  if (bytes.byteLength - offset < marker.length) return false;
  for (let i = 0; i < marker.length; i++) {
    if (bytes[offset + i] !== marker.charCodeAt(i)) return false;
  }
  return true;
}

function buildStreamRelayUrl(
  origin: string,
  absolute: string,
  ua: string | null,
  referer: string | null,
): string {
  const relay = new URL("/stream", origin);
  relay.searchParams.set("url", absolute);
  if (ua !== null) relay.searchParams.set("ua", ua);
  if (referer !== null) relay.searchParams.set("referer", referer);
  return relay.toString();
}

function playlistResponse(
  body: string,
  target: URL,
  upstreamContentType: string,
  origin: string,
  ua: string | null,
  referer: string | null,
): Response {
  const rewritten = rewriteM3u8(body, target.href, (absolute) =>
    buildStreamRelayUrl(origin, absolute, ua, referer),
  );
  const headers = new Headers(CORS_HEADERS);
  headers.set(
    "Content-Type",
    upstreamContentType || "application/vnd.apple.mpegurl",
  );
  headers.set("Cache-Control", "no-store");
  return new Response(rewritten, { status: 200, headers });
}

async function handleStream(requestUrl: URL): Promise<Response> {
  const target = validateExternalUrl(requiredParam(requestUrl, "url"));
  const ua = sanitizeHeaderParam(requestUrl, "ua", MAX_UA_LENGTH);
  const referer = sanitizeHeaderParam(requestUrl, "referer", MAX_REFERER_LENGTH);

  const upstreamHeaders = new Headers();
  if (ua !== null) upstreamHeaders.set("User-Agent", ua);
  if (referer !== null) upstreamHeaders.set("Referer", referer);

  // No timeout here: live IPTV streams are long-lived by nature.
  const upstream = await fetchValidated(target, { headers: upstreamHeaders });
  if (!upstream.ok) {
    throw new RelayError(
      502,
      `The stream server responded ${upstream.status}.`,
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const origin = requestUrl.origin;

  if (!upstream.body) {
    const headers = new Headers(CORS_HEADERS);
    if (contentType) headers.set("Content-Type", contentType);
    return new Response(null, { status: 200, headers });
  }

  // Fast path: the content type or file extension already says "playlist".
  if (isPlaylistTarget(target, contentType)) {
    const { data, truncated } = await readBounded(
      upstream.body,
      PLAYLIST_MAX_BYTES,
    );
    if (truncated) {
      throw new RelayError(
        502,
        "That playlist exceeded the 4 MiB relay limit.",
      );
    }
    return playlistResponse(
      new TextDecoder().decode(data),
      target,
      contentType,
      origin,
      ua,
      referer,
    );
  }

  // Sniffing path: tee the body so a mislabeled playlist (no extension,
  // generic content type) still gets rewritten, while real media segments
  // pass through untouched at full speed.
  const [probe, passthrough] = upstream.body.tee();
  const probeReader = probe.getReader();
  let first = new Uint8Array(0);
  let probeExhausted = false;
  while (first.byteLength < 8) {
    const { done, value } = await probeReader.read();
    if (done) {
      probeExhausted = true;
      break;
    }
    first = concatChunks([first, value], first.byteLength + value.byteLength);
  }

  if (startsWithExtm3u(first)) {
    // Playlist after all: finish reading the probe branch within the cap.
    const chunks = [first];
    let total = first.byteLength;
    let truncated = false;
    if (!probeExhausted) {
      for (;;) {
        const { done, value } = await probeReader.read();
        if (done) break;
        if (total + value.byteLength > PLAYLIST_MAX_BYTES) {
          truncated = true;
          await probeReader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }
    probeReader.releaseLock();
    if (truncated) {
      throw new RelayError(
        502,
        "That playlist exceeded the 4 MiB relay limit.",
      );
    }
    return playlistResponse(
      new TextDecoder().decode(concatChunks(chunks, total)),
      target,
      contentType,
      origin,
      ua,
      referer,
    );
  }

  // Genuine media segment (or any other binary): abandon the probe branch
  // and stream the untouched passthrough branch back.
  await probeReader.cancel().catch(() => undefined);
  probeReader.releaseLock();
  const headers = new Headers(CORS_HEADERS);
  if (contentType) headers.set("Content-Type", contentType);
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  return new Response(passthrough, { status: 200, headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return json({ error: "Only GET requests are supported." }, 405);
    }
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/health":
          return handleHealth();
        case "/epg":
          return await handleEpg(url);
        case "/fetch":
          return await handleFetch(url);
        case "/stream":
          return await handleStream(url);
        default:
          return json({ error: "Unknown relay route." }, 404);
      }
    } catch (error) {
      return errorResponse(error);
    }
  },
};
