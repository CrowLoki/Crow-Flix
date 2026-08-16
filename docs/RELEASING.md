# Releasing CrowFlix for Windows

This checklist is for a public CrowFlix release. A successful build is not by
itself a release: the source state, dependency notices, installer contents,
checksum, signature status, GitHub assets, and download page must all agree.

## 1. Prepare the source state

1. Work from the public `CrowLoki/Crow-Flix` repository.
2. Confirm the worktree is clean and the intended release commit is on the
   protected default branch.
3. Confirm the same version appears in:
   - `package.json`
   - the root entry in `package-lock.json`
   - `src-tauri/Cargo.toml`
   - the CrowFlix entry in `src-tauri/Cargo.lock`
   - `src-tauri/tauri.conf.json`
4. Update `CHANGELOG.md`, user documentation, and any privacy or security
   notices affected by the release.
5. Confirm the release contains no private repository history, credentials,
   personal paths, logs, internal review artifacts, or generated build output.

Never move a release secret, signing key, certificate password, token, or
personal playlist into the repository or a command line recorded by CI.

### Stable application identity

Keep the existing `com.crowflix.app` identifier for Windows releases. Tauri
warns about the `.app` suffix because it is unsuitable for a future macOS
bundle, but the identifier also determines CrowFlix application-data paths and
the Windows installer identity. Changing it without a tested migration would
separate an update from existing local data. Any future cross-platform
identifier migration must preserve Windows upgrade and data continuity before
the identifier changes.

## 2. Reproduce dependencies and notices

Install dependencies only from the committed lockfiles:

```powershell
npm ci
```

Regenerate the dependency inventory and verify that it is deterministic:

```powershell
npm run notices
npm run notices:check
```

Review changes to `THIRD_PARTY_NOTICES.md` and
`THIRD_PARTY_LICENSES.txt`. Resolve missing or unclear dependency licences
before release.

## 3. Run source checks

```powershell
npm run check
npm run test:rust
```

The Rust catalogue integration test requires network access. Record a genuine
network outage as an unverified result; do not convert it into a passing check.
All deterministic checks must pass.

Review the production dependency audit and the GitHub security checks for the
release commit. A known exploitable vulnerability blocks the release until it
is fixed or a documented, evidence-based determination shows it cannot affect
CrowFlix.

## 4. Build without workstation paths

Use the release wrapper from the repository root:

```powershell
npm run release:build
```

The wrapper builds with the committed Cargo lockfile in a dedicated release
target and remaps local Rust source paths. Do not replace it with an ad hoc
build for a public asset.

## 5. Sign when a trusted certificate is available

Windows code signing requires a currently valid certificate and private key
controlled outside the repository.

If an authorised trusted certificate is available:

1. sign the final executable and installer using the approved protected
   signing process;
2. timestamp the signature using the certificate provider’s trusted timestamp
   service;
3. verify the signature and certificate chain on a clean Windows system; and
4. generate the checksum only after signing.

If no trusted certificate is available, leave the installer unsigned. Never
substitute a self-signed certificate or describe an unsigned installer as
signed. The release notes and download page must say plainly that it is
unsigned. A SHA-256 checksum and build-provenance attestation improve integrity
verification but do not create publisher identity or suppress Windows
SmartScreen warnings.

## 6. Verify the package

After any signing step, run:

```powershell
npm run release:verify
```

The verification must inspect the executable and extracted installer contents,
reject workstation paths and prohibited development artifacts, report the
Authenticode status, and create the SHA-256 sidecar only after the checks pass.

Manually confirm:

- product name, version, icon, publisher text, and install scope are correct;
- `LICENSE`, `LICENSING.md`, `BRAND-ASSETS.md`,
  `LICENSES/LicenseRef-Crow-Brand.txt`, `PRIVACY.md`, and dependency notices
  are included where the bundle configuration requires them;
- no `.pdb`, source map, log, token, key, or credential file is present;
- CodeQL has completed with the extended query suite and the
  `remote_and_local` threat model, with no open findings; a dismissal requires
  evidence in the alert explaining why the reported path is unreachable or
  non-security-relevant;
- the installed application launches, loads its catalogue, imports small
  synthetic M3U/XMLTV fixtures, and reports a controlled error for an
  over-limit fixture; and
- uninstalling the test release does not delete unrelated user files.

Test installation in a disposable Windows account or virtual machine. Do not
replace a user’s existing CrowFlix installation as part of release validation.

## 7. Tag and publish

1. Create an annotated `vX.Y.Z` tag at the verified public release commit.
2. Push the commit and tag to the public repository.
3. Wait for the release workflow, CI, dependency audit, and provenance job to
   finish successfully.
