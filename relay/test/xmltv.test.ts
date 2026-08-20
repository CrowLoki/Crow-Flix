import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { streamXmltvBody } from "../src/epg";
import {
  channelAliases,
  decodeXmlEntities,
  parseXmltvTime,
  stripXmlMarkup,
  XmltvStreamParser,
} from "../src/xmltv";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="fixture">
  <channel id="ABC1.au"><display-name>ABC TV</display-name></channel>
  <programme start="20260816120000 +0000" stop="20260816130000 +0000" channel="ABC1.au">
    <title>News at Noon &amp; Weather</title>
    <desc>Midday bulletin &#8212; top stories.</desc>
    <category>News</category>
  </programme>
  <programme start="20260816140000 +1000" stop="20260816150000 +1000" channel="abc1.au">
    <title lang="en">Afternoon Show</title>
  </programme>
  <programme start="20260816120000 +0000" stop="20260816130000 +0000" channel="OTHER.uk">
    <title>Unrelated</title>
  </programme>
  <programme start="not-a-time" stop="20260816130000 +0000" channel="ABC1.au">
    <title>Broken timing</title>
  </programme>
</tv>`;

function streamOf(text: string): ReadableStream<Uint8Array> {
  const body = new Response(new TextEncoder().encode(text)).body;
  if (!body) throw new Error("test Response had no body");
  return body;
}

describe("parseXmltvTime", () => {
  it("converts a +0000 timestamp to ISO 8601 UTC", () => {
    expect(parseXmltvTime("20260816120000 +0000")).toBe(
      "2026-08-16T12:00:00.000Z",
    );
  });

  it("applies a positive timezone offset", () => {
    expect(parseXmltvTime("20260816120000 +1000")).toBe(
      "2026-08-16T02:00:00.000Z",
    );
  });

  it("applies a negative timezone offset", () => {
    expect(parseXmltvTime("20260816120000 -0500")).toBe(
      "2026-08-16T17:00:00.000Z",
    );
  });

  it("treats a missing timezone as UTC (mirrors lib.rs)", () => {
    expect(parseXmltvTime("20260816120000")).toBe("2026-08-16T12:00:00.000Z");
  });

  it.each([
    ["month 13", "20261301120000 +0000"],
    ["day 32", "20260132200000 +0000"],
    ["Feb 30", "20260230200000 +0000"],
    ["hour 25", "20260816250000 +0000"],
    ["garbage", "not-a-time"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(parseXmltvTime(value)).toBeNull();
  });
});

describe("decodeXmlEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeXmlEntities("&amp; &lt; &gt; &quot; &apos; &#65; &#x42;")).toBe(
      "& < > \" ' A B",
    );
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeXmlEntities("&bogus;")).toBe("&bogus;");
  });
});

describe("stripXmlMarkup", () => {
  it("removes ordinary, nested, and entity-encoded markup without creating tags", () => {
    const input = decodeXmlEntities(
      "Safe <b>bold</b> <scr<script>ipt>nested</scr<script>ipt> " +
        "&lt;script&gt;encoded&lt;/script&gt;",
    );

    const result = stripXmlMarkup(input);

    expect(result).toBe("Safe bold nested encoded");
    expect(result.toLowerCase()).not.toContain("<script");
  });
});

describe("channelAliases", () => {
  it("maps id, base before @, and lowercase base (mirrors lib.rs)", () => {
    const aliases = channelAliases(["ABC1.au@HD"]);
    expect(aliases.get("ABC1.au@HD")).toBe("ABC1.au@HD");
    expect(aliases.get("ABC1.au")).toBe("ABC1.au@HD");
    expect(aliases.get("abc1.au")).toBe("ABC1.au@HD");
  });
});

describe("XmltvStreamParser", () => {
  it("keeps only requested channels and normalises fields", () => {
    const parser = new XmltvStreamParser(["ABC1.au"]);
    parser.push(FIXTURE);
    const programmes = parser.end();

    expect(programmes).toHaveLength(2);
    // Sorted by start: the +1000 programme (04:00 UTC) comes first.
    expect(programmes[0]).toEqual({
      channelId: "ABC1.au",
      title: "Afternoon Show",
      start: "2026-08-16T04:00:00.000Z",
      stop: "2026-08-16T05:00:00.000Z",
    });
    expect(programmes[1]).toEqual({
      channelId: "ABC1.au",
      title: "News at Noon & Weather",
      description: "Midday bulletin — top stories.",
      category: "News",
      start: "2026-08-16T12:00:00.000Z",
      stop: "2026-08-16T13:00:00.000Z",
    });
    expect(parser.truncated).toBe(false);
  });

  it("drops programmes with unparseable times, like lib.rs", () => {
    const parser = new XmltvStreamParser(["ABC1.au"]);
    parser.push(FIXTURE);
    const titles = parser.end().map((p) => p.title);
    expect(titles).not.toContain("Broken timing");
    expect(titles).not.toContain("Unrelated");
  });

  it("matches aliases case-insensitively and reports the requested id", () => {
    const parser = new XmltvStreamParser(["ABC1.au@HD"]);
    parser.push(FIXTURE);
    const programmes = parser.end();
    expect(programmes).toHaveLength(2);
    expect(programmes.every((p) => p.channelId === "ABC1.au@HD")).toBe(true);
  });

  it("handles chunks split inside a tag", () => {
    const cut = FIXTURE.indexOf("<programme") + 5;
    const parser = new XmltvStreamParser(["ABC1.au"]);
    parser.push(FIXTURE.slice(0, cut));
    expect(parser.kept).toBe(0);
    parser.push(FIXTURE.slice(cut));
    expect(parser.end()).toHaveLength(2);
  });

  it("handles many small chunks", () => {
    const parser = new XmltvStreamParser(["ABC1.au"]);
    for (let i = 0; i < FIXTURE.length; i += 7) {
      parser.push(FIXTURE.slice(i, i + 7));
    }
    expect(parser.end()).toHaveLength(2);
  });

  it("stops keeping programmes at the cap and flags truncation", () => {
    const parser = new XmltvStreamParser(["ABC1.au"], { maxProgrammes: 1 });
    parser.push(FIXTURE);
    parser.push(FIXTURE); // ignored: already truncated
    const programmes = parser.end();
    expect(programmes).toHaveLength(1);
    expect(parser.truncated).toBe(true);
  });

  it("falls back to the default title when the title is oversized", () => {
    const xml = `<tv><programme start="20260816120000 +0000" stop="20260816130000 +0000" channel="ABC1.au"><title>${"x".repeat(2_000)}</title></programme></tv>`;
    const parser = new XmltvStreamParser(["ABC1.au"], { maxTitleBytes: 1_024 });
    parser.push(xml);
    expect(parser.end()[0].title).toBe("Live programme");
  });

  it("treats an empty title element as missing", () => {
    const xml = `<tv><programme start="20260816120000 +0000" stop="20260816130000 +0000" channel="ABC1.au"><title></title></programme></tv>`;
    const parser = new XmltvStreamParser(["ABC1.au"]);
    parser.push(xml);
    expect(parser.end()[0].title).toBe("Live programme");
  });
});

describe("streamXmltvBody", () => {
  it("parses a plain XMLTV stream", async () => {
    const parser = new XmltvStreamParser(["ABC1.au"]);
    const { truncated } = await streamXmltvBody(streamOf(FIXTURE), parser);
    expect(truncated).toBe(false);
    expect(parser.end()).toHaveLength(2);
  });

  it("parses a gzipped XMLTV stream via magic bytes", async () => {
    const gz = gzipSync(FIXTURE);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    const body = new Response(gz).body;
    if (!body) throw new Error("test Response had no body");
    const parser = new XmltvStreamParser(["ABC1.au"]);
    const { truncated } = await streamXmltvBody(body, parser);
    expect(truncated).toBe(false);
    const programmes = parser.end();
    expect(programmes).toHaveLength(2);
    expect(programmes[1].title).toBe("News at Noon & Weather");
  });

  it("flags truncation when the decompressed budget is exceeded", async () => {
    const parser = new XmltvStreamParser(["ABC1.au"]);
    const { truncated } = await streamXmltvBody(streamOf(FIXTURE), parser, 64);
    expect(truncated).toBe(true);
  });

  it("handles an empty body", async () => {
    const body = new Response(new Uint8Array(0)).body;
    if (!body) throw new Error("test Response had no body");
    const parser = new XmltvStreamParser(["ABC1.au"]);
    const { truncated } = await streamXmltvBody(body, parser);
    expect(truncated).toBe(false);
    expect(parser.end()).toHaveLength(0);
  });
});
