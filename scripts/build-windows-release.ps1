[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$rustToolchain = "1.97.0"
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$releaseTarget = [IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot "src-tauri\target\public-release")
)
$nsisBundleDirectory = [IO.Path]::GetFullPath(
    (Join-Path $releaseTarget "release\bundle\nsis")
)
$releaseTargetPrefix = $releaseTarget.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
if (-not $nsisBundleDirectory.StartsWith(
        $releaseTargetPrefix,
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to clean an NSIS bundle directory outside the dedicated release target."
}
$protectedRustVariables = @(
    "RUSTFLAGS",
    "CARGO_BUILD_RUSTFLAGS",
    "CARGO_ENCODED_RUSTFLAGS"
)
$managedVariables = @(
    "CARGO_ENCODED_RUSTFLAGS",
    "CARGO_TARGET_DIR",
    "RUSTUP_TOOLCHAIN"
)
$savedEnvironment = @{}

function Assert-NoReparsePointsBelow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string]$Candidate
    )

    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    $fullCandidate = [IO.Path]::GetFullPath($Candidate)
    $rootPrefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $fullCandidate.StartsWith(
            $rootPrefix,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Refusing to inspect a release path outside the repository."
    }

    $currentPath = $fullRoot
    $relativeComponents = $fullCandidate.Substring($rootPrefix.Length).Split(
        [char[]]@("\", "/"),
        [StringSplitOptions]::RemoveEmptyEntries
    )
    foreach ($component in $relativeComponents) {
        $currentPath = Join-Path $currentPath $component
        if (-not (Test-Path -LiteralPath $currentPath)) {
            return
        }

        $item = Get-Item -LiteralPath $currentPath -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to clean a release path containing a reparse point: $currentPath"
        }
    }
}

foreach ($name in $protectedRustVariables) {
    $existingValue = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($existingValue)) {
        throw "$name is already set. Clear custom Rust flags before producing a public release."
    }
}

foreach ($name in $managedVariables) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Add-PathRemap {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[string]]$Flags,
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if ([string]::IsNullOrWhiteSpace($Source)) {
        return
    }

    $fullSource = [IO.Path]::GetFullPath($Source).TrimEnd("\", "/")
    $variants = @(
        $fullSource,
        $fullSource.Replace("\", "/")
    ) | Select-Object -Unique

    foreach ($variant in $variants) {
        $Flags.Add("--remap-path-prefix=$variant=$Destination")
    }
}

try {
    $rustup = Get-Command "rustup.exe" -ErrorAction Stop
    $npm = Get-Command "npm.cmd" -ErrorAction Stop
    $node = Get-Command "node.exe" -ErrorAction Stop

    $installedToolchains = @(& $rustup.Source toolchain list)
    if ($LASTEXITCODE -ne 0) {
        throw "rustup could not list the installed Rust toolchains."
    }
    if (-not ($installedToolchains | Where-Object { $_ -match "^1\.97\.0(?:-|$)" })) {
        throw "Rust $rustToolchain is required but is not installed. Install it explicitly before building the public release."
    }

    [Environment]::SetEnvironmentVariable("RUSTUP_TOOLCHAIN", $rustToolchain, "Process")

    $rustVersion = (& rustc --version)
    if ($LASTEXITCODE -ne 0 -or $rustVersion -notmatch "^rustc 1\.97\.0(?:\s|$)") {
        throw "Expected Rust 1.97.0, but rustc reported: $rustVersion"
    }

    $userProfile = [Environment]::GetEnvironmentVariable("USERPROFILE", "Process")
    $cargoHome = [Environment]::GetEnvironmentVariable("CARGO_HOME", "Process")
    $rustupHome = [Environment]::GetEnvironmentVariable("RUSTUP_HOME", "Process")

    if ([string]::IsNullOrWhiteSpace($cargoHome) -and -not [string]::IsNullOrWhiteSpace($userProfile)) {
        $cargoHome = Join-Path $userProfile ".cargo"
    }
    if ([string]::IsNullOrWhiteSpace($rustupHome) -and -not [string]::IsNullOrWhiteSpace($userProfile)) {
        $rustupHome = Join-Path $userProfile ".rustup"
    }

    # rustc applies the last matching remap, so order these from broadest to
    # most specific. This keeps registry host directories out of the binary.
    $pathRemaps = [System.Collections.Generic.List[string]]::new()
    Add-PathRemap -Flags $pathRemaps -Source $userProfile -Destination "/build/home"
    Add-PathRemap -Flags $pathRemaps -Source $cargoHome -Destination "/cargo"
    Add-PathRemap -Flags $pathRemaps -Source $rustupHome -Destination "/rustup"
    if (-not [string]::IsNullOrWhiteSpace($cargoHome)) {
        Add-PathRemap -Flags $pathRemaps -Source (Join-Path $cargoHome "registry\src") -Destination "/rust/deps"
        Add-PathRemap -Flags $pathRemaps -Source (Join-Path $cargoHome "git\checkouts") -Destination "/rust/git-deps"
    }
    Add-PathRemap -Flags $pathRemaps -Source $repositoryRoot -Destination "/workspace/Crow-Flix"
    $pathRemaps.Add("--remap-path-scope=all")

    $encodedFlags = [string]::Join([char]0x1F, $pathRemaps)
    [Environment]::SetEnvironmentVariable("CARGO_ENCODED_RUSTFLAGS", $encodedFlags, "Process")
    [Environment]::SetEnvironmentVariable("CARGO_TARGET_DIR", $releaseTarget, "Process")

    Push-Location $repositoryRoot
    try {
        Write-Host "Checking release-version consistency..."
        & $node.Source (Join-Path $repositoryRoot "scripts\check-release-version.mjs")
        if ($LASTEXITCODE -ne 0) {
            throw "Release-version consistency validation failed."
        }

        Write-Host "Checking committed third-party notices..."
        & $npm.Source run notices:check
        if ($LASTEXITCODE -ne 0) {
            throw "Third-party notice validation failed."
        }

        if (Test-Path -LiteralPath $nsisBundleDirectory) {
            Assert-NoReparsePointsBelow `
                -Root $repositoryRoot `
                -Candidate $nsisBundleDirectory
            $bundleItem = Get-Item -LiteralPath $nsisBundleDirectory -Force
            if (-not $bundleItem.PSIsContainer) {
                throw "Expected the generated NSIS bundle path to be a directory."
            }
            if ($bundleItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to clean a reparse point at the generated NSIS bundle path."
            }

            Write-Host "Clearing the generated NSIS bundle output..."
            Remove-Item -LiteralPath $nsisBundleDirectory -Recurse -Force
        }

        Write-Host "Building the Windows NSIS release with remapped source paths..."
        & $npm.Source run tauri -- build --bundles nsis -- --locked
        if ($LASTEXITCODE -ne 0) {
            throw "The Tauri release build failed."
        }
    }
    finally {
        Pop-Location
    }

    $installers = @(
        Get-ChildItem -LiteralPath $nsisBundleDirectory `
            -Filter "*.exe" -File -ErrorAction Stop
    )
    if ($installers.Count -ne 1) {
        throw "Expected exactly one NSIS installer, but found $($installers.Count)."
    }

    Write-Host "Release build completed."
    Write-Host "Installer: $($installers[0].FullName)"
    Write-Host "Run 'npm run release:verify' before publishing it."
}
finally {
    foreach ($name in $managedVariables) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
    }
}
