/**
 * HLS playlist rewriting: route every resolvable URI back through /stream
 * so header-locked keys, init segments, and media segments all fetch with
 * the provider-required headers.
 *
 * Rewrites both URI="..." attributes on #EXT-X tags (KEY, MAP, MEDIA, ...)
 * and bare URI lines. Relative URIs resolve against the playlist URL.
 */

export type RelayUrlFactory = (absoluteUrl: string) => string;

const URI_ATTRIBUTE = /URI="([^"]*)"/g;

export function rewriteM3u8(
  body: string,
  playlistUrl: string,
  makeRelayUrl: RelayUrlFactory,
): string {
  return body
    .split("\n")
    .map((line) => rewriteLine(line, playlistUrl, makeRelayUrl))
    .join("\n");
}

function rewriteLine(
  line: string,
  playlistUrl: string,
  makeRelayUrl: RelayUrlFactory,
): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) return line;

  if (trimmed.startsWith("#")) {
    if (!line.includes('URI="')) return line;
    return line.replace(URI_ATTRIBUTE, (token, uri: string) => {
      const resolved = resolveHttpUrl(uri, playlistUrl);
      return resolved === null ? token : `URI="${makeRelayUrl(resolved)}"`;
    });
  }

  const resolved = resolveHttpUrl(trimmed, playlistUrl);
  return resolved === null ? line : makeRelayUrl(resolved);
}

/** Resolve against the playlist URL; only http(s) URIs can be relayed. */
function resolveHttpUrl(uri: string, base: string): string | null {
  try {
    const resolved = new URL(uri, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}
