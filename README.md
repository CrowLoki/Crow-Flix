# CrowFlix

CrowFlix is a standalone desktop IPTV player, programme guide, and user-managed web library with a cinematic interface. It is built with Rust, Tauri, React, and TypeScript.

CrowFlix does not host television channels, media, programme data, or third-party websites. It retrieves records published by configured upstream services and can load sources supplied by the person using the app. Provider availability, access rules, and regional restrictions remain outside CrowFlix's control.

## Features

- IPTV-org integration for channel, stream, feed, logo, category, country, language, region, request-header, and lifecycle metadata
- HLS and MPEG-DASH playback with bounded recovery, ranked alternate sources, and automatic failover
- Automatic IPTV-org programme-guide matching with regional fallback
- Search, category/country/language/region browsing, favourites, recent channels, and a versioned offline catalogue cache
- Optional personal M3U playlists and XMLTV guides from HTTPS/HTTP URLs or local files
- Bounded playlist, guide, decompression, entry-count, and field-size handling for untrusted imports
- Native HTTP requests for streams that require provider-supplied User-Agent or Referer headers
- A separate Web Library with eight built-in directory links and user-managed add, edit, delete, search, JSON export, and merge-import controls
- External website buttons that open the exact HTTP or HTTPS page in the system browser
- Self-contained Crow Bitfeather fonts, Crow Talon pointers, approved Crow mascot, and Crow head icon
- Windows NSIS installer with no separate browser or local server required

The application retains the stream records supplied by its configured catalogue, including records without category metadata. Upstream blocklisted and formally closed records are excluded. A source label such as `Geo-blocked` is advisory: CrowFlix cannot remove a provider-side restriction.

## Download and verification

Windows releases are published on the [CrowFlix releases page](https://github.com/CrowLoki/Crow-Flix/releases). Each release includes:

- the NSIS installer;
- a SHA-256 checksum file; and
- GitHub build provenance for the published artifact.

The current Windows installer is not Authenticode-signed because the project does not yet have a publicly trusted code-signing certificate. Windows may therefore display an unknown-publisher warning. Verify the checksum and the GitHub release provenance before running a downloaded installer.

## Upstream data

CrowFlix uses [iptv-org/api](https://github.com/iptv-org/api) as its primary machine-readable catalogue. Related repositories have separate jobs:

- [iptv-org/iptv](https://github.com/iptv-org/iptv) maintains public stream URLs and generated M3U views.
- [iptv-org/database](https://github.com/iptv-org/database) supplies channel, feed, broadcast-area, and lifecycle metadata.
- [iptv-org/epg](https://github.com/iptv-org/epg) supplies programme-guide tooling and sources.
- [iptv-org/awesome-iptv](https://github.com/iptv-org/awesome-iptv) and [iptv-org/sdk](https://github.com/iptv-org/sdk) are reference resources, not additional channel catalogues.

Country, language, category, and region playlists are generated views of the same IPTV-org stream records, so importing them beside the API would create duplicates.

Some free ad-supported television endpoints move before the primary catalogue is updated. CrowFlix can check selected playlist snapshots published by [Apsattv](https://www.apsattv.com/streams.html) as an optional, non-fatal source of alternate Amagi URLs. A supplemental source is accepted only when its provider-channel identity and normalized title match an existing channel. A failed supplemental download never prevents the primary catalogue from loading.

CrowFlix is independent and is not endorsed by IPTV-org, Apsattv, guide providers, stream providers, artwork hosts, or linked website directories.

## Playback and availability

CrowFlix routes HLS and MPEG-DASH sources through their corresponding adaptive playback engines. When a source requires a User-Agent or Referer header, the capability-scoped Tauri HTTP client can make normal HTTP or HTTPS requests outside the WebView's CORS restrictions.

Direct media may play when its container and codecs are supported by the operating-system WebView. RTMP, RTSP, and MMSH are not supported by the embedded player. Continuous MPEG-TS and other direct streams that require custom headers may need a dedicated transport; CrowFlix falls back to another source when available.

Provider URLs can expire, move, fail, or apply geographic and account restrictions without notice. CrowFlix retries only within bounded limits and then advances through available alternates. It does not guarantee that any channel, programme listing, or external destination will be available in a particular location.

## Web Library

The built-in Web Library contains eight directory pages as navigation starting points. CrowFlix does not redistribute unlicensed provider lists. People can add their own exact destinations or import a CrowFlix JSON backup.

Destinations are stored locally for the current application identity. Importing a backup merges by normalized URL and does not overwrite an existing saved entry. CrowFlix opens a page only after its clearly labelled button is pressed. The native command accepts HTTP and HTTPS addresses, rejects embedded credentials and other schemes, and sends the exact page to the system browser.

CrowFlix does not embed, scrape, download, copy, host, or rebroadcast an external page or its media. Use external sources only where you have the right to access them and subject to their terms.

## Development

Requirements:

- Node.js and npm
- Rust 1.97.0 with the MSVC Windows toolchain
- the Tauri 2 Windows prerequisites

Install dependencies and start the isolated development app:

```powershell
npm ci
npm run tauri:dev
```

The development command uses the separate `com.crowflix.app.dev` identity and **CrowFlix Dev** title, keeping its cache and application data separate from an installed production copy.

Run the complete source checks:

```powershell
npm run check
npm run test:rust
```

`npm run check` validates TypeScript, runs frontend tests, checks Rust formatting, performs a locked Rust compile, and verifies generated third-party notices. The deterministic Rust suite does not require the network. The live IPTV-org catalogue smoke test is intentionally opt-in:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --locked builds_authoritative_iptv_org_catalog -- --ignored
```

Build and verify a public Windows installer:

```powershell
npm run release:build
npm run release:verify
```

The release build remaps local source paths. Verification scans both the executable and extracted installer payload for local profile/build paths and forbidden debug artifacts before generating the checksum.

## Licensing, privacy, and security

CrowFlix-authored source code and documentation are licensed under [AGPL-3.0-only](LICENSE). The Crow name, mascot, icons, custom fonts, cursor artwork, and related identity assets use separate [Crow brand terms](BRAND-ASSETS.md); they are not AGPL assets.

- [Licensing details](LICENSING.md)
- [Crow brand asset inventory and terms](BRAND-ASSETS.md)
- [Complete Crow brand licence](LICENSES/LicenseRef-Crow-Brand.txt)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Privacy](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Release process](docs/RELEASING.md)

The complete Crow brand licence, brand inventory, and dependency licence texts
are bundled with release builds and published beside release installers.
