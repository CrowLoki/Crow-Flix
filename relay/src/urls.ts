import { RelayError } from "./errors";

/** Mirrors MAX_EXTERNAL_URL_LENGTH in src-tauri/src/lib.rs. */
export const MAX_EXTERNAL_URL_LENGTH = 8_192;
export const MAX_REDIRECTS = 5;

const INVALID_URL =
  "Only normal HTTP and HTTPS website addresses are supported.";
const PRIVATE_URL =
  "That address points at a local or private network and cannot be relayed.";

/** Reject C0 control characters and DEL without embedding them in source. */
function hasControlChars(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface FetchLike {
  (input: URL | string, init?: RequestInit): Promise<Response>;
}

/**
 * Validate a user-supplied URL for relaying: http/https only, no embedded
 * credentials, and no loopback / private / link-local hostnames.
 *
 * A Worker cannot DNS-resolve, so hostname-based filtering is limited to
 * literal IPs and obvious local names. The WHATWG URL parser normalises
 * decimal/hex/octal IPv4 literals (e.g. 2130706433, 0x7f000001) to dotted
 * decimal before we inspect them.
 */
export function validateExternalUrl(raw: string): URL {
  if (
    raw.length === 0 ||
    raw.length > MAX_EXTERNAL_URL_LENGTH ||
    raw.trim() !== raw ||
    hasControlChars(raw)
  ) {
    throw new RelayError(400, INVALID_URL);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RelayError(400, INVALID_URL);
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new RelayError(400, INVALID_URL);
  }

  if (isPrivateHostname(parsed.hostname)) {
    throw new RelayError(400, PRIVATE_URL);
  }
  return parsed;
}

export function isPrivateHostname(hostname: string): boolean {
  let host = hostname.toLowerCase();
  while (host.endsWith(".")) host = host.slice(0, -1);

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // WHATWG keeps the brackets on IPv6 literals in URL.hostname.
  if (host.startsWith("[") && host.endsWith("]")) {
    return isPrivateIpv6(host.slice(1, -1));
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return isPrivateIpv4(host);
  }
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true; // malformed literal: fail closed
  }
  const a = parts[0];
  const b = parts[1];
  if (a === 0 || a === 10 || a === 127) return true; // unspecified / private / loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  let s = host.toLowerCase();

  // Dotted IPv4 tail, e.g. ::ffff:127.0.0.1 or ::127.0.0.1
  let v4Bytes: number[] | null = null;
  const v4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4Tail) {
    v4Bytes = v4Tail[1].split(".").map((part) => Number.parseInt(part, 10));
    s = s.slice(0, s.length - v4Tail[1].length);
  }

  let head: string[];
  let tail: string[];
  if (s.includes("::")) {
    const halves = s.split("::");
    if (halves.length !== 2) return true; // malformed: fail closed
    head = halves[0] === "" ? [] : halves[0].split(":");
    tail = halves[1] === "" ? [] : halves[1].split(":");
  } else {
    head = s === "" ? [] : s.split(":");
    tail = [];
  }

  const missing = 8 - head.length - tail.length - (v4Bytes ? 2 : 0);
  if (missing < 0) return true; // malformed: fail closed

  const groups: number[] = [];
  const pushGroup = (token: string): boolean => {
    if (!/^[0-9a-f]{1,4}$/.test(token)) return false;
    groups.push(Number.parseInt(token, 16));
    return true;
  };
  for (const token of head) if (!pushGroup(token)) return true;
  for (let i = 0; i < missing; i++) groups.push(0);
  for (const token of tail) if (!pushGroup(token)) return true;

  if (v4Bytes) {
    if (v4Bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true; // malformed: fail closed
    }
    groups.push((v4Bytes[0] << 8) | v4Bytes[1], (v4Bytes[2] << 8) | v4Bytes[3]);
  }
  if (groups.length !== 8) return true; // fail closed

  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return true; // ::1 loopback
  }
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // IPv4-mapped ::ffff:a.b.c.d — inspect the embedded address too.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const embedded = [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ].join(".");
    if (isPrivateIpv4(embedded)) return true;
  }
  return false;
}

/**
 * fetch() wrapper that follows redirects manually and re-validates every
 * redirect target, so a public URL cannot bounce the relay at a private one.
 */
export async function fetchValidated(
  start: URL,
  init: RequestInit = {},
  fetcher: FetchLike = fetch,
): Promise<Response> {
  let current = start;
  for (let hop = 0; ; hop++) {
    const response = await fetcher(current, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        if (hop >= MAX_REDIRECTS) {
          throw new RelayError(
            502,
            "The upstream server sent too many redirects.",
          );
        }
        let resolved: URL;
        try {
          resolved = new URL(location, current);
        } catch {
          throw new RelayError(
            502,
            "The upstream server sent an invalid redirect.",
          );
        }
        current = validateExternalUrl(resolved.href);
        continue;
      }
    }
    return response;
  }
}
