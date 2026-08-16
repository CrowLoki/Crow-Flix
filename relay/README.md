# crowflix-relay

A small Cloudflare Worker that gives the CrowFlix **browser build** (hosted on
Cloudflare Pages) the two things browsers cannot do themselves:

1. **Server-side EPG pipeline** (`/epg`) — fetch and parse XMLTV programme
   guides without running into CORS.
2. **Header-locked stream relay** (`/stream`) — attach provider-required
   `User-Agent` / `Referer` headers server-side, with HLS playlist rewriting
   so every segment, key, and variant routes back through the relay.
3. **Bounded generic text fetch** (`/fetch`) — pull user-supplied M3U
   playlists and XMLTV guides for the web import feature.

The desktop (Tauri) app does not need this Worker; its Rust core already
fetches directly. This mirrors that core logic — `load_auto_epg` and
`parse_xmltv` in `src-tauri/src/lib.rs` — for the browser build.

## Honest scope statement

The relay **does not bypass provider geographic or account restrictions**.
It only supplies the headers (`User-Agent`, `Referer`) that the provider
already requires, from a server where browsers are not allowed to set them.
If a stream is geo-blocked or needs an account/token, it stays blocked.

## Deploy

```sh
cd relay
npx wrangler deploy
```

No build step, no runtime npm dependencies (Web standard APIs only: `fetch`,
`DecompressionStream`, `TextDecoder`, `ReadableStream`). `wrangler.toml`
carries no `account_id` — wrangler resolves it from your login. Point the web
app at the deployed origin (e.g. `https://crowflix-relay.<you>.workers.dev`).

## Routes

All responses include `Access-Control-Allow-Origin: *` and preflight
(`OPTIONS`) is answered. All failures return `{"error": "..."}` JSON with a
4xx/5xx status and CORS headers — the client never sees an opaque block.
Only `GET` is accepted.

### `GET /health`

```json
{ "ok": true, "service": "crowflix-relay", "version": "0.1.0" }
```

### `GET /epg?country=AU&ids=id1,id2,...`

Pipeline (mirrors `load_auto_epg` in `src-tauri/src/lib.rs` lines 2180-2237):

1. Fetch `https://iptv-org.github.io/api/guides.json`, verify the shape
   defensively (array of `{channel?, sources?: [{url}]}`; junk entries are
   skipped, malformed JSON is treated as "index unavailable").
2. Rank guide source URLs by how many requested channel ids each covers
   (same `source_coverage` counting; stable descending sort).
3. Try up to **3** ranked sources (the Rust core tries 8; the Worker has
   tighter CPU budgets, so fewer attempts). First source yielding at least
   one matching programme wins.
4. Fallback: `epg_ripper_{CC}1.xml.gz` from `epgshare01.online` then the
   `raw.githubusercontent.com/epgshare01` mirror, where `CC` is the `country`
   param uppercased with `GB → UK` aliasing.
5. Nothing matched → `502 {"error": "No current programme listings matched the CC channels."}`.

XMLTV handling: gzip is detected by magic bytes (`1f 8b`) and inflated with
`DecompressionStream("gzip")` (when upstream sets `Content-Encoding: gzip`
the runtime has already decompressed). Parsing is **streaming**: the parser
scans incrementally and keeps only programmes whose `channel` attribute maps
into the requested id set, including the same alias rules as the Rust core
(exact id, base before `@`, lowercase base). XMLTV timestamps like
`20260816120000 +0000` convert to ISO 8601 UTC; a missing timezone is treated
as UTC, matching `parse_xmltv_time`.

Success response (mirrors the app's camelCase `GuideResult`; XMLTV `<desc>`
is returned as `description`):

```json
{
  "programmes": [
    {
      "channelId": "ABC1.au",
      "title": "News at Noon & Weather",
      "description": "Midday bulletin — top stories.",
      "category": "News",
      "start": "2026-08-16T12:00:00.000Z",
      "stop": "2026-08-16T13:00:00.000Z"
    }
  ],
  "source": "IPTV-org EPG · https://.../guide.xml",
  "matchedChannels": 1,
  "updatedAt": "2026-08-16T05:00:00.000Z"
}
```

Successful `/epg` responses carry `Cache-Control: public, max-age=300`
(guide files update roughly hourly; caching saves Worker CPU).

Input rules: 1-2000 channel ids, each ≤ 200 chars, no control characters;
`country` optional but must be 2-8 alphanumerics when present.

### `GET /fetch?url=<encoded>`

Bounded generic text fetch for user-supplied M3U playlists / XMLTV guides.

- URL validation: http/https only, no embedded credentials, SSRF guard
  (rejects `localhost`/`*.localhost`, loopback, private, link-local, CGNAT,
  multicast and IPv4-mapped IPv6 literals; redirects are followed manually
  and **every hop is re-validated**).
- Response capped at **32 MiB**, counted while streaming; over the cap → 502.
- Upstream `Content-Type` is passed through. 30 s upstream timeout.

### `GET /stream?url=<encoded>&referer=<encoded>&ua=<encoded>`

Header-locked stream relay. Same URL validation as `/fetch`. The supplied
`ua` / `referer` values (both optional, sanitised) become upstream
`User-Agent` / `Referer` headers.

- If the response is an HLS playlist — content type contains `mpegurl`, URL
  path ends `.m3u8`/`.m3u`, **or** the body starts with `#EXTM3U` (sniffed via
  `tee()` so mislabeled playlists still work) — the playlist is read within a
  **4 MiB** cap and every URI is rewritten through `/stream` with the same
  `ua`/`referer`: both `#EXT-X-...:URI="..."` attributes (KEY, MAP, MEDIA,
  ...) and bare URI lines, with relative URIs resolved against the playlist
  URL. Non-http(s) URIs (e.g. `data:`) are left untouched.
- Anything else (media segments, live streams) streams through **unbounded**
  and untouched. No upstream timeout — live IPTV streams are long-lived.
- Full URLs are never logged (they may carry query credentials); error
  messages quote upstream status codes only.

## Limits summary

| Bound                                    | Value   |
| ---------------------------------------- | ------- |
| Channel ids per `/epg` request           | 2,000   |
| Ranked guide sources tried               | 3       |
| Kept programmes per parse                | 50,000  |
| Decompressed XMLTV per source            | 24 MiB  |
| guides.json index                        | 16 MiB  |
| `/fetch` response                        | 32 MiB  |
| Rewritten playlist body                  | 4 MiB   |
| Redirects followed (re-validated)        | 5       |

## Development

From the **repo root** (uses the root's existing vitest/typescript installs —
the relay adds no dependencies of its own):

```sh
npx vitest run relay                  # relay test suite
cd relay && npx tsc --noEmit -p tsconfig.json   # typecheck
npx wrangler dev                      # local Worker dev server
```

Layout: `src/index.ts` (routing + routes), `src/epg.ts` (EPG pipeline),
`src/xmltv.ts` (streaming parser), `src/m3u8.ts` (playlist rewriting),
`src/urls.ts` (URL validation + redirect-safe fetch), `src/streams.ts`
(bounded readers), `src/errors.ts` (`RelayError`), `test/` (vitest).
