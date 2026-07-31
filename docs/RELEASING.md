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
