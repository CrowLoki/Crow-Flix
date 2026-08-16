# CrowFlix product roadmap

Working plan for making CrowFlix the best free streaming application anyone has
released. Crow owns direction; this document is the shared map. Each stage has
an acceptance check that must be verified before the stage is called done.

Principles that do not change:

- **Free, forever.** No accounts, no tracking, no paywalls, no ads injected by
  us. The AGPL source stays open.
- **Honest software.** Availability labels stay truthful. Errors say what
  actually happened. Nothing pretends to be signed when it is not.
- **The Crow identity is the product.** Every screen should feel like it came
  from the Crow universe, not from a template.
- **One verified stage at a time.** No stage is "done" on a green build alone;
  it is done when its acceptance check passes on the real app.

## Stage W — CrowFlix Web (worldwide, like Netflix)

CrowFlix as a website anyone can open, on Crow's Cloudflare. Not a replacement
for the desktop app — the same product, worldwide.

- [x] v1 landed 2026-08-16: real IPTV-org catalogue in the browser via a
      faithful TS port of the Rust merge pipeline (`src/webCatalog.ts` +
      tests), 12 h Cache-API offline fallback, playback/browse/search/
      favourites/zap/Web Library live. Deployed to Cloudflare Pages project
      `crow-flix-web` — https://crow-flix-web.pages.dev
- [x] CrowFlix relay (Cloudflare Worker, `crowflix-relay.djdarren2056.workers.dev`):
      live EPG on web (verified with 89 real AU channels), header-locked
      stream playback, bounded user-source fetch. Deployed and wired into the
      web build
- [ ] Web personal-source import UI wired to relay `/fetch` (needs a TS M3U
      parser — currently desktop-only)
- [ ] Custom domain when Crow picks one
- Acceptance: Crow opens the URL on his phone and watches a channel

## Stage 1 — Zap: real-TV channel behaviour

Channel surfing like hardware: channel up/down, previous channel, direct
number entry with an on-screen display.

- [x] `src/zap.ts` pure logic + unit tests
- [x] Keyboard wiring in the player: `↑`/`↓` or `PageUp`/`PageDown` surf the
      current browse context, `Backspace`/`L` returns to the previous channel,
      digits + `Enter` jump to a channel number in the visible list
- [x] On-screen zap display showing target channel and number
- Acceptance: `npm run check` passes; manual zap smoke test in `tauri:dev`

## Stage 2 — Cinematic interface overhaul

The brand is deeper than the current UI. Close that gap.

- Reference-driven visual direction (search first, no default-AI look)
- [x] First wave landed 2026-08-16: auto-hiding cinematic player chrome with
      idle detection, ambient letterbox bloom, live-signal pulses, hero
      scanlines + radar sweep, OSD/toast entrances
- [ ] Home becomes a true discovery surface: live-now rails ranked by real EPG data
- [ ] Player deep pass: backdrop tinted from the channel's own palette
- [ ] Guide becomes a full channel × time grid with proper now-line and cell states
- Acceptance: visual review sign-off by Crow; reduced-motion variant verified

## Stage 3 — Auto-updater

Features that never reach the installed app do not exist. `tauri-plugin-updater`
against GitHub Releases (`latest.json` on the release tag).

- [x] Plumbing landed 2026-08-16: plugin + minisign keypair (private key in
      git-ignored `.secrets/`), signed artifacts + `latest.json` generation in
      the release workflow, custody rules in RELEASING.md
- [ ] Crow adds `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
      (empty) as GitHub Actions secrets — release builds fail without them now
- [ ] In-app update prompt: version, notes, one click, restart
- Acceptance: build vNext, install vPrev, watch it update itself; unsigned
  Authenticode status stays honestly disclosed

## Stage 4 — Player power features

- Mini-player / always-on-top floating window
- Picture-in-Picture
- Per-channel preferred-source pinning (health data already stored)
- Persistent volume/mute, sleep timer, screenshot capture
- Acceptance: per-feature manual checks + unit tests where logic exists

## Stage 5 — Distribution beyond GitHub

- winget package manifest (free) and Scoop manifest
- Website download page stays the canonical checksum source
- Code signing stays unsigned until a real certificate exists; no self-signed
  stand-ins, per `docs/RELEASING.md`
- Acceptance: `winget install` from a clean Windows account

## Stage 6 — Cross-platform

- Linux first (same identifier is valid there); macOS needs the documented
  `com.crowflix.app` identifier migration with data continuity
- Acceptance: native install + catalogue load + playback on each target

## Stage 7 — Discovery intelligence

- Search ranking (name match > network > category), fuzzy tolerance
- "Live now" surfacing on channel cards everywhere, not just rails
- Source-health transparency: show users which source is strongest and why
- Acceptance: search/fixture tests + Crow review

## Stage 8 — Accessibility pass

- Complete keyboard operation, visible focus, ARIA audit, reduced-motion
- Acceptance: full app usable without a mouse; screen-reader smoke test

## Stage 9 — Offline and resilience polish

- Explicit offline mode with cached catalogue and clear staleness indicators
- Optional cached channel logos for the home surface
- Acceptance: airplane-mode walkthrough

## Stage 10 — Performance

- Virtualized channel grids, lazy logos, startup-time budget
- Acceptance: cold-start and scroll measurements recorded in the repo

## Explicitly not doing

- No hosting, scraping, or rebroadcasting of streams — CrowFlix stays a client
- No DRM-circumvention features, no credential sharing, no account systems
- No telemetry
