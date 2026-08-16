import { describe, expect, it } from "vitest";
import { relayStreamUrl, toWebPlayableSource, RELAY_BASE } from "./relayClient";

describe("relayStreamUrl", () => {
  it("wraps the url with encoded provider headers", () => {
    const url = relayStreamUrl({
      url: "https://cdn.example.com/live.m3u8?token=a b",
      userAgent: "Provider UA/1.0",
      referrer: "https://provider.example.com/",
    });
    expect(url).toContain(`${RELAY_BASE}/stream?`);
    const query = new URL(url!).searchParams;
    expect(query.get("url")).toBe("https://cdn.example.com/live.m3u8?token=a b");
    expect(query.get("ua")).toBe("Provider UA/1.0");
    expect(query.get("referer")).toBe("https://provider.example.com/");
  });

  it("omits absent headers and rejects non-HTTP urls", () => {
    const url = relayStreamUrl({ url: "https://cdn.example.com/live.m3u8" });
    expect(new URL(url!).searchParams.has("ua")).toBe(false);
    expect(relayStreamUrl({ url: "rtmp://x" })).toBeNull();
    expect(relayStreamUrl({ url: "" })).toBeNull();
  });
});

describe("toWebPlayableSource", () => {
  it("passes through sources that need no headers", () => {
    const source = { url: "https://cdn.example.com/a.m3u8", requiresHeaders: false };
    expect(toWebPlayableSource(source)).toBe(source);
  });

  it("relays header-locked sources with headers baked in and hint preserved", () => {
    const relayed = toWebPlayableSource({
      url: "https://cdn.example.com/a.m3u8",
      requiresHeaders: true,
      userAgent: "UA",
      referrer: "https://ref.example.com/",
      transport: "hls",
    });
    expect(relayed.url).toContain("/stream?");
    expect(relayed.userAgent).toBeNull();
    expect(relayed.referrer).toBeNull();
    expect(relayed.requiresHeaders).toBe(false);
    expect(relayed.transport).toBe("hls");
  });
});
