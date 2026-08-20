/**
 * Streaming XMLTV parser with a push-based API.
 *
 * Feed it decoded text chunks via push(); it scans incrementally and keeps
 * ONLY programmes whose channel attribute maps into the requested id set
 * (mirroring the alias behaviour of parse_xmltv in src-tauri/src/lib.rs).
 * Non-matching blocks are discarded as soon as they close, so memory stays
 * bounded by the largest single <programme> block plus the kept programmes.
 */

export interface XmltvLimits {
  /** Stop keeping programmes after this many (sets `truncated`). */
  maxProgrammes: number;
  maxTitleBytes: number;
  maxDescBytes: number;
  maxCategoryBytes: number;
}

export const DEFAULT_XMLTV_LIMITS: XmltvLimits = {
  maxProgrammes: 50_000,
  maxTitleBytes: 1_024,
  maxDescBytes: 16 * 1_024,
  maxCategoryBytes: 512,
};

/** Wire shape mirrors the app's camelCase Programme (serde rename_all). */
export interface RelayProgramme {
  channelId: string;
  title: string;
  description?: string;
  category?: string;
  start: string;
  stop: string;
}

const sharedEncoder = new TextEncoder();

function utf8Length(text: string): number {
  return sharedEncoder.encode(text).length;
}

/**
 * Mirror of channel_aliases() in lib.rs: each requested id maps to itself,
 * its base before "@", and the lowercase base — later ids win on collision.
 */
export function channelAliases(channelIds: Iterable<string>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const original of channelIds) {
    aliases.set(original, original);
    const base = original.split("@")[0] ?? original;
    aliases.set(base, original);
    aliases.set(base.toLowerCase(), original);
  }
  return aliases;
}

const XMLTV_TIME =
  /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/;

/**
 * Convert an XMLTV timestamp (`20260816120000 +0000`) to ISO 8601 UTC.
 * Mirrors parse_xmltv_time in lib.rs: an absent timezone is treated as UTC.
 */
export function parseXmltvTime(value: string): string | null {
  const match = XMLTV_TIME.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const base = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(base);
  // Reject out-of-range dates that Date.UTC would silently roll over
  // (e.g. day 32), which chrono would refuse in the Rust parser.
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  let millis = base;
  if (match[7]) {
    const offsetMinutes = Number(match[8]) * 60 + Number(match[9]);
    millis += (match[7] === "+" ? -1 : 1) * offsetMinutes * 60_000;
  }
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const ENTITY = /&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;

export function decodeXmlEntities(text: string): string {
  return text.replace(ENTITY, (token, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = body.startsWith("#x")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : token;
      }
    }
  });
}

/**
 * Remove XML markup in one pass without allowing adjacent or nested tag
 * fragments to become a new element after replacement. XML text containing a
 * literal angle bracket must encode it as an entity, so markup depth can be
 * tracked safely after entity decoding.
 */
export function stripXmlMarkup(text: string): string {
  let markupDepth = 0;
  let plainText = "";

  for (const character of text) {
    if (character === "<") {
      markupDepth += 1;
    } else if (character === ">" && markupDepth > 0) {
      markupDepth -= 1;
    } else if (markupDepth === 0) {
      plainText += character;
    }
  }

  return plainText;
}

function attrValue(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = pattern.exec(tag);
  if (!match) return null;
  return decodeXmlEntities(match[1] ?? match[2] ?? "");
}

function elementText(
  body: string,
  tag: string,
  maxBytes: number,
): string | undefined {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const match = pattern.exec(body);
  if (!match) return undefined;
  const text = stripXmlMarkup(decodeXmlEntities(match[1])).trim();
  if (text.length === 0 || utf8Length(text) > maxBytes) return undefined;
  return text;
}

export class XmltvStreamParser {
  private readonly aliases: Map<string, string>;
  private readonly limits: XmltvLimits;
  private buffer = "";
  private readonly programmes: RelayProgramme[] = [];
  private truncatedFlag = false;

  constructor(channelIds: Iterable<string>, limits: Partial<XmltvLimits> = {}) {
    this.aliases = channelAliases(channelIds);
    this.limits = { ...DEFAULT_XMLTV_LIMITS, ...limits };
  }

  get kept(): number {
    return this.programmes.length;
  }

  /** True once either the programme cap stopped collection. */
  get truncated(): boolean {
    return this.truncatedFlag;
  }

  push(chunk: string): void {
    if (this.truncatedFlag) return;
    if (chunk) this.buffer += chunk;
    this.scan();
  }

  /** Finish parsing and return kept programmes sorted by start time. */
  end(): RelayProgramme[] {
    this.scan();
    this.buffer = "";
    const sorted = [...this.programmes];
    sorted.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return sorted;
  }

  private scan(): void {
    for (;;) {
      const open = this.buffer.indexOf("<programme");
      if (open === -1) {
        // Keep a short tail in case "<programme" is split across chunks.
        this.buffer = this.buffer.slice(-16);
        return;
      }
      const close = this.buffer.indexOf("</programme>", open);
      if (close === -1) {
        if (open > 0) this.buffer = this.buffer.slice(open);
        return; // wait for more data
      }
      const block = this.buffer.slice(open, close);
      this.buffer = this.buffer.slice(close + "</programme>".length);
      this.handleBlock(block);
      if (this.programmes.length >= this.limits.maxProgrammes) {
        this.truncatedFlag = true;
        this.buffer = "";
        return;
      }
    }
  }

  private handleBlock(block: string): void {
    const tagEnd = block.indexOf(">");
    if (tagEnd === -1) return;
    const openingTag = block.slice(0, tagEnd + 1);

    const channel = attrValue(openingTag, "channel");
    const startRaw = attrValue(openingTag, "start");
    const stopRaw = attrValue(openingTag, "stop");
    if (channel === null || startRaw === null || stopRaw === null) return;

    // Mirror lib.rs: exact alias hit, else lowercase alias hit.
    const channelId =
      this.aliases.get(channel) ?? this.aliases.get(channel.toLowerCase());
    if (channelId === undefined) return;

    const start = parseXmltvTime(startRaw);
    const stop = parseXmltvTime(stopRaw);
    if (start === null || stop === null) return;

    const body = block.slice(tagEnd + 1);
    const title = elementText(body, "title", this.limits.maxTitleBytes);
    const description = elementText(body, "desc", this.limits.maxDescBytes);
    const category = elementText(body, "category", this.limits.maxCategoryBytes);

    this.programmes.push({
      channelId,
      title: title ?? "Live programme",
      ...(description !== undefined ? { description } : {}),
      ...(category !== undefined ? { category } : {}),
      start,
      stop,
    });
  }
}
