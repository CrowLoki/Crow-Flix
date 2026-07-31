# CrowFlix brand assets

Copyright (C) 2026 Crow.

The Crow mascot, Crow head, Crow Bitfeather fonts, Crow Talon cursors, and
derived application icons form the CrowFlix visual identity. Crow supplied and
approved these assets for CrowFlix. Copyright remains Crow.

These files are not licensed under the GNU Affero General Public License. They
are licensed only under the project’s custom `LicenseRef-Crow-Brand` terms:

- [`LICENSES/LicenseRef-Crow-Brand.txt`](LICENSES/LicenseRef-Crow-Brand.txt)
- [`LICENSING.md`](LICENSING.md)

## Asset inventory

### Approved mascot and icon

- `public/assets/brand/crow-mascot.png` is the approved Crow mascot master.
- `public/assets/brand/crow-head.png` is a transparent, faithful crop of the
  same approved master, made for legibility at application and favicon sizes.
- `src-tauri/icons/**` is generated from `crow-head.png` for Windows and the
  other platform icon formats supported by Tauri.

### Crow Bitfeather v0.3.0

`public/assets/brand/fonts` contains the four WOFF2 files selected from the
Crow Bitfeather Windows v0.3.0 pack:

- Crow Bitfeather Display Regular
- Crow Bitfeather Display Bold
- Crow Bitfeather Mono Regular
- Crow Bitfeather Mono Bold

Source archive SHA-256:
`59DC92DAD1C9E9995AB49B2FA2BA5526C967B2EC61512F9CAA4EFE8134B08222`

The supplied pack includes its deterministic generator and the original
CrowClaw letterform-audition geometry used for the approved Bitfeather
direction. The generator constructs orthogonal polygon outlines from that
project-owned geometry and does not read a third-party font, bitmap alphabet,
or font outline. Its package manifest records these exact WOFF2 hashes:

| File | SHA-256 |
| --- | --- |
| `CrowBitfeatherDisplay-Regular.woff2` | `32ACC84B70DB3AEC0670F0F5EC4D82444D62B1EFAC9DCB580FF9F038678F8D93` |
| `CrowBitfeatherDisplay-Bold.woff2` | `620595684FEB9FAF562F9B8ECDB1239A6A041B69D9DC2441DABCB81219D74588` |
| `CrowBitfeatherMono-Regular.woff2` | `F6E188DFC90CE3B38805B503D53C1738B7356550658E0C19F5F2F6D9249FCEC5` |
| `CrowBitfeatherMono-Bold.woff2` | `0E07A9AFB8F6A06FD7420432C770CC5EA71BCE6B5D33519E08F34ADBB580ECF2` |

CrowFlix uses Inter and system-font fallbacks for characters outside the Crow
Bitfeather coverage and for long-form interface text. The application does not
install the fonts into Windows.

### Crow Talon v0.5.0

`public/assets/brand/cursors` contains 15 static, multi-resolution Windows CUR
files and corresponding 32-pixel PNG fallbacks selected from the Crow Talon
Windows v0.5.0 pack.

Source archive SHA-256:
`CB81F4CCB7484D92AC0CCA9346614FB613A9F90E919E926A5130DE1DCFAE035C`

CrowFlix loads these pointers through CSS only inside the application. It does
not bundle or run the source pack’s Windows installer, INF file, registry
changes, or system-wide activation. Static Busy and Working roles are used
instead of ANI files because WebView animation support is not consistent.

## Original supplied-pack provenance notice

Both the supplied Bitfeather and Talon packs contain the following identical
notice. It is retained verbatim here as the packs’ existing copyright and
provenance notice. Crow’s `LicenseRef-Crow-Brand` terms are the additional,
CrowFlix-specific permissions and restrictions for the copies in this project.

```text
# Crow Brand System asset notice

Copyright (c) 2026 Crow.

Crow explicitly approved publication of this `0.1.0` brand-system preview as
part of the public Crow-GodMod3 project.

The original Crow mascot artwork, Crow Signal fonts, Crow Talon cursors, marks,
backgrounds, product variants, social artwork and related brand assets remain
copyright Crow. They are published here for use with and development of
Crow-GodMod3. No separate permission is granted to use the Crow identity as an
endorsement, impersonate Crow, or claim ownership of the brand.

The Crow-GodMod3 software and its G0DM0D3 derivative source remain licensed
under GNU AGPL-3.0 as described by the repository root licence. No third-party
font, cursor, stock-asset or mascot licence is incorporated into this pack.
```

## Attribution for permitted redistribution

When the custom licence permits redistribution, keep this file and the
following notice with the assets:

> CrowFlix includes Crow brand assets. Copyright (C) 2026 Crow. Used under
> LicenseRef-Crow-Brand.

Do not remove embedded copyright or provenance metadata where it exists.

## Forks and remixes

The source-code licence allows the software to be studied, modified, and
redistributed. It does not grant the same rights in the Crow visual identity.
Before publicly distributing a fork, replace the files under
`public/assets/brand` and `src-tauri/icons` with assets you have permission to
use, and remove Crow branding that could suggest an official CrowFlix release
or Crow’s endorsement.

Questions about a use outside the written brand licence require Crow’s explicit
permission before that use occurs.
