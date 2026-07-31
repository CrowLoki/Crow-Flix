# Security policy

## Supported versions

Security fixes are made for the latest tagged CrowFlix release. Older releases,
development snapshots, and unofficial forks are not supported by the CrowFlix
project.

Before reporting a problem, reproduce it with the latest release when it is
safe to do so. Do not test against systems, streams, accounts, or data that you
do not own or have permission to test.

## Report a vulnerability privately

Do not disclose a suspected vulnerability in a public issue, discussion,
pull request, screenshot, log, or playlist.

Use GitHub’s private security-advisory form:

<https://github.com/CrowLoki/Crow-Flix/security/advisories/new>

Include only what is necessary to reproduce and assess the problem:

- the affected CrowFlix version and Windows version;
- the security impact and the conditions needed to trigger it;
- minimal reproduction steps or a small, non-sensitive test file;
- whether the problem has already been disclosed elsewhere; and
- any suggested mitigation.

Remove credentials, access tokens, cookies, private playlist URLs, personal
data, and third-party content from the report. If a secret may have been
exposed, revoke or rotate it before reporting.

The project aims to acknowledge a complete report within seven days and to
provide a status update within fourteen days. These are targets, not a
guarantee. Please allow a reasonable period for investigation and a coordinated
release before public disclosure.

## In scope

Examples of in-scope issues include:

- code execution, privilege escalation, or sandbox escape caused by CrowFlix;
- unsafe handling of M3U, XMLTV, media manifests, or imported URLs;
- unintended disclosure of locally stored CrowFlix data;
- release-package tampering or a reproducible dependency-chain compromise; and
- a bypass of CrowFlix’s documented URL or resource limits.

Channel downtime, geographic restrictions, a third-party website’s behaviour,
copyright disputes, and vulnerabilities that exist only in an independent
streaming service are not CrowFlix security vulnerabilities. Report those to
the service that controls the affected system.

## Safe handling

CrowFlix treats playlists, programme guides, media manifests, and web
destinations as untrusted input. Reporters should use synthetic fixtures and
local test servers wherever possible. Never include real paid credentials or
private subscription data in a test case.

Official release notes state whether an installer is code-signed. A checksum or
provenance attestation helps verify downloaded bytes but does not replace a
trusted Windows code signature. Verify release assets against the information
published in the same GitHub release.

## Public fixes

After a fix is available, the project may publish a GitHub security advisory
describing the affected versions, impact, mitigation, and credit requested by
the reporter. Sensitive exploit details may remain private until users have had
time to update.
