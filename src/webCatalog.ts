// CrowFlix web catalogue: a faithful TypeScript port of the Rust
// `build_catalog` pipeline (src-tauri/src/lib.rs) so the browser build loads
// the same authoritative IPTV-org catalogue the desktop app uses.
//
// Differences from the desktop pipeline, by design:
// - No Apsattv FAST-playlist overlays or known-dead Amagi repair yet; those
//   move to the Cloudflare relay so the browser never inherits provider rules.
// - Caching uses the Cache API (12 h read-through, stale-on-failure) instead
//   of the Tauri app-data cache file.

import type { StreamSource, TransportHint } from "./playback/types";

export const WEB_CATALOG_CACHE_NAME = "crowflix-catalog-v1";
export const WEB_CATALOG_CACHE_KEY = "https://crowflix.cache/web-catalog";
const WEB_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;
const API_BASE = "https://iptv-org.github.io/api";
const FETCH_TIMEOUT_MS = 45_000;

export type WebChannel = {
  key: string;
  id: string;
  feed?: string | null;
  name: string;
  logo?: string | null;
  categories: string[];
  country?: string | null;
  languages: string[];
  broadcastArea: string[];
  sources: StreamSource[];
  url?: string;
  referrer?: string | null;
  userAgent?: string | null;
  quality?: string | null;
  label?: string | null;
  format?: string | null;
  network?: string | null;
  website?: string | null;
  isMain: boolean;
};

export type NamedOption = { id: string; name: string; description?: string | null; count: number };
export type CountryOption = { code: string; name: string; flag: string; languages: string[]; count: number };
export type RegionOption = { code: string; name: string; countries: string[]; count: number };

export type WebCatalog = {
  channels: WebChannel[];
  categories: NamedOption[];
  countries: CountryOption[];
  languages: NamedOption[];
  regions: RegionOption[];
  updatedAt: string;
  source: string;
};

export type ApiPayload = {
  channels: ApiChannel[];
  feeds: ApiFeed[];
  logos: ApiLogo[];
  streams: ApiStream[];
  categories: ApiCategory[];
  languages: ApiLanguage[];
  countries: ApiCountry[];
  regions: ApiRegion[];
  blocklist: ApiBlock[];
};

type ApiChannel = {
  id: string; name: string; network?: string | null; country: string;
  categories?: string[]; closed?: string | null; website?: string | null;
};
type ApiFeed = {
  channel: string; id: string; name: string; is_main?: boolean;
  broadcast_area?: string[]; languages?: string[]; format?: string | null;
};
type ApiLogo = { channel: string; feed?: string | null; in_use?: boolean; url: string };
type ApiStream = {
  channel?: string | null; feed?: string | null; title: string; url: string;
  quality?: string | null; label?: string | null; user_agent?: string | null; referrer?: string | null;
};
type ApiCategory = { id: string; name: string; description: string };
type ApiLanguage = { code: string; name: string };
type ApiCountry = { name: string; code: string; languages?: string[]; flag: string };
type ApiRegion = { code: string; name: string; countries?: string[] };
type ApiBlock = { channel: string };

// --- helpers ported from lib.rs ---

