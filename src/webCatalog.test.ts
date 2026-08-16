import { describe, expect, it } from "vitest";
import {
  buildCatalogFromApi,
  normalizeAndGroupChannels,
  qualityHeight,
  type ApiPayload,
  type WebChannel,
} from "./webCatalog";

function payload(overrides: Partial<ApiPayload> = {}): ApiPayload {
  return {
    channels: [],
    feeds: [],
    logos: [],
    streams: [],
    categories: [],
    languages: [],
    countries: [],
    regions: [],
    blocklist: [],
    ...overrides,
  };
}

describe("qualityHeight", () => {
  it("parses common quality labels", () => {
    expect(qualityHeight("1080p")).toBe(1080);
    expect(qualityHeight("4K")).toBe(2160);
    expect(qualityHeight("FHD")).toBe(1080);
    expect(qualityHeight("HD")).toBe(720);
    expect(qualityHeight("SD")).toBe(480);
    expect(qualityHeight(null)).toBe(0);
    expect(qualityHeight("nonsense")).toBe(0);
  });
});

describe("buildCatalogFromApi", () => {
  it("joins streams onto channels with feed metadata and logos", () => {
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "News.us", name: "Crow News", country: "US", categories: ["news"], network: "CrowNet", website: "https://example.com" }],
      feeds: [{ channel: "News.us", id: "main", name: "Crow News", is_main: true, broadcast_area: ["c/US"], languages: ["eng"], format: "1080p" }],
      logos: [{ channel: "News.us", feed: null, in_use: true, url: "https://example.com/logo.png" }],
      streams: [{ channel: "News.us", feed: null, title: "Crow News", url: "https://cdn.example.com/news.m3u8", quality: "1080p" }],
      categories: [{ id: "news", name: "News", description: "News channels" }],
      languages: [{ code: "eng", name: "English" }],
      countries: [{ name: "United States", code: "US", languages: ["eng"], flag: "🇺🇸" }],
      regions: [{ code: "AMER", name: "Americas", countries: ["US"] }],
    }));
    expect(catalog.channels).toHaveLength(1);
    const channel = catalog.channels[0];
    expect(channel.key).toBe("News.us@main");
    expect(channel.name).toBe("Crow News");
    expect(channel.logo).toBe("https://example.com/logo.png");
    expect(channel.languages).toEqual(["English"]);
    expect(channel.broadcastArea).toEqual(["c/US"]);
    expect(channel.sources[0].transport).toBe("hls");
    expect(channel.sources[0].isHttps).toBe(true);
    expect(catalog.categories[0]).toMatchObject({ id: "news", count: 1 });
    expect(catalog.countries[0]).toMatchObject({ code: "US", count: 1 });
    expect(catalog.regions[0]).toMatchObject({ code: "AMER", count: 1 });
    expect(catalog.languages[0]).toMatchObject({ name: "English", count: 1 });
  });

  it("excludes blocklisted and closed channels but keeps unknown channel ids", () => {
    const today = new Date("2026-08-16T00:00:00Z");
    const catalog = buildCatalogFromApi(payload({
      channels: [
        { id: "Blocked.us", name: "Blocked", country: "US" },
        { id: "Gone.us", name: "Gone", country: "US", closed: "2026-01-01" },
      ],
      blocklist: [{ channel: "Blocked.us" }],
      streams: [
        { channel: "Blocked.us", title: "Blocked", url: "https://x.example.com/a.m3u8" },
        { channel: "Gone.us", title: "Gone", url: "https://x.example.com/b.m3u8" },
        { channel: "Fresh.us", title: "Fresh", url: "https://x.example.com/c.m3u8" },
      ],
    }), today);
    expect(catalog.channels.map((channel) => channel.id)).toEqual(["Fresh.us"]);
    expect(catalog.channels[0].country).toBe("US");
  });

  it("keeps uncatalogued streams with a deterministic hashed identity", () => {
    const first = buildCatalogFromApi(payload({
      streams: [{ channel: null, title: "  Mystery   Feed ", url: "https://x.example.com/m.m3u8" }],
    }));
    const second = buildCatalogFromApi(payload({
      streams: [{ channel: null, title: "Mystery Feed", url: "https://x.example.com/m.m3u8" }],
    }));
    expect(first.channels).toHaveLength(1);
    expect(first.channels[0].name).toBe("Mystery Feed");
    expect(first.channels[0].id).toMatch(/^uncatalogued-[0-9a-f]{16}$/);
    expect(first.channels[0].id).toBe(second.channels[0].id);
    expect(first.channels[0].categories).toEqual(["undefined"]);
  });

  it("rejects streams with non-HTTP or credential-bearing URLs", () => {
    const catalog = buildCatalogFromApi(payload({
      streams: [
        { channel: null, title: "Bad", url: "rtmp://x.example.com/live" },
        { channel: null, title: "Creds", url: "https://user:pass@x.example.com/c.m3u8" },
        { channel: null, title: "Good", url: "https://x.example.com/good.m3u8" },
      ],
    }));
    expect(catalog.channels.map((channel) => channel.name)).toEqual(["Good"]);
  });

  it("merges duplicate channel keys and ranks the best source first", () => {
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "News.us", name: "Crow News", country: "US" }],
      streams: [
        { channel: "News.us", title: "Crow News SD", url: "http://cdn.example.com/sd.m3u8", quality: "480p" },
        { channel: "News.us", title: "Crow News HD", url: "https://cdn.example.com/hd.m3u8", quality: "1080p" },
      ],
    }));
    expect(catalog.channels).toHaveLength(1);
    const channel = catalog.channels[0];
    expect(channel.sources).toHaveLength(2);
    expect(channel.url).toBe("https://cdn.example.com/hd.m3u8");
    expect(channel.quality).toBe("1080p");
  });

  it("deprioritises geo-blocked sources in ordering", () => {
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "News.us", name: "Crow News", country: "US" }],
      streams: [
        { channel: "News.us", title: "Geo", url: "https://cdn.example.com/geo.m3u8", quality: "1080p", label: "Geo-blocked" },
        { channel: "News.us", title: "Open", url: "https://cdn.example.com/open.m3u8", quality: "720p" },
      ],
    }));
    expect(catalog.channels[0].url).toBe("https://cdn.example.com/open.m3u8");
  });

  it("counts region coverage from broadcast-area region codes", () => {
    const catalog = buildCatalogFromApi(payload({
      channels: [{ id: "World.int", name: "World", country: "US" }],
      feeds: [{ channel: "World.int", id: "main", name: "World", is_main: true, broadcast_area: ["r/EUR"] }],
      streams: [{ channel: "World.int", title: "World", url: "https://x.example.com/w.m3u8" }],
      countries: [
        { name: "France", code: "FR", flag: "🇫🇷" },
        { name: "Germany", code: "DE", flag: "🇩🇪" },
      ],
      regions: [{ code: "EUR", name: "Europe", countries: ["FR", "DE"] }],
    }));
    expect(catalog.regions[0]).toMatchObject({ code: "EUR", count: 1 });
    expect(catalog.countries.map((country) => country.code).sort()).toEqual(["DE", "FR"]);
  });
});

describe("normalizeAndGroupChannels", () => {
  it("drops channels that end up without a playable source", () => {
    const channels: WebChannel[] = [{
      key: "x@main", id: "x", name: "Broken", categories: [], languages: [], broadcastArea: [],
      sources: [], url: "notaurl", isMain: true,
    }];
    expect(normalizeAndGroupChannels(channels)).toEqual([]);
  });

  it("splits embedded feed ids and sorts by name", () => {
    const channels: WebChannel[] = [
      {
        key: "b", id: "Zed.us@HD", feed: null, name: "Zed", categories: [], languages: [], broadcastArea: [],
        sources: [{ url: "https://x.example.com/z.m3u8" }], isMain: false,
      },
      {
        key: "a", id: "Alpha.us", feed: null, name: "Alpha", categories: [], languages: [], broadcastArea: [],
        sources: [{ url: "https://x.example.com/a.m3u8" }], isMain: true,
      },
    ];
    const grouped = normalizeAndGroupChannels(channels);
    expect(grouped.map((channel) => channel.name)).toEqual(["Alpha", "Zed"]);
    expect(grouped[1].key).toBe("Zed.us@HD");
  });
});
