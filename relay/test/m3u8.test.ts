import { describe, expect, it } from "vitest";
import { rewriteM3u8 } from "../src/m3u8";

const PLAYLIST_URL = "https://media.example/live/master.m3u8";

/** Same factory shape the Worker uses, with fixed ua/referer. */
function makeRelayUrl(absolute: string): string {
  const relay = new URL("/stream", "https://relay.example");
  relay.searchParams.set("url", absolute);
  relay.searchParams.set("ua", "TestUA/1.0");
  relay.searchParams.set("referer", "https://provider.example/");
  return relay.toString();
}

/** Extract the rewritten relay URL from a line (attribute or bare). */
function relayTarget(line: string): URL {
  const attribute = /URI="([^"]*)"/.exec(line);
  const target = attribute ? attribute[1] : line.trim();
  expect(target.startsWith("https://relay.example/stream")).toBe(true);
  return new URL(target);
}

const PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin",IV=0x00000000000000000000000000000000',
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:6.0,",
  "seg1.ts",
  "#EXTINF:6.0,",
  "https://cdn.other.example/path/seg2.ts?token=a&b=c",
  "#EXTINF:6.0,",
  "//proto-relative.example/seg3.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

describe("rewriteM3u8", () => {
  const output = rewriteM3u8(PLAYLIST, PLAYLIST_URL, makeRelayUrl);
  const lines = output.split("\n");

  it("preserves line structure and comment tags without URIs", () => {
    expect(lines).toHaveLength(PLAYLIST.split("\n").length);
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[1]).toBe("#EXT-X-VERSION:3");
    expect(lines[4]).toBe("#EXTINF:6.0,");
    expect(lines[10]).toBe("#EXT-X-ENDLIST");
  });

  it("rewrites #EXT-X-KEY URI attributes and keeps other attributes", () => {
    const line = lines[2];
    expect(line.startsWith("#EXT-X-KEY:METHOD=AES-128,")).toBe(true);
    expect(line).toContain("IV=0x00000000000000000000000000000000");
    const target = relayTarget(line);
    expect(target.searchParams.get("url")).toBe(
      "https://media.example/live/keys/key.bin",
    );
  });

  it("rewrites #EXT-X-MAP URI attributes", () => {
    const target = relayTarget(lines[3]);
    expect(target.searchParams.get("url")).toBe(
      "https://media.example/live/init.mp4",
    );
  });

  it("rewrites bare relative URI lines against the playlist URL", () => {
    const target = relayTarget(lines[5]);
    expect(target.searchParams.get("url")).toBe(
      "https://media.example/live/seg1.ts",
    );
    expect(target.searchParams.get("ua")).toBe("TestUA/1.0");
    expect(target.searchParams.get("referer")).toBe("https://provider.example/");
  });

  it("rewrites bare absolute URIs and preserves query strings", () => {
    const target = relayTarget(lines[7]);
    expect(target.searchParams.get("url")).toBe(
      "https://cdn.other.example/path/seg2.ts?token=a&b=c",
    );
  });

  it("rewrites protocol-relative URIs using the playlist scheme", () => {
    const target = relayTarget(lines[9]);
    expect(target.searchParams.get("url")).toBe(
      "https://proto-relative.example/seg3.ts",
    );
  });

  it("leaves non-http(s) URIs untouched", () => {
    const playlist = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
      "#EXT-X-ENDLIST",
    ].join("\n");
    const rewritten = rewriteM3u8(playlist, PLAYLIST_URL, makeRelayUrl);
    expect(rewritten.split("\n")[1]).toBe(
      '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
    );
  });

  it("tolerates CRLF line endings", () => {
    const playlist = "#EXTM3U\r\nseg1.ts\r\n#EXT-X-ENDLIST\r\n";
    const rewritten = rewriteM3u8(playlist, PLAYLIST_URL, makeRelayUrl);
    const lines = rewritten.split("\n");
    expect(lines[0]).toBe("#EXTM3U\r");
    expect(lines[2]).toBe("#EXT-X-ENDLIST\r");
    const target = relayTarget(lines[1]);
    expect(target.searchParams.get("url")).toBe(
      "https://media.example/live/seg1.ts",
    );
  });

  it("rewrites nested variant playlists the same way", () => {
    const variant = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1000000",
      "sub/low.m3u8",
    ].join("\n");
    const rewritten = rewriteM3u8(variant, PLAYLIST_URL, makeRelayUrl);
    const target = relayTarget(rewritten.split("\n")[2]);
    expect(target.searchParams.get("url")).toBe(
      "https://media.example/live/sub/low.m3u8",
    );
  });
});
