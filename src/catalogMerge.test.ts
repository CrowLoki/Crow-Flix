import { describe, expect, it } from "vitest";
import { mergeChannelsByKey } from "./catalogMerge";
import type { StreamSource } from "./playback/types";

type TestChannel = {
  key: string;
  name: string;
  sources: StreamSource[];
  url?: string;
  referrer?: string | null;
  userAgent?: string | null;
};

describe("mergeChannelsByKey", () => {
  it("merges matching imported channels into one card and deduplicates sources", () => {
    const original: TestChannel = {
      key: "CrowTV.au@main",
      name: "Crow TV",
      sources: [{ id: "one", url: "https://tv.test/live.m3u8" }],
    };
    const imported: TestChannel = {
      key: original.key,
      name: "Imported title",
      sources: [
        { id: "duplicate-id", url: "https://tv.test/live.m3u8" },
        { id: "two", url: "https://backup.test/live.m3u8" },
      ],
    };

    const result = mergeChannelsByKey([original], [imported]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Crow TV");
    expect(result[0].sources.map((source) => source.url)).toEqual([
      "https://tv.test/live.m3u8",
      "https://backup.test/live.m3u8",
    ]);
  });

  it("keeps header variants and migrates a legacy channel URL into the source list", () => {
    const legacy: TestChannel = {
      key: "HeaderTV.ma@main",
      name: "Header TV",
      sources: [],
      url: "https://tv.test/live.m3u8",
      userAgent: "Agent A",
    };
    const imported: TestChannel = {
      key: legacy.key,
      name: "Header TV duplicate",
      sources: [{
        id: "agent-b",
        url: "https://tv.test/live.m3u8",
        userAgent: "Agent B",
      }],
    };

    const result = mergeChannelsByKey([legacy], [imported]);

    expect(result).toHaveLength(1);
    expect(result[0].sources).toHaveLength(2);
    expect(result[0].sources.map((source) => source.userAgent)).toEqual([
      "Agent A",
      "Agent B",
    ]);
  });

  it("appends genuinely new channel keys", () => {
    const existing: TestChannel = {
      key: "One.au@main",
      name: "One",
      sources: [{ url: "https://one.test/live.m3u8" }],
    };
    const imported: TestChannel = {
      key: "Two.au@main",
      name: "Two",
      sources: [{ url: "https://two.test/live.m3u8" }],
    };

    expect(mergeChannelsByKey([existing], [imported]).map((channel) => channel.key))
      .toEqual(["One.au@main", "Two.au@main"]);
  });
});
