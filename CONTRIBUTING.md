# Contributing to CrowFlix

Thank you for helping improve CrowFlix. Contributions should keep the desktop
application reliable, reviewable, lawful to redistribute, and safe with
untrusted playlists and guide data.

## Before opening work

- Search existing issues and pull requests for the same problem.
- Use a public issue for ordinary bugs and feature requests.
- Report vulnerabilities privately as described in
  [`SECURITY.md`](SECURITY.md).
- Do not post credentials, private playlist URLs, cookies, access tokens,
  personal data, or copyrighted media in an issue or fixture.

For a substantial feature or architectural change, open a focused proposal
before investing in an implementation. Explain the user problem and the
smallest outcome that would solve it.

## Development setup

CrowFlix uses Tauri 2, Rust, React, TypeScript, Vite, and npm.

1. Install the Rust and Node.js versions used by the current CI workflow.
2. Install JavaScript dependencies from the committed lockfile:

   ```powershell
   npm ci
   ```

3. Start the isolated desktop development application:

   ```powershell
   npm run tauri:dev
   ```

Do not develop against or replace an installed CrowFlix release. The Tauri
development application and installed application have different purposes and
should remain separate.

## Required checks

Run the checks relevant to the files you changed. Before requesting a merge,
the normal complete set is:

```powershell
npm run check
npm run test:rust
```

The catalogue integration test requires network access. If a check cannot run,
state exactly which check was skipped and why in the pull request.

When dependencies or licence files change, regenerate and verify the notices:

```powershell
npm run notices
npm run notices:check
```

Do not manually edit generated dependency notices.

## Change standards

- Keep a pull request focused on one coherent outcome.
- Add or update tests for changed behaviour, including failure and boundary
  cases.
- Preserve user changes and avoid unrelated formatting or generated-file
  churn.
- Do not commit `node_modules`, `dist`, Rust build output, generated Tauri
  schemas, logs, local caches, installers, or personal filesystem paths.
- Do not weaken input limits, URL validation, content-security controls, or
  release verification without documenting the security reasoning and adding
  tests.
- Keep `package-lock.json` and `src-tauri/Cargo.lock` synchronized with their
  manifests.
- Update user-facing documentation and `CHANGELOG.md` when behaviour changes.

## Third-party data and dependencies

Every new dependency must have a clear purpose, maintained source, compatible
licence, and lockfile entry. Prefer a small implementation over a dependency
that adds disproportionate supply-chain risk.

Do not copy or bundle provider directories, playlists, channel logos, guide
data, media, code, fonts, or other material unless its licence permits
redistribution in this repository. Linking to or letting a user import an
independent source does not make that material part of CrowFlix.

Fixtures must be synthetic, minimal, and free of live credentials and personal
data.

## Licensing and brand

By submitting a contribution to AGPL-covered files, you represent that you have
the right to provide it under `AGPL-3.0-only`. See
[`LICENSING.md`](LICENSING.md).

The Crow mascot, fonts, cursors, and derived icons are separately licensed.
Do not add, replace, or modify a brand asset without Crow’s explicit approval.
A software contribution does not grant permission to reuse the Crow identity
in another project or fork.

## Pull-request checklist

A ready pull request should explain:

- what changed and why;
- the security, privacy, compatibility, and licensing effects;
- the exact checks run and their results;
- screenshots only when they materially demonstrate an interface change; and
- any limitation or result that could not be verified.

Review feedback should address the code and evidence. Be direct, specific, and
respectful to everyone participating.
