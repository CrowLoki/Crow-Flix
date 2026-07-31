export type BroadcastAreaChannel = {
  broadcastArea?: readonly string[] | null;
  country?: string | null;
};

export type BroadcastRegion = {
  code: string;
  countries: readonly string[];
};

type ParsedArea =
  | { kind: "country"; code: string }
  | { kind: "region"; code: string }
  | { kind: "unknown" };

export function canonicalCountryCode(code?: string | null): string {
  const normalized = code?.trim().toUpperCase() || "";
  return normalized === "GB" ? "UK" : normalized;
}

function canonicalRegionCode(code?: string | null): string {
  return code?.trim().toUpperCase() || "";
}

function parseBroadcastArea(area: string): ParsedArea {
  const separator = area.indexOf("/");
  if (separator < 1) return { kind: "unknown" };

  const kind = area.slice(0, separator).trim().toLowerCase();
  const value = area.slice(separator + 1).trim().toUpperCase();
  if (!value) return { kind: "unknown" };

  if (kind === "c") {
    const code = canonicalCountryCode(value);
    return code ? { kind: "country", code } : { kind: "unknown" };
  }

  if (kind === "s") {
    const dash = value.indexOf("-");
    if (dash < 1) return { kind: "unknown" };
    const code = canonicalCountryCode(value.slice(0, dash));
    return code ? { kind: "country", code } : { kind: "unknown" };
  }

  if (kind === "ct") {
    if (value.length < 3) return { kind: "unknown" };
    const code = canonicalCountryCode(value.slice(0, 2));
    return code ? { kind: "country", code } : { kind: "unknown" };
  }

  if (kind === "r") {
    const code = canonicalRegionCode(value);
    return code ? { kind: "region", code } : { kind: "unknown" };
  }

  return { kind: "unknown" };
}

function normalizedAreas(channel: BroadcastAreaChannel): string[] {
  return (channel.broadcastArea || [])
    .map((area) => area.trim())
    .filter(Boolean);
}

function findRegion(
  regions: readonly BroadcastRegion[],
  code: string,
): BroadcastRegion | undefined {
  const target = canonicalRegionCode(code);
  return regions.find(
    (region) => canonicalRegionCode(region.code) === target,
  );
}

function regionContainsCountry(
  region: BroadcastRegion,
  countryCode: string,
): boolean {
  const target = canonicalCountryCode(countryCode);
  return region.countries.some(
    (code) => canonicalCountryCode(code) === target,
  );
}

/**
 * Matches the countries in which a feed is broadcast. A channel's origin
 * country is only a fallback for imported playlists without broadcast-area
 * metadata.
 */
export function channelMatchesCountry(
  channel: BroadcastAreaChannel,
  countryCode: string,
  regions: readonly BroadcastRegion[],
): boolean {
  const target = canonicalCountryCode(countryCode);
  if (!target) return false;

  const areas = normalizedAreas(channel);
  if (!areas.length) {
    return canonicalCountryCode(channel.country) === target;
  }

  return areas.some((area) => {
    const parsed = parseBroadcastArea(area);
    if (parsed.kind === "country") return parsed.code === target;
    if (parsed.kind === "region") {
      const broadcastRegion = findRegion(regions, parsed.code);
      return Boolean(
        broadcastRegion && regionContainsCountry(broadcastRegion, target),
      );
    }
    return false;
  });
}

/**
 * Matches a feed to one selected catalogue region. Unknown non-empty area
 * values deliberately do not become worldwide matches.
 */
export function channelMatchesRegion(
  channel: BroadcastAreaChannel,
  regionCode: string,
  regions: readonly BroadcastRegion[],
): boolean {
  const selectedRegion = findRegion(regions, regionCode);
  if (!selectedRegion) return false;

  const areas = normalizedAreas(channel);
  if (!areas.length) {
    const fallbackCountry = canonicalCountryCode(channel.country);
    return Boolean(
      fallbackCountry
      && regionContainsCountry(selectedRegion, fallbackCountry),
    );
  }

  return areas.some((area) => {
    const parsed = parseBroadcastArea(area);
    if (parsed.kind === "country") {
      return regionContainsCountry(selectedRegion, parsed.code);
    }
    if (parsed.kind === "region") {
      if (parsed.code === canonicalRegionCode(selectedRegion.code)) return true;
      const broadcastRegion = findRegion(regions, parsed.code);
      return Boolean(
        broadcastRegion
        && broadcastRegion.countries.some(
          (code) => regionContainsCountry(selectedRegion, code),
        ),
      );
    }
    return false;
  });
}
