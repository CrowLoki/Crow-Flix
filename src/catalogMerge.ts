import type { StreamSource } from "./playback/types";

export type MergeableChannel = {
  key: string;
  sources?: StreamSource[];
  url?: string;
  referrer?: string | null;
  userAgent?: string | null;
  quality?: string | null;
  label?: string | null;
};

function channelSources(channel: MergeableChannel): StreamSource[] {
  if (channel.sources?.length) return channel.sources;
  if (!channel.url) return [];
  return [{
    url: channel.url,
    referrer: channel.referrer,
    userAgent: channel.userAgent,
    quality: channel.quality,
    label: channel.label,
    requiresHeaders: Boolean(channel.referrer || channel.userAgent),
  }];
}

function sourceIdentity(source: StreamSource): string {
  return `${source.url}\u0000${source.referrer || ""}\u0000${source.userAgent || ""}`;
}

function deduplicateSources(sources: StreamSource[]): StreamSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const identity = sourceIdentity(source);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Keeps one card per logical channel while treating matching imported channels
 * as alternate playback sources. Existing catalogue metadata remains canonical.
 */
export function mergeChannelsByKey<T extends MergeableChannel>(
  existing: readonly T[],
  imported: readonly T[],
): T[] {
  const merged: T[] = [];
  const positions = new Map<string, number>();

  for (const channel of [...existing, ...imported]) {
    const position = positions.get(channel.key);
    if (position === undefined) {
      positions.set(channel.key, merged.length);
      merged.push(channel);
      continue;
    }

    const current = merged[position];
    merged[position] = {
      ...current,
      sources: deduplicateSources([
        ...channelSources(current),
        ...channelSources(channel),
      ]),
    };
  }

  return merged;
}