function strictCountryCode(value?: string | null): string | null {
  const code = (value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code === "GB" ? "UK" : code;
}

function fnv1a64(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function trimWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function normalizePlainText(value?: string | null, maxLen = 256): string | null {
  if (value == null) return null;
  const text = trimWrappingQuotes(value);
  if (!text || text.length > maxLen || /[\p{Cc}]/u.test(text)) return null;
  return text;
}

function normalizeUserAgent(value?: string | null): string | null {
  let text = normalizePlainText(value, 768);
  if (!text) return null;
  for (;;) {
    const lower = text.toLowerCase();
    const prefix = ["#extvlcopt:http-user-agent=", "http-user-agent=", "user-agent="]
      .find((candidate) => lower.startsWith(candidate));
    if (!prefix) break;
    text = trimWrappingQuotes(text.slice(prefix.length));
  }
  const normalized = normalizePlainText(text, 512);
  return normalized && /^[\x00-\x7F]*$/.test(normalized) ? normalized : null;
}

function normalizeHttpUrl(value: string): [string, boolean] | null {
  const text = trimWrappingQuotes(value);
  if (!text || text.length > 8_192 || /[\p{Cc}\s]/u.test(text)) return null;
  const lower = text.toLowerCase();
  let authorityStart: number;
  let isHttps: boolean;
  if (lower.startsWith("https://")) { authorityStart = 8; isHttps = true; }
  else if (lower.startsWith("http://")) { authorityStart = 7; isHttps = false; }
  else return null;
  const remainder = text.slice(authorityStart);
  const authorityEndSearch = remainder.search(/[/?#]/);
  const authority = remainder.slice(0, authorityEndSearch === -1 ? remainder.length : authorityEndSearch);
  if (!authority || authority.includes("@")) return null;
  return [text, isHttps];
}

function normalizeReferrer(value?: string | null): string | null {
  const text = normalizePlainText(value, 2_048);
  if (!text || !/^[\x00-\x7F]*$/.test(text)) return null;
  const normalized = normalizeHttpUrl(text);
  return normalized ? normalized[0] : null;
}

function streamTransport(url: string): TransportHint {
  const lower = url.toLowerCase();
  const path = lower.split(/[?#]/, 1)[0];
  if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return "hls";
  if (path.endsWith(".mpd")) return "dash";
  if ([".mp4", ".m4v", ".webm", ".ts", ".m2ts", ".aac", ".m4a", ".mp3", ".ogg", ".oga"]
    .some((extension) => path.endsWith(extension))) return "direct";
  return "unknown";
}

export function qualityHeight(quality?: string | null): number {
  if (!quality) return 0;
  const lower = quality.toLowerCase();
  if (lower.includes("4k") || lower.includes("uhd")) return 2_160;
  if (lower.includes("fhd")) return 1_080;
  if (lower === "hd") return 720;
  if (lower === "sd") return 480;
  const digits = lower.replace(/^[^\d]*/, "").replace(/[^\d].*$/, "");
  const height = Number.parseInt(digits, 10);
  return Number.isFinite(height) && height >= 100 && height <= 4_320 ? height : 0;
}

type SourceAvailability = "normal" | "part-time" | "geo-blocked";

function labelWords(label: string): string[] {
  return label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function sourceAvailability(label?: string | null): SourceAvailability {
  if (!label) return "normal";
  const words = labelWords(label);
  const isGeoBlocked = words.some((word, index) =>
    word === "geo"
    && words[index + 1] === "blocked"
    && (index === 0 || (words[index - 1] !== "non" && words[index - 1] !== "not")));
  if (isGeoBlocked) return "geo-blocked";
  for (let index = 0; index + 2 < words.length; index += 1) {
    if (words[index] === "not" && words[index + 1] === "24" && words[index + 2] === "7") return "part-time";
    if (words[index] === "not" && words[index + 1] === "always" && words[index + 2] === "on") return "part-time";
  }
  for (let index = 0; index + 1 < words.length; index += 1) {
    if (words[index] === "not" && words[index + 1] === "24x7") return "part-time";
  }
  return "normal";
}

function sourcePreferenceScore(source: StreamSource): number {
  const transportScore = source.transport === "hls" ? 400
    : source.transport === "direct" ? 300
      : source.transport === "dash" ? 100 : 200;
  const httpsScore = source.isHttps ? 40 : 0;
  const qualityScore = Math.min(Math.floor(qualityHeight(source.quality) / 60), 72);
  const availabilityScore = sourceAvailability(source.label) === "normal" ? 2_000
    : sourceAvailability(source.label) === "part-time" ? 1_000 : 0;
  return availabilityScore + transportScore + httpsScore + qualityScore;
}

function sourceId(url: string, userAgent?: string | null, referrer?: string | null): string {
  return `source-${fnv1a64(`${url}\n${userAgent || ""}\n${referrer || ""}`).toString(16).padStart(16, "0")}`;
}

function makeStreamSource(
  title: string | null,
  url: string,
  referrer?: string | null,
  userAgent?: string | null,
  quality?: string | null,
  label?: string | null,
): StreamSource | null {
  const normalized = normalizeHttpUrl(url);
  if (!normalized) return null;
  const [normalizedUrl, isHttps] = normalized;
  const source: StreamSource = {
    id: "",
    title: normalizePlainText(title, 256),
    url: normalizedUrl,
    referrer: normalizeReferrer(referrer),
    userAgent: normalizeUserAgent(userAgent),
    quality: normalizePlainText(quality, 64),
    label: normalizePlainText(label, 128),
    transport: streamTransport(normalizedUrl),
    isHttps,
    requiresHeaders: false,
    preferenceScore: 0,
  };
  source.requiresHeaders = Boolean(source.referrer || source.userAgent);
  source.id = sourceId(source.url, source.userAgent, source.referrer);
  source.preferenceScore = sourcePreferenceScore(source);
  return source;
}

function logicalChannelKey(id: string, feed?: string | null): string {
  return `${id}@${feed || "main"}`;
}

function channelIsClosed(closed: string | null | undefined, today: Date): boolean {
  if (!closed) return false;
  const match = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(closed);
  if (!match) return false;
  const closedDate = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return closedDate <= todayUtc;
}

function splitChannelFeed(id: string): [string, string | null] {
  const separator = id.indexOf("@");
  if (separator > 0) {
    const channel = id.slice(0, separator).trim();
    const feed = id.slice(separator + 1).trim();
    if (channel && feed) return [channel, feed];
  }
  return [id.trim(), null];
}

function compareSources(left: StreamSource, right: StreamSource): number {
  return (right.preferenceScore || 0) - (left.preferenceScore || 0)
    || qualityHeight(right.quality) - qualityHeight(left.quality)
    || (left.id || "").localeCompare(right.id || "");
}

function compareText(left: string, right: string): number {
  const lower = left.toLowerCase().localeCompare(right.toLowerCase());
  return lower || left.localeCompare(right);
}

function chooseText(current: string | null | undefined, candidate: string | null | undefined): string | null | undefined {
  if (candidate == null || !candidate.trim()) return current;
  if (current == null || compareText(candidate, current) < 0) return candidate;
  return current;
}

function mergeSource(target: StreamSource, candidate: StreamSource): void {
  target.title = chooseText(target.title, candidate.title) ?? null;
  target.quality = chooseText(target.quality, candidate.quality) ?? null;
  target.label = chooseText(target.label, candidate.label) ?? null;
  target.preferenceScore = sourcePreferenceScore(target);
}

function addSource(channel: WebChannel, source: StreamSource): void {
  const existing = channel.sources.find((item) => item.id === source.id);
  if (existing) mergeSource(existing, source);
  else channel.sources.push(source);
}

function sortAndSyncSources(channel: WebChannel): void {
  channel.sources.sort(compareSources);
  const first = channel.sources[0];
  if (first) {
    channel.url = first.url;
    channel.referrer = first.referrer;
    channel.userAgent = first.userAgent;
    channel.quality = first.quality;
    channel.label = first.label;
  }
}

function mergeUnique(values: string[], candidates: string[]): void {
  for (const candidate of candidates) {
    if (!values.some((value) => value.toLowerCase() === candidate.toLowerCase())) {
      values.push(candidate);
    }
  }
  values.sort(compareText);
}

function chooseName(current: string, candidate: string): string {
  if (!current || compareText(candidate, current) < 0) return candidate;
  return current;
}

function normalizeChannelSources(channel: WebChannel): void {
  const existing = channel.sources;
  channel.sources = [];
  if (!existing.length) {
    const source = makeStreamSource(null, channel.url || "", channel.referrer, channel.userAgent, channel.quality, channel.label);
    if (source) addSource(channel, source);
  } else {
    for (const item of existing) {
      const source = makeStreamSource(item.title ?? null, item.url, item.referrer, item.userAgent, item.quality, item.label);
      if (source) addSource(channel, source);
    }
  }
  sortAndSyncSources(channel);
}

function mergeChannel(target: WebChannel, candidate: WebChannel): void {
  target.name = chooseName(target.name, candidate.name);
  target.logo = chooseText(target.logo, candidate.logo) ?? null;
  target.country = chooseText(target.country, candidate.country) ?? null;
  target.format = chooseText(target.format, candidate.format) ?? null;
  target.network = chooseText(target.network, candidate.network) ?? null;
  target.website = chooseText(target.website, candidate.website) ?? null;
  mergeUnique(target.categories, candidate.categories);
  mergeUnique(target.languages, candidate.languages);
  mergeUnique(target.broadcastArea, candidate.broadcastArea);
  target.isMain = target.isMain || candidate.isMain;
  for (const source of candidate.sources) addSource(target, source);
}

export function normalizeAndGroupChannels(channels: WebChannel[]): WebChannel[] {
  const grouped = new Map<string, WebChannel>();
  for (const channel of channels) {
    const [id, embeddedFeed] = splitChannelFeed(channel.id);
    if (!id) continue;
    channel.id = id;
    if (channel.feed == null) channel.feed = embeddedFeed;
    channel.key = logicalChannelKey(channel.id, channel.feed);
    normalizeChannelSources(channel);
    if (!channel.sources.length) continue;
    const existing = grouped.get(channel.key);
    if (existing) mergeChannel(existing, channel);
    else grouped.set(channel.key, channel);
  }
  const result = [...grouped.values()];
  for (const channel of result) sortAndSyncSources(channel);
  result.sort((left, right) =>
    left.name.toLowerCase().localeCompare(right.name.toLowerCase())
    || left.key.localeCompare(right.key));
  return result;
}

function normalizedChannelTitle(value: string): [string, string] | null {
  const display = normalizePlainText(value.split(/\s+/).join(" "), 256);
  return display ? [display, display.toLowerCase()] : null;
}

function countryFromId(id: string): string | null {
  const base = id.split("@", 1)[0];
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return strictCountryCode(base.slice(dot + 1));
}

function channelFromApiStream(
  stream: ApiStream,
  channelMap: Map<string, ApiChannel>,
  excludedChannelIds: Set<string>,
  feedMap: Map<string, ApiFeed>,
  mainFeedMap: Map<string, ApiFeed>,
  channelLogos: Map<string, string>,
  feedLogos: Map<string, string>,
  languageNames: Map<string, string>,
): WebChannel | null {
  const channelId = stream.channel ?? null;

  if (!channelId) {
    const title = normalizedChannelTitle(stream.title);
    if (!title) return null;
    const [displayName, identity] = title;
    const id = `uncatalogued-${fnv1a64(identity).toString(16).padStart(16, "0")}`;
    const source = makeStreamSource(displayName, stream.url, stream.referrer, stream.user_agent, stream.quality, stream.label);
    if (!source) return null;
    return {
      key: logicalChannelKey(id, null), id, feed: null, name: displayName, logo: null,
      categories: ["undefined"], country: null, languages: [], broadcastArea: [],
      sources: [source], url: source.url, referrer: source.referrer, userAgent: source.userAgent,
      quality: source.quality, label: source.label, format: null, network: null, website: null, isMain: true,
    };
  }

  // A channel ID can temporarily appear in streams.json before channels.json.
  // Keep that stream unless the channel is known and intentionally excluded.
  if (excludedChannelIds.has(channelId)) return null;

  const explicitFeedId = normalizePlainText(stream.feed, 128);
  const feed = explicitFeedId
    ? feedMap.get(`${channelId}
${explicitFeedId}`)
    : mainFeedMap.get(channelId);
  // A stream's explicit feed is authoritative even when feeds.json is temporarily behind it.
  const feedId = explicitFeedId ?? feed?.id ?? null;
  const logo = (feedId && feedLogos.get(`${channelId}
${feedId}`)) || channelLogos.get(channelId) || null;
  const languages = (feed?.languages || []).map((code) => languageNames.get(code) || code);
  const source = makeStreamSource(stream.title, stream.url, stream.referrer, stream.user_agent, stream.quality, stream.label);
  if (!source) return null;

  const apiChannel = channelMap.get(channelId);
  if (!apiChannel) {
    const title = normalizedChannelTitle(stream.title);
    if (!title) return null;
    const [baseName] = title;
    const displayName = feed
      ? (feed.is_main || (feed.name.toLowerCase() === baseName.toLowerCase()) ? baseName : `${baseName} — ${feed.name}`)
      : explicitFeedId ? `${baseName} — ${explicitFeedId}` : baseName;
    return {
      key: logicalChannelKey(channelId, feedId), id: channelId, feed: feedId, name: displayName, logo,
      categories: ["undefined"], country: countryFromId(channelId), languages,
      broadcastArea: feed?.broadcast_area || [],
      sources: [source], url: source.url, referrer: source.referrer, userAgent: source.userAgent,
      quality: source.quality, label: source.label, format: feed?.format ?? null,
      network: null, website: null, isMain: feed?.is_main ?? !explicitFeedId,
    };
  }

  const displayName = feed
    ? (feed.is_main || (feed.name.toLowerCase() === apiChannel.name.toLowerCase())
      ? apiChannel.name
      : `${apiChannel.name} — ${feed.name}`)
    : explicitFeedId ? `${apiChannel.name} — ${explicitFeedId}` : apiChannel.name;
  return {
    key: logicalChannelKey(channelId, feedId), id: channelId, feed: feedId, name: displayName, logo,
    categories: apiChannel.categories?.length ? apiChannel.categories : ["undefined"],
    country: apiChannel.country, languages, broadcastArea: feed?.broadcast_area || [],
    sources: [source], url: source.url, referrer: source.referrer, userAgent: source.userAgent,
    quality: source.quality, label: source.label, format: feed?.format ?? null,
    network: apiChannel.network ?? null, website: apiChannel.website ?? null,
    isMain: feed?.is_main ?? !explicitFeedId,
  };
}

function coverageOptionCounts(
  channels: WebChannel[],
  apiRegions: ApiRegion[],
): [Map<string, number>, Map<string, number>] {
  const regionCountries = new Map<string, Set<string>>();
  const countryRegions = new Map<string, Set<string>>();
  for (const region of apiRegions) {
    const regionCode = region.code.trim().toUpperCase();
    for (const country of region.countries || []) {
      const countryCode = strictCountryCode(country);
      if (!countryCode) continue;
      if (!regionCountries.has(regionCode)) regionCountries.set(regionCode, new Set());
      regionCountries.get(regionCode)!.add(countryCode);
      if (!countryRegions.has(countryCode)) countryRegions.set(countryCode, new Set());
      countryRegions.get(countryCode)!.add(regionCode);
    }
  }

  const countryCounts = new Map<string, number>();
  const regionCounts = new Map<string, number>();
  for (const channel of channels) {
    const channelCountries = new Set<string>();
    const channelRegions = new Set<string>();
    if (!channel.broadcastArea.length) {
      const country = strictCountryCode(channel.country);
      if (country) channelCountries.add(country);
    } else {
      for (const area of channel.broadcastArea) {
        const separator = area.trim().indexOf("/");
        if (separator < 1) continue;
        const kind = area.trim().slice(0, separator).toLowerCase();
        const value = area.trim().slice(separator + 1);
        if (kind === "c") {
          const country = strictCountryCode(value);
          if (country) channelCountries.add(country);
        } else if (kind === "s") {
          const country = strictCountryCode(value.split("-", 1)[0]);
          if (country) channelCountries.add(country);
        } else if (kind === "ct") {
          const country = strictCountryCode(value.slice(0, 2));
          if (country) channelCountries.add(country);
        } else if (kind === "r") {
          const region = value.trim().toUpperCase();
          const countries = regionCountries.get(region);
          if (countries) {
            channelRegions.add(region);
            for (const country of countries) channelCountries.add(country);
          }
        }
      }
    }
    for (const country of channelCountries) {
      for (const region of countryRegions.get(country) || []) channelRegions.add(region);
    }
    for (const country of channelCountries) countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
    for (const region of channelRegions) regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
  }
  return [countryCounts, regionCounts];
}

/** Build the catalogue from already-fetched IPTV-org API payloads. Pure. */
export function buildCatalogFromApi(api: ApiPayload, now = new Date()): WebCatalog {
  const blocked = new Set(api.blocklist.map((item) => item.channel));
  const excludedChannelIds = new Set<string>(blocked);
  for (const channel of api.channels) {
    if (blocked.has(channel.id) || channelIsClosed(channel.closed, now)) {
      excludedChannelIds.add(channel.id);
    }
  }
  const channelMap = new Map<string, ApiChannel>();
  for (const channel of api.channels) {
    if (!blocked.has(channel.id) && !channelIsClosed(channel.closed, now)) {
      channelMap.set(channel.id, channel);
    }
  }

  const feedMap = new Map<string, ApiFeed>();
  const mainFeedMap = new Map<string, ApiFeed>();
  for (const feed of api.feeds) {
    if (feed.is_main) mainFeedMap.set(feed.channel, feed);
    feedMap.set(`${feed.channel}
${feed.id}`, feed);
  }

  const channelLogos = new Map<string, string>();
  const feedLogos = new Map<string, string>();
  for (const logo of api.logos) {
    if (!logo.in_use) continue;
    if (logo.feed) {
      const key = `${logo.channel}
${logo.feed}`;
      if (!feedLogos.has(key)) feedLogos.set(key, logo.url);
    } else if (!channelLogos.has(logo.channel)) {
      channelLogos.set(logo.channel, logo.url);
    }
  }

  const languageNames = new Map(api.languages.map((language) => [language.code, language.name]));

  const channels = normalizeAndGroupChannels(
    api.streams
      .map((stream) => channelFromApiStream(stream, channelMap, excludedChannelIds, feedMap, mainFeedMap, channelLogos, feedLogos, languageNames))
      .filter((channel): channel is WebChannel => Boolean(channel)),
  );

  const categoryCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  for (const channel of channels) {
    for (const category of channel.categories) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    for (const language of channel.languages) languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
  }
  const [countryCounts, regionCounts] = coverageOptionCounts(channels, api.regions);

  const categories: NamedOption[] = api.categories
    .map((category) => ({ id: category.id, name: category.name, description: category.description, count: categoryCounts.get(category.id) || 0 }))
    .filter((category) => category.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const countries: CountryOption[] = api.countries
    .map((country) => ({ code: country.code, name: country.name, flag: country.flag, languages: country.languages || [], count: countryCounts.get(country.code) || 0 }))
    .filter((country) => country.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const languages: NamedOption[] = [...languageCounts.entries()]
    .map(([name, count]) => ({ id: name, name, description: null, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const regions: RegionOption[] = api.regions
    .map((region) => ({ code: region.code, name: region.name, countries: region.countries || [], count: regionCounts.get(region.code.toUpperCase()) || 0 }))
    .filter((region) => region.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    channels, categories, countries, languages, regions,
    updatedAt: now.toISOString(),
    source: "IPTV-org API",
  };
}

// --- browser loading with Cache API read-through ---

type CachedCatalog = { cachedAt: number; catalog: WebCatalog };

async function readCache(): Promise<CachedCatalog | null> {
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(WEB_CATALOG_CACHE_NAME);
    const response = await cache.match(WEB_CATALOG_CACHE_KEY);
    if (!response) return null;
    const parsed = await response.json() as CachedCatalog;
    return parsed?.catalog?.channels?.length ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(catalog: WebCatalog): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open(WEB_CATALOG_CACHE_NAME);
    const payload: CachedCatalog = { cachedAt: Date.now(), catalog };
    await cache.put(WEB_CATALOG_CACHE_KEY, new Response(JSON.stringify(payload)));
  } catch {
    // Caching is best-effort; the catalogue still loads without it.
  }
}

async function fetchJson<T>(name: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/${name}.json`, { signal: controller.signal });
    if (!response.ok) throw new Error(`IPTV-org ${name} returned HTTP ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the real IPTV-org catalogue in the browser. Twelve-hour Cache API
 * read-through; a failed refresh serves the stale cache rather than nothing.
 */
export async function loadWebCatalog(force = false): Promise<WebCatalog> {
  const cached = await readCache();
  if (!force && cached && Date.now() - cached.cachedAt < WEB_CATALOG_TTL_MS) {
    return { ...cached.catalog, source: `${cached.catalog.source} · browser cache` };
  }
  try {
    const [channels, feeds, logos, streams, categories, languages, countries, regions, blocklist] =
      await Promise.all([
        fetchJson<ApiChannel[]>("channels"),
        fetchJson<ApiFeed[]>("feeds"),
        fetchJson<ApiLogo[]>("logos"),
        fetchJson<ApiStream[]>("streams"),
        fetchJson<ApiCategory[]>("categories"),
        fetchJson<ApiLanguage[]>("languages"),
        fetchJson<ApiCountry[]>("countries"),
        fetchJson<ApiRegion[]>("regions"),
        fetchJson<ApiBlock[]>("blocklist"),
      ]);
    const catalog = buildCatalogFromApi({ channels, feeds, logos, streams, categories, languages, countries, regions, blocklist });
    void writeCache(catalog);
    return catalog;
  } catch (error) {
    if (cached) {
      return { ...cached.catalog, source: `${cached.catalog.source} · offline cache` };
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}
