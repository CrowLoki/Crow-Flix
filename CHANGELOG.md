# Changelog

All notable changes to CrowFlix are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No unreleased changes are currently recorded.

## [0.5.0] - 2026-07-31

### Added

- Public licensing, brand, privacy, security, contribution, release, and
  dependency-notice documentation.
- Explicit size and count limits for imported M3U playlists and XMLTV guides.
- Reproducible Windows release-build and release-verification commands.
- Checksum generation and release-package inspection for public downloads.
- In-application project, licence, privacy, and source information.

### Changed

- Updated package, Rust, and Tauri metadata for the public CrowFlix release.
- Upgraded the XML parser to the maintained `quick-xml` 0.41 series.
- Reduced the default Web Library to independently maintained directory pages;
  users can still add their own destinations.
- Hardened catalogue and playback fallback handling for stale or failed channel
  sources.

### Security

- Bounded playlist downloads, XMLTV transfers, decompression, parsed entries,
  programme records, channel identifiers, and text fields.
- Rejected unsupported or credential-bearing external URLs before retrieval.
- Added deterministic dependency-licence inventory and public release checks.

### Removed

- The bundled snapshot of individual provider destinations whose upstream
  redistribution terms were not explicit.
- Internal design-review images and machine-specific development evidence from
  the public source release.

## [0.4.2] - 2026-07-31

### Fixed

- Repaired stale IPTV playback sources and improved deterministic fallback
  selection.
- Stabilised catalogue merging and regional playback behaviour.

## [0.4.1] - 2026-07-30

### Changed

- Versioned the Windows package following the 0.4.0 application update.

## [0.4.0] - 2026-07-30

### Added

- Resilient multi-source playback and user-managed Web Library features.
- Crow mascot, Crow Bitfeather typography, Crow Talon cursors, and generated
  application icons.

## [0.3.0] - 2026-07-30

### Added

- Initial CrowFlix Tauri, React, TypeScript, and Rust source release.
