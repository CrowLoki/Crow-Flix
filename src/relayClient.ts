// Client for the CrowFlix relay (Cloudflare Worker). The relay supplies what
// browsers cannot do directly: server-side EPG guide retrieval, and streams
// whose providers require User-Agent/Referer headers.
//
// The relay never bypasses provider geographic or account restrictions.

import type { StreamSource } from "./playback/types";

export const RELAY_BASE = "https://crowflix-relay.djdarren2056.workers.dev";

export type RelayProgramme = {
  channelId: string;
  title: string;
  description?: string | null;
  category?: string | null;
  start: string;
  stop: string;
};

export type RelayGuideResult = {
  programmes: RelayProgramme[];
  source: string;
  matchedChannels: number;
  updatedAt: string;
};

const REQUEST_TIMEOUT_MS = 90_000;

export async function loadRelayGuide(
  country: string,
  channelIds: string[],
): Promise<RelayGuideResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const query = new URLSearchParams({ country, ids: channelIds.join(",") });
    const response = await fetch(`${RELAY_BASE}/epg?${query}`, { signal: controller.signal });
    const body = await response.json() as RelayGuideResult & { error?: string };
    if (!response.ok || body.error) {
      throw new Error(body.error || `Relay returned HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Route a header-locked source through the relay. Returns null when the
 * source cannot be relayed (no usable URL).
 */
export function relayStreamUrl(source: StreamSource): string | null {
  if (!source.url || !/^https?:\/\//i.test(source.url)) return null;
  const query = new URLSearchParams({ url: source.url });
  if (source.userAgent) query.set("ua", source.userAgent);
  if (source.referrer) query.set("referer", source.referrer);
  return `${RELAY_BASE}/stream?${query}`;
}

/** Wrap a source for web playback via the relay when it needs headers. */
export function toWebPlayableSource(source: StreamSource): StreamSource {
  if (!source.requiresHeaders) return source;
  const url = relayStreamUrl(source);
  if (!url) return source;
  return {
    ...source,
    url,
    referrer: null,
    userAgent: null,
    requiresHeaders: false,
    // The relay path ends in /stream, so keep the original transport hint.
    transport: source.transport ?? null,
  };
}

/** Bounded fetch of a user-supplied playlist/guide URL through the relay. */
export async function relayFetchText(url: string): Promise<string> {
  const query = new URLSearchParams({ url });
  const response = await fetch(`${RELAY_BASE}/fetch?${query}`);
  if (!response.ok) {
    let message = `Relay returned HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) message = body.error;
    } catch { /* keep the status message */ }
    throw new Error(message);
  }
  return response.text();
}
