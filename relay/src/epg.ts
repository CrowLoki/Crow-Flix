import { RelayError } from "./errors";
import { readBounded } from "./streams";
import { fetchValidated, validateExternalUrl } from "./urls";
import type { FetchLike } from "./urls";
import { XmltvStreamParser } from "./xmltv";
import type { RelayProgramme } from "./xmltv";

export const GUIDES_URL = "https://iptv-org.github.io/api/guides.json";
export const GUIDES_MAX_BYTES = 16 * 1024 * 1024;
/** Decompressed XMLTV budget per source — Worker memory stays bounded. */
export const XMLTV_MAX_DECOMPRESSED_BYTES = 24 * 1024 * 1024;
/** How many ranked guide sources to try before falling back. */
export const MAX_EPG_SOURCES = 3;
export const MAX_CHANNEL_IDS = 2_000;
export const MAX_CHANNEL_ID_LENGTH = 200;
export const UPSTREAM_TIMEOUT_MS = 25_000;

const RELAY_UA = "crowflix-relay/0.1.0";

/** Wire shape mirrors the app's camelCase GuideResult. */
export interface GuideResult {
  programmes: RelayProgramme[];
  source: string;
  matchedChannels: number;
  updatedAt: string;
}

export interface GuideSourceEntry {
  url: string;
}

export interface GuideEntry {
  channel?: string;
  sources: GuideSourceEntry[];
}

/** Defensive shape check of the iptv-org guides index. */
export function parseGuidesJson(text: string): GuideEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const guides: GuideEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const channel =
      typeof record.channel === "string" ? record.channel : undefined;
    const rawSources = Array.isArray(record.sources) ? record.sources : [];
    const sources: GuideSourceEntry[] = [];
    for (const source of rawSources) {
      if (typeof source === "object" && source !== null) {
        const url = (source as Record<string, unknown>).url;
        if (typeof url === "string" && url.length > 0) sources.push({ url });
      }
    }
    guides.push({ channel, sources });
  }
  return guides;
}

/**
 * Mirror of the source_coverage ranking in load_auto_epg
 * (src-tauri/src/lib.rs lines 2180-2212): score each guide source URL by how
 * many of the requested channel ids it covers, sorted descending.
 */
export function rankGuideSources(
  guides: GuideEntry[],
  wantedIds: Iterable<string>,
): string[] {
  const wanted = new Set(wantedIds);
  const coverage = new Map<string, Set<string>>();
  for (const guide of guides) {
    const channel = guide.channel;
    if (channel === undefined || !wanted.has(channel)) continue;
    for (const source of guide.sources) {
      let set = coverage.get(source.url);
      if (!set) {
        set = new Set();
        coverage.set(source.url, set);
      }
      set.add(channel);
    }
  }
  return [...coverage.entries()]
    .map(([url, channels]) => ({ url, count: channels.size }))
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.url);
}

export function normalizeChannelIds(raw: string[]): string[] {
  const ids = raw.map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new RelayError(400, "Provide at least one channel id.");
  }
  if (ids.length > MAX_CHANNEL_IDS) {
    throw new RelayError(
      400,
      `That guide request contains more than ${MAX_CHANNEL_IDS} channel identifiers.`,
    );
  }
  for (const id of ids) {
    if (id.length > MAX_CHANNEL_ID_LENGTH) {
      throw new RelayError(400, "A channel id in that request is too long.");
    }
    for (let i = 0; i < id.length; i++) {
      const code = id.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) {
        throw new RelayError(
          400,
          "Channel ids must not contain control characters.",
        );
      }
    }
  }
  return [...new Set(ids)];
}

/** Normalise a country code for the ripper filename; GB maps to UK. */
export function normalizeCountryCode(country: string): string {
  const code = country.trim().toUpperCase();
  if (code === "") return "";
  if (!/^[A-Z0-9]{2,8}$/.test(code)) {
    throw new RelayError(400, "Provide a valid country code.");
  }
  return code === "GB" ? "UK" : code;
}

/**
 * Feed a (possibly gzipped) XMLTV body into the parser, bounding the
 * decompressed byte count. Detects gzip by magic bytes (0x1f 0x8b), which
 * covers .gz files served without a Content-Encoding header; when upstream
 * sets Content-Encoding: gzip the runtime has already decompressed for us.
 */
