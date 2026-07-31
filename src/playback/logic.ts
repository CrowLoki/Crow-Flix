import {
  type PlaybackFailureReason,
  type PlaybackKind,
  type SourceHealth,
  type StreamSource,
  sourceIdentifier,
  sourceTransportHint,
} from "./types";

const UNSUPPORTED_SCHEMES = new Set([
  "acestream:",
  "mms:",
  "mmsh:",
  "rtmp:",
  "rtmpe:",
  "rtsp:",
  "sop:",
  "udp:",
]);

const HLS_MIME_TYPES = new Set([
  "application/mpegurl",
  "application/vnd.apple.mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);

const DASH_MIME_TYPES = new Set(["application/dash+xml"]);

const PROGRESSIVE_MIME_PREFIXES = ["audio/", "video/"];

export function classifySource(
  source: StreamSource,
  mimeType = "",
  sample = "",
): PlaybackKind {
  const hint = sourceTransportHint(source);
  if (hint === "hls" || hint === "dash" || hint === "unsupported") return hint;
  if (hint === "direct" || hint === "progressive") return "progressive";

  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    return "unsupported";
  }
  if (UNSUPPORTED_SCHEMES.has(parsed.protocol)) return "unsupported";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "unsupported";

  const pathname = parsed.pathname.toLowerCase();
  if (pathname.endsWith(".m3u8") || pathname.endsWith(".m3u")) return "hls";
  if (pathname.endsWith(".mpd")) return "dash";
  if (/\.(?:aac|flac|m4a|m4v|mp3|mp4|mpeg|mpg|oga|ogg|ogv|opus|ts|webm)$/i.test(pathname)) {
    return "progressive";
  }

  const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (HLS_MIME_TYPES.has(mime)) return "hls";
  if (DASH_MIME_TYPES.has(mime)) return "dash";
  if (PROGRESSIVE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
    return "progressive";
  }

  const trimmed = sample.replace(/^\uFEFF/, "").trimStart();
  if (/^#EXTM3U\b/i.test(trimmed)) return "hls";
  if (/<MPD(?:\s|>)/i.test(trimmed.slice(0, 8_192))) return "dash";
  return "unknown";
}

function transportRank(source: StreamSource): number {
  switch (classifySource(source)) {
    case "hls": return 0;
    case "dash": return 1;
    case "progressive": return 2;
    case "unknown": return 3;
    case "unsupported": return 4;
  }
}

function availabilityRank(source: StreamSource): number {
  const label = source.label?.trim() || "";
  if (!label) return 0;

  // A negated label still contains "geo blocked", so recognise it before the
  // genuine geo-blocked case. Other labels are ordinary availability hints.
  const nonGeoBlocked = /\b(?:non|not)[\s-]+geo[\s-]*blocked\b/i.test(label);
  const geoBlocked = /\bgeo[\s-]*blocked\b/i.test(label);
  if (geoBlocked && !nonGeoBlocked) return 2;
  if (/\bnot\s+(?:24\s*(?:\/|x|×)\s*7|always\s+on)\b/i.test(label)) return 1;
  return 0;
}

export function orderPlaybackSources(
  sources: StreamSource[],
  health: Record<string, SourceHealth> = {},
  preferredSourceId?: string,
  now = Date.now(),
): StreamSource[] {
  return sources
    .map((source, index) => ({ source, index, id: sourceIdentifier(source, index) }))
    .sort((a, b) => {
      const aUnsupported = classifySource(a.source) === "unsupported" ? 1 : 0;
      const bUnsupported = classifySource(b.source) === "unsupported" ? 1 : 0;
      if (aUnsupported !== bUnsupported) return aUnsupported - bUnsupported;

      const aHealth = health[a.id];
      const bHealth = health[b.id];
      const aCooling = (aHealth?.cooldownUntil || 0) > now ? 1 : 0;
      const bCooling = (bHealth?.cooldownUntil || 0) > now ? 1 : 0;
      if (aCooling !== bCooling) return aCooling - bCooling;

      const availabilityDifference =
        availabilityRank(a.source) - availabilityRank(b.source);
      if (availabilityDifference) return availabilityDifference;

      const aPreferred = a.id === preferredSourceId ? 0 : 1;
      const bPreferred = b.id === preferredSourceId ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;

      const aSucceeded = aHealth?.lastSuccessAt ? 0 : 1;
      const bSucceeded = bHealth?.lastSuccessAt ? 0 : 1;
      if (aSucceeded !== bSucceeded) return aSucceeded - bSucceeded;
      if ((aHealth?.lastSuccessAt || 0) !== (bHealth?.lastSuccessAt || 0)) {
        return (bHealth?.lastSuccessAt || 0) - (aHealth?.lastSuccessAt || 0);
      }

      const explicitPreference =
        (b.source.preferenceScore || 0) - (a.source.preferenceScore || 0);
      if (explicitPreference) return explicitPreference;

      const httpsDifference =
        Number(!a.source.url.toLowerCase().startsWith("https://"))
        - Number(!b.source.url.toLowerCase().startsWith("https://"));
      if (httpsDifference) return httpsDifference;

      const kindDifference = transportRank(a.source) - transportRank(b.source);
      return kindDifference || a.index - b.index;
    })
    .map(({ source }) => source);
}

export function shouldFallback(reason: PlaybackFailureReason): boolean {
  return reason !== "autoplay" && reason !== "aborted";
}

export function sanitizeStreamUrl(value: string): string {
  try {
    const url = new URL(value);
    const defaultPort =
      (url.protocol === "https:" && url.port === "443")
      || (url.protocol === "http:" && url.port === "80");
    const port = url.port && !defaultPort ? `:${url.port}` : "";
    return `${url.protocol}//${url.hostname}${port}${url.pathname === "/" ? "/" : "/…"}`;
  } catch {
    return "invalid-url";
  }
}

export function migrateStoredChannelKeys(
  keys: string[],
  availableKeys: Iterable<string>,
): string[] {
  const available = new Set(availableKeys);
  const migrated = keys
    .map((key) => {
      if (available.has(key)) return key;
      const legacyBase = key.replace(/#\d+$/, "");
      return available.has(legacyBase) ? legacyBase : key;
    })
    .filter((key, index, all) => all.indexOf(key) === index);
  return migrated;
}
