import { describe, expect, it } from "vitest";
import {
  canonicalCountryCode,
  channelMatchesCountry,
  channelMatchesRegion,
  type BroadcastAreaChannel,
  type BroadcastRegion,
} from "./broadcastArea";

const regions: BroadcastRegion[] = [
  { code: "OCE", countries: ["AU", "NZ"] },
  { code: "APAC", countries: ["AU", "NZ", "JP"] },
  { code: "EUR", countries: ["UK", "FR", "DE"] },
];

function channel(
  broadcastArea: string[],
  country: string | null = "US",
): BroadcastAreaChannel {
  return { broadcastArea, country };
}

describe("canonicalCountryCode", () => {
  it("uses IPTV-org's UK code while accepting the locale GB alias", () => {
    expect(canonicalCountryCode("gb")).toBe("UK");
    expect(canonicalCountryCode("UK")).toBe("UK");
  });
});

describe("channelMatchesCountry", () => {
  it.each([
    ["country", ["c/AU"]],
    ["subdivision", ["s/AU-QLD"]],
    ["city", ["ct/AUSYD"]],
  ])("matches a %s broadcast area", (_label, broadcastArea) => {
    expect(channelMatchesCountry(channel(broadcastArea), "AU", regions))
      .toBe(true);
    expect(channelMatchesCountry(channel(broadcastArea), "NZ", regions))
      .toBe(false);
  });

  it("matches region broadcasts through the catalogue region countries", () => {
    expect(channelMatchesCountry(channel(["r/OCE"]), "AU", regions)).toBe(true);
    expect(channelMatchesCountry(channel(["r/OCE"]), "JP", regions)).toBe(false);
  });

  it("accepts GB as an alias when matching UK broadcast metadata", () => {
    expect(channelMatchesCountry(channel(["c/UK"]), "GB", regions)).toBe(true);
    expect(channelMatchesCountry(channel(["s/GB-ENG"]), "UK", regions))
      .toBe(true);
    expect(channelMatchesCountry(channel(["ct/GBLON"]), "UK", regions))
      .toBe(true);
  });

  it("falls back to origin country only when broadcast areas are empty", () => {
    expect(channelMatchesCountry(channel([], "AU"), "AU", regions)).toBe(true);
    expect(channelMatchesCountry(channel(["x/unknown"], "AU"), "AU", regions))
      .toBe(false);
  });
});

describe("channelMatchesRegion", () => {
  it.each([
    ["country", ["c/AU"]],
    ["subdivision", ["s/AU-QLD"]],
    ["city", ["ct/AUSYD"]],
    ["region", ["r/OCE"]],
  ])("matches a %s area to its selected region", (_label, broadcastArea) => {
    expect(channelMatchesRegion(channel(broadcastArea), "OCE", regions))
      .toBe(true);
  });

  it("expands a region broadcast into overlapping catalogue regions", () => {
    expect(channelMatchesRegion(channel(["r/OCE"]), "APAC", regions))
      .toBe(true);
    expect(channelMatchesRegion(channel(["r/OCE"]), "EUR", regions))
      .toBe(false);
  });

  it("uses origin country only when area metadata is absent", () => {
    expect(channelMatchesRegion(channel([], "AU"), "OCE", regions)).toBe(true);
    expect(channelMatchesRegion(channel(["x/unknown"], "AU"), "OCE", regions))
      .toBe(false);
  });

  it("does not match unknown areas or unknown selected regions", () => {
    expect(channelMatchesRegion(channel(["x/mystery"]), "OCE", regions))
      .toBe(false);
    expect(channelMatchesRegion(channel(["c/AU"]), "UNKNOWN", regions))
      .toBe(false);
  });
});