export async function streamXmltvBody(
  body: ReadableStream<Uint8Array>,
  parser: XmltvStreamParser,
  maxDecompressedBytes = XMLTV_MAX_DECOMPRESSED_BYTES,
): Promise<{ truncated: boolean }> {
  const probe = body.getReader();

  // Accumulate at least 2 bytes so the gzip magic check is reliable.
  let first = new Uint8Array(0);
  for (;;) {
    const { done, value } = await probe.read();
    if (done) break;
    const merged = new Uint8Array(first.byteLength + value.byteLength);
    merged.set(first);
    merged.set(value, first.byteLength);
    first = merged;
    if (first.byteLength >= 2) break;
  }
  if (first.byteLength === 0) {
    probe.releaseLock();
    return { truncated: false };
  }

  const reassembled = prependChunk(first, probe);
  const isGzip = first[0] === 0x1f && first[1] === 0x8b;
  const stream = isGzip
    ? reassembled.pipeThrough(new DecompressionStream("gzip"))
    : reassembled;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxDecompressedBytes) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      parser.push(decoder.decode(value, { stream: true }));
      if (parser.truncated) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  parser.push(decoder.decode());
  return { truncated: truncated || parser.truncated };
}

function prependChunk(
  first: Uint8Array,
  rest: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(first);
      try {
        for (;;) {
          const { done, value } = await rest.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        rest.releaseLock();
      }
    },
    async cancel(reason) {
      await rest.cancel(reason).catch(() => undefined);
      rest.releaseLock();
    },
  });
}

async function fetchGuides(fetcher: FetchLike): Promise<GuideEntry[]> {
  const response = await fetchValidated(
    new URL(GUIDES_URL),
    {
      headers: { Accept: "application/json", "User-Agent": RELAY_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
    fetcher,
  );
  if (!response.ok || !response.body) {
    throw new RelayError(
      502,
      `The guides index responded ${response.status}.`,
    );
  }
  const { data, truncated } = await readBounded(response.body, GUIDES_MAX_BYTES);
  if (truncated) {
    throw new RelayError(502, "The guides index exceeded the relay size limit.");
  }
  return parseGuidesJson(new TextDecoder().decode(data));
}

async function fetchSourceProgrammes(
  sourceUrl: string,
  channelIds: string[],
  fetcher: FetchLike,
): Promise<RelayProgramme[]> {
  const target = validateExternalUrl(sourceUrl);
  const response = await fetchValidated(
    target,
    {
      headers: {
        Accept: "application/xml, text/xml, */*",
        "User-Agent": RELAY_UA,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
    fetcher,
  );
  if (!response.ok || !response.body) {
    throw new RelayError(502, `The guide source responded ${response.status}.`);
  }
  const parser = new XmltvStreamParser(channelIds);
  await streamXmltvBody(response.body, parser);
  return parser.end();
}

/**
 * Mirror of load_auto_epg in src-tauri/src/lib.rs (lines 2180-2237):
 * rank iptv-org guide sources by requested-id coverage, try the best few,
 * then fall back to the regional epgshare01 ripper files.
 */
export async function loadAutoEpg(
  country: string,
  channelIds: string[],
  fetcher: FetchLike = fetch,
): Promise<GuideResult> {
  const ids = normalizeChannelIds(channelIds);
  const code = normalizeCountryCode(country);

  try {
    const guides = await fetchGuides(fetcher);
    const ranked = rankGuideSources(guides, ids);
    for (const source of ranked.slice(0, MAX_EPG_SOURCES)) {
      try {
        const programmes = await fetchSourceProgrammes(source, ids, fetcher);
        if (programmes.length > 0) {
          return guideResult(programmes, `IPTV-org EPG · ${source}`);
        }
      } catch {
        // Try the next ranked source.
      }
    }
  } catch {
    // guides.json unavailable — fall through to the regional ripper.
  }

  if (code.length > 0) {
    const filename = `epg_ripper_${code}1.xml.gz`;
    for (const source of [
      `https://epgshare01.online/epgshare01/${filename}`,
      `https://raw.githubusercontent.com/epgshare01/share01/master/${filename}`,
    ]) {
      try {
        const programmes = await fetchSourceProgrammes(source, ids, fetcher);
        if (programmes.length > 0) {
          return guideResult(programmes, `Automatic regional guide · ${code}`);
        }
      } catch {
        // Try the next ripper mirror.
      }
    }
  }

  throw new RelayError(
    502,
    `No current programme listings matched the ${code || "requested"} channels.`,
  );
}

/** Mirror of guide_result() in lib.rs. */
export function guideResult(
  programmes: RelayProgramme[],
  source: string,
): GuideResult {
  return {
    programmes,
    source,
    matchedChannels: new Set(programmes.map((p) => p.channelId)).size,
    updatedAt: new Date().toISOString(),
  };
}
