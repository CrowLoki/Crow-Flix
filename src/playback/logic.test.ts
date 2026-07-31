import { describe, expect, it } from "vitest";
import {
  classifySource,
  migrateStoredChannelKeys,
  orderPlaybackSources,
  sanitizeStreamUrl,
  shouldFallback,
} from "./logic";
import type { StreamSource } from "./types";
import { sourceIdentifier } from "./types";

function source(id: string, url: string, transport?: StreamSource["transport"]): StreamSource {
  return { id, url, transport };
}

describe("classifySource", () => {
  it("recognises URLs, hints, MIME types and small response samples", () => {
    expect(classifySource(source("hls", "https://tv.test/live.m3u8?token=x"))).toBe("hls");
    expect(classifySource(source("dash", "https://tv.test/live"), "application/dash+xml")).toBe("dash");
    expect(classifySource(source("hls-body", "https://tv.test/live"), "", "#EXTM3U\n")).toBe("hls");
    expect(classifySource(source("dash-body", "https://tv.test/live"), "", "<?xml?><MPD type=\"dynamic\">")).toBe("dash");
    expect(classifySource(source("direct", "https://tv.test/video.mp4"))).toBe("progressive");
  });

  it("keeps extensionless HTTP sources probeable and rejects unsupported schemes", () => {
    expect(classifySource(source("unknown", "https://tv.test/live"))).toBe("unknown");
    expect(classifySource(source("rtmp", "rtmp://tv.test/live"))).toBe("unsupported");
    expect(classifySource(source("bad", "not a URL"))).toBe("unsupported");
  });
});

describe("orderPlaybackSources", () => {
  it("uses explicit preference, cooldown, success, source score and stable order", () => {
    const now = 1_000;
    const sources = [
      { ...source("cooling", "https://tv.test/c.m3u8"), preferenceScore: 100 },
      { ...source("healthy", "http://tv.test/a.m3u8"), preferenceScore: 1 },
      { ...source("preferred", "http://tv.test/z"), transport: "unknown" as const },
      { ...source("unsupported", "rtmp://tv.test/live"), preferenceScore: 999 },
    ];
    const health = {
      cooling: { failures: 2, cooldownUntil: 2_000 },
      healthy: { failures: 0, cooldownUntil: 0, lastSuccessAt: 900 },
    };
    expect(orderPlaybackSources(sources, health, "preferred", now).map((item) => item.id))
      .toEqual(["preferred", "healthy", "cooling", "unsupported"]);
  });

  it("does not reopen a preferred source while it is cooling down", () => {
    const now = 5_000;
    const sources = [
      source("preferred", "https://tv.test/preferred.m3u8"),
      source("backup", "https://tv.test/backup.m3u8"),
    ];
    const health = {
      preferred: { failures: 1, cooldownUntil: 10_000, lastSuccessAt: 4_000 },
    };
    expect(orderPlaybackSources(sources, health, "preferred", now).map((item) => item.id))
      .toEqual(["backup", "preferred"]);
  });

  it("orders advisory availability tiers before source scores", () => {
    const sources = [
      { ...source("geo", "https://tv.test/geo.m3u8"), label: "Geo-blocked", preferenceScore: 999 },
      { ...source("part-time", "https://tv.test/part-time.m3u8"), label: "Not 24/7", preferenceScore: 500 },
      { ...source("non-geo", "https://tv.test/non-geo.m3u8"), label: "Non geo blocked" },
      { ...source("ordinary", "https://tv.test/ordinary.m3u8"), label: "Primary feed" },
      source("unlabelled", "https://tv.test/unlabelled.m3u8"),
    ];

    expect(orderPlaybackSources(sources).map((item) => item.id))
      .toEqual(["non-geo", "ordinary", "unlabelled", "part-time", "geo"]);
  });

  it("applies label tiers to imported sources without backend scores or ids", () => {
    const imported: StreamSource[] = [
      { url: "https://tv.test/geo.m3u8", label: "GEO BLOCKED" },
      { url: "https://tv.test/intermittent.m3u8", label: "Not 24x7" },
      { url: "https://tv.test/open.m3u8", label: "not geo-blocked" },
    ];

    expect(orderPlaybackSources(imported).map((item) => item.url))
      .toEqual([
        "https://tv.test/open.m3u8",
        "https://tv.test/intermittent.m3u8",
        "https://tv.test/geo.m3u8",
      ]);
  });

  it("keeps normal sources ahead of part-time and geo-blocked preferred or proven sources", () => {
    const now = 10_000;
    const sources = [
      { ...source("ordinary", "https://tv.test/ordinary.m3u8"), label: "Primary feed" },
      { ...source("proven", "https://tv.test/proven.m3u8"), label: "Geo blocked" },
      { ...source("preferred", "https://tv.test/preferred.m3u8"), label: "Not 24/7" },
    ];
    const health = {
      proven: { failures: 0, cooldownUntil: 0, lastSuccessAt: 9_000 },
    };

    expect(orderPlaybackSources(sources, health, "preferred", now).map((item) => item.id))
      .toEqual(["ordinary", "preferred", "proven"]);
  });

  it("still demotes a cooling normal source below a non-cooling advisory source", () => {
    const now = 10_000;
    const sources = [
      { ...source("normal", "https://tv.test/normal.m3u8"), label: "Primary feed" },
      { ...source("geo", "https://tv.test/geo.m3u8"), label: "Geo blocked" },
    ];
    const health = {
      normal: { failures: 1, cooldownUntil: 20_000, lastSuccessAt: 9_000 },
    };

    expect(orderPlaybackSources(sources, health, "normal", now).map((item) => item.id))
      .toEqual(["geo", "normal"]);
  });

  it("uses input order as a deterministic fallback within the same tier", () => {
    const sources = [
      source("first", "https://tv.test/one.m3u8"),
      source("second", "https://tv.test/two.m3u8"),
      source("third", "https://tv.test/three.m3u8"),
    ];

    expect(orderPlaybackSources(sources).map((item) => item.id))
      .toEqual(["first", "second", "third"]);
  });
});

describe("fallback and privacy helpers", () => {
  it("does not change sources for autoplay prompts or cancelled attempts", () => {
    expect(shouldFallback("network")).toBe(true);
    expect(shouldFallback("media")).toBe(true);
    expect(shouldFallback("unsupported")).toBe(true);
    expect(shouldFallback("autoplay")).toBe(false);
    expect(shouldFallback("aborted")).toBe(false);
  });

  it("removes credentials, query strings and fragments from diagnostics", () => {
    expect(sanitizeStreamUrl("https://user:secret@tv.test:8443/live/a.m3u8?token=secret#frag"))
      .toBe("https://tv.test:8443/…");
  });

  it("migrates legacy indexed keys and preserves unknown keys", () => {
    expect(migrateStoredChannelKeys(
      ["BBCOne.uk#2", "BBCOne.uk#7", "new-key", "missing#1"],
      ["BBCOne.uk", "new-key"],
    )).toEqual(["BBCOne.uk", "new-key", "missing#1"]);
  });

  it("derives a stable opaque identifier when an imported source has no id", () => {
    const imported = {
      url: "https://tv.test/live?token=secret",
      referrer: "https://private.test/watch",
      userAgent: "Private Agent",
    };
    const id = sourceIdentifier(imported);
    expect(sourceIdentifier(imported)).toBe(id);
    expect(id).toMatch(/^source-[0-9a-f]{8}$/);
    expect(id).not.toContain("secret");
    expect(id).not.toContain("private");
  });
});
