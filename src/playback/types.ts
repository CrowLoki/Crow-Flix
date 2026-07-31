export type TransportHint =
  | "hls"
  | "dash"
  | "direct"
  | "progressive"
  | "unknown"
  | "unsupported";

/**
 * The IPTV catalogue currently emits `id`/`transport`.  The alias fields keep
 * imported playlists and older cached catalogue responses forwards-compatible.
 */
export type StreamSource = {
  id?: string;
  sourceId?: string;
  title?: string | null;
  url: string;
  referrer?: string | null;
  userAgent?: string | null;
  quality?: string | null;
  label?: string | null;
  transport?: TransportHint | null;
  transportHint?: TransportHint | null;
  isHttps?: boolean;
  requiresHeaders?: boolean;
  preferenceScore?: number;
};

export type PlaybackKind =
  | "hls"
  | "dash"
  | "progressive"
  | "unknown"
  | "unsupported";

export type PlaybackFailureReason =
  | "network"
  | "media"
  | "startup-timeout"
  | "stall-timeout"
  | "unsupported"
  | "autoplay"
  | "aborted";

export type SourceHealth = {
  failures: number;
  cooldownUntil: number;
  lastSuccessAt?: number;
};

export type PlaybackStatus =
  | "idle"
  | "loading"
  | "switching"
  | "playing"
  | "interaction-required"
  | "failed";

export type PlaybackDiagnostic = {
  sourceId: string;
  sourceNumber: number;
  transport: PlaybackKind;
  endpoint: string;
  reason: PlaybackFailureReason;
  at: string;
};

export function sourceIdentifier(source: StreamSource, _index = 0): string {
  if (source.sourceId || source.id) return source.sourceId || source.id || "";
  const identity = `${source.url}\u0000${source.referrer || ""}\u0000${source.userAgent || ""}`;
  let hash = 0x811c9dc5;
  for (let character = 0; character < identity.length; character += 1) {
    hash ^= identity.charCodeAt(character);
    hash = Math.imul(hash, 0x01000193);
  }
  return `source-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function sourceTransportHint(source: StreamSource): TransportHint {
  return source.transportHint || source.transport || "unknown";
}