4. Publish only these reviewed artifacts:
   - the Windows installer;
   - its `.sha256` sidecar;
   - build provenance generated by the trusted CI workflow;
   - `LICENSE`;
   - `LICENSING.md`;
   - `BRAND-ASSETS.md`;
   - `LICENSES/LicenseRef-Crow-Brand.txt`;
   - `THIRD_PARTY_NOTICES.md`; and
   - `THIRD_PARTY_LICENSES.txt`.
5. In the release notes, state the exact version, commit, supported Windows
   architecture, signature status, checksum, known limitations, and changes
   from `CHANGELOG.md`.

Do not publish an installer produced from a different commit, a dirty worktree,
or an unreviewed workflow rerun.

## 8. Verify the public path

Download the assets from the published GitHub release rather than using the
local build:

1. recompute SHA-256 and compare it with the published sidecar;
2. inspect Authenticode status and confirm it matches the release statement;
3. perform a clean install, launch, playback smoke test, and uninstall;
4. update the official CrowFlix download page to the new release URL and
   checksum; and
5. verify the production page in a fresh browser session.

Keep the previous known-good release available until these checks pass. If a
security or packaging fault is found, remove the affected download, explain the
impact, correct the source, and publish a new version; never silently replace
bytes under an existing version.

## 9. Auto-updates

CrowFlix ships the Tauri updater plugin. Installed copies check
`https://github.com/CrowLoki/Crow-Flix/releases/latest/download/latest.json`
for a newer release, download the NSIS installer listed there, verify its
minisign signature against the public key baked into
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), and only then run it.

Updater signatures prove update integrity between CrowFlix releases; they are
not Authenticode publisher identity and do not remove SmartScreen warnings.

### Key custody

The updater keypair was generated with the Tauri CLI:

```powershell
npx @tauri-apps/cli signer generate -w .secrets/tauri-updater.key
```

- The private key lives only at `.secrets/tauri-updater.key` (ignored by git
  via the `.secrets/` entry in `.gitignore`) and as a GitHub Actions secret.
  NEVER commit it, copy it into the repository outside `.secrets/`, or paste
  it into a command line recorded by CI logs.
- The local key has an empty password so it can be used non-interactively.
  Tradeoff: anyone who obtains the `.secrets/tauri-updater.key` file can sign
  updates as CrowFlix, so protect the workstation copy accordingly. To use a
  password instead, regenerate with `-p` or `signer generate` interactively
  and store the password in the password secret below.
- The public key (`.secrets/tauri-updater.key.pub`) is not secret; its
  contents are committed in `src-tauri/tauri.conf.json` as
  `plugins.updater.pubkey`. The private key and the configured public key must
  stay in sync, or update checks at runtime will reject new releases.

### Required GitHub secrets

Before tagging a release, add these repository secrets under
Settings → Secrets and variables → Actions:

- `TAURI_SIGNING_PRIVATE_KEY` — the full text contents of
  `.secrets/tauri-updater.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the key password, or an empty string
  for the current passwordless key.

The release workflow passes both to `npm run release:build`. Without
`TAURI_SIGNING_PRIVATE_KEY` the Tauri bundler refuses to finish a build that
has updater artifacts enabled, so the workflow fails instead of publishing
unsigned update artifacts. The same applies to a local
`npm run release:build`: set `TAURI_SIGNING_PRIVATE_KEY` to the key contents
or to the path of `.secrets/tauri-updater.key` in that shell first.

### How latest.json is produced and uploaded

`tauri.conf.json` sets `bundle.createUpdaterArtifacts: true`, so the release
build signs the NSIS installer with the updater key and writes
`<installer>.exe.sig` next to it in the NSIS bundle directory. The release
workflow's "Generate updater manifest" step then writes `latest.json`
(version, publication date, and the `windows-x86_64` platform entry with the
installer download URL and signature) into the same directory. The "Collect
release assets" step fails the release if either file is missing, copies both
into `release-assets/`, and the publish step uploads them with the installer,
its `.sha256` sidecar, and the legal files. The updater endpoint path
`releases/latest/download/latest.json` always resolves to the manifest of the
most recent published release, so no per-version endpoint change is needed.

Only releases built with this wiring can auto-update. Older versions without
the updater plugin keep requiring a manual installer download.

### If the private key is lost or compromised

Rotate it:

1. Generate a new keypair with the signer command above.
2. Replace `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` with the
   new public key.
3. Replace the `TAURI_SIGNING_PRIVATE_KEY` (and, if used,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) GitHub secrets.
4. Publish a new release signed with the new key.

Installs built with the old public key then fail the update signature check
cleanly and stay on their current version; their users reinstall from the
latest published installer. If the key was compromised, also remove the
affected release assets so no update signed with the leaked key remains
downloadable.
