# CrowFlix privacy notice

Last updated: 31 July 2026

This notice describes the CrowFlix desktop application and the official
CrowFlix source repository. It does not cover independent websites, catalogues,
programme guides, media hosts, or streams that CrowFlix can open.

## CrowFlix does not operate an account service

CrowFlix has no CrowFlix account, advertising system, analytics SDK, telemetry
service, or CrowFlix-operated media proxy. The application does not send usage
history to a CrowFlix server.

This means the project does not centrally receive a list of what a user
searches for, favourites, opens, or watches. It does not mean that network use
is anonymous: every independent service contacted by the application can
observe the request it receives.

## Data stored on the device

CrowFlix stores application preferences locally, including:

- favourite and recently opened channel identifiers;
- user-added Web Library destinations;
- observed source-health, cooldown, and preferred-source identifiers used for
  playback failover; and
- a cache of retrieved catalogue metadata used for startup and offline
  fallback.

Guide data can also be held in memory while the application is running.
Imported playlist and XMLTV files are parsed locally. CrowFlix does not upload
those files to a CrowFlix-operated service.

Local WebView and operating-system components may maintain ordinary caches,
network state, or diagnostic records outside CrowFlix’s own data structures.
Anyone with access to the Windows account or its backups may be able to inspect
locally stored CrowFlix data.

Closing CrowFlix stops the current session but does not erase saved favourites,
recent items, Web Library destinations, or the catalogue cache. To remove all
such data, close CrowFlix and clear its application data using Windows or remove
the CrowFlix application-data directory. Back up anything you want to retain
before doing so.

## Network connections

Depending on the feature used, CrowFlix can connect directly to:

- IPTV-org catalogue and playlist endpoints;
- optional ApsatTV playlist endpoints;
- EPGShare and GitHub-hosted XMLTV programme guides;
- channel-logo hosts;
- media hosts, content-delivery networks, and redirect targets named by a
  playlist or catalogue;
- a playlist, programme guide, or Web Library destination supplied by the
  user; and
- GitHub pages used for project, licence, security, or release information.

The Web Library opens a selected destination outside the CrowFlix interface.
The browser and destination then apply their own storage and privacy rules.

An endpoint can ordinarily receive the user’s IP address, request time,
requested URL, CrowFlix or media-player user agent, and other standard protocol
headers. A playlist may specify a referrer or user-agent header needed for a
source; CrowFlix can send those values to the named media host. Do not import a
playlist containing credentials or private URLs unless you trust the source and
understand where its requests go.

CrowFlix does not control what an independent endpoint records, combines, or
retains. Review that endpoint’s privacy policy and terms before using it.

## Repository and release services

GitHub processes information when someone visits the repository, downloads a
release, opens an issue, submits a pull request, or uses private vulnerability
reporting. GitHub’s own privacy terms govern that processing.

Release downloads may also be delivered through GitHub’s content-delivery
infrastructure or an official project download page. Those services receive the
network information needed to provide the download.

## Changes to this notice

Material privacy changes are documented in the repository and release notes.
The date at the top identifies the current revision.
