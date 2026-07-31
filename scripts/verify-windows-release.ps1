[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$ExecutablePath,
    [switch]$RequireSignature
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$releaseDirectory = Join-Path $repositoryRoot "src-tauri\target\public-release\release"
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)

function Resolve-ReleaseFile {
    param(
        [string]$SuppliedPath,
        [string]$DefaultPath,
        [string]$Description
    )

    $candidate = if ([string]::IsNullOrWhiteSpace($SuppliedPath)) {
        $DefaultPath
    }
    elseif ([IO.Path]::IsPathRooted($SuppliedPath)) {
        $SuppliedPath
    }
    else {
        Join-Path $repositoryRoot $SuppliedPath
    }

    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$Description was not found: $candidate"
    }
    return [IO.Path]::GetFullPath($candidate)
}

function Get-DefaultInstaller {
    $nsisDirectory = Join-Path $releaseDirectory "bundle\nsis"
    if (-not (Test-Path -LiteralPath $nsisDirectory -PathType Container)) {
        throw "NSIS output directory was not found. Run 'npm run release:build' first."
    }

    $candidates = @(
        Get-ChildItem -LiteralPath $nsisDirectory -Filter "*.exe" -File |
            Where-Object { $_.Name -match "(?i)setup" }
    )
    if ($candidates.Count -ne 1) {
        throw "Expected exactly one NSIS setup executable, but found $($candidates.Count)."
    }
    return $candidates[0].FullName
}

function New-ForbiddenPatterns {
    $patterns = [System.Collections.Generic.List[object]]::new()
    $patterns.Add([pscustomobject]@{
        Name = "Windows user-profile path"
        Regex = [regex]::new("[A-Za-z]:[\\/]+Users[\\/]+[^\\/\x00]+", "IgnoreCase,CultureInvariant")
    })
    $patterns.Add([pscustomobject]@{
        Name = "Cargo registry or Git checkout path"
        Regex = [regex]::new("(?:[\\/]\.cargo[\\/](?:registry|git)[\\/]|registry[\\/]src[\\/](?:github\.com|index\.crates\.io)-[0-9a-f]+)", "IgnoreCase,CultureInvariant")
    })
    $patterns.Add([pscustomobject]@{
        Name = "GitHub access token"
        Regex = [regex]::new("(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})", "CultureInvariant")
    })
    $patterns.Add([pscustomobject]@{
        Name = "OpenAI API key"
        Regex = [regex]::new("sk-(?:proj-)?[A-Za-z0-9_-]{20,}", "CultureInvariant")
    })
    $patterns.Add([pscustomobject]@{
        Name = "AWS access key"
        Regex = [regex]::new("AKIA[0-9A-Z]{16}", "CultureInvariant")
    })
    $patterns.Add([pscustomobject]@{
        Name = "PEM private key"
        Regex = [regex]::new("-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "CultureInvariant")
    })

    $sensitivePaths = @(
        $repositoryRoot,
        [Environment]::GetEnvironmentVariable("USERPROFILE", "Process"),
        [Environment]::GetEnvironmentVariable("CARGO_HOME", "Process"),
        [Environment]::GetEnvironmentVariable("RUSTUP_HOME", "Process")
    )
    foreach ($path in $sensitivePaths) {
        if ([string]::IsNullOrWhiteSpace($path)) {
            continue
        }

        $fullPath = [IO.Path]::GetFullPath($path).TrimEnd("\", "/")
        foreach ($variant in @($fullPath, $fullPath.Replace("\", "/")) | Select-Object -Unique) {
            $patterns.Add([pscustomobject]@{
                Name = "local build path"
                Regex = [regex]::new([regex]::Escape($variant), "IgnoreCase,CultureInvariant")
            })
        }
    }
    return $patterns
}

function Test-FileContents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [object[]]$Patterns,
        [Parameter(Mandatory = $true)]
        [string]$DisplayName
    )

    $bytes = [IO.File]::ReadAllBytes($Path)
    $ascii = [Text.Encoding]::ASCII.GetString($bytes)
    $utf16 = [Text.Encoding]::Unicode.GetString($bytes)

    foreach ($pattern in $Patterns) {
        if ($pattern.Regex.IsMatch($ascii) -or $pattern.Regex.IsMatch($utf16)) {
            throw "Forbidden release data ($($pattern.Name)) was found in $DisplayName."
        }
    }
}

function Test-Signature {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$DisplayName
    )

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $script:signToolPath
    $startInfo.Arguments = "verify /pa /all /v `"$Path`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $signatureProcess = New-Object Diagnostics.Process
    $signatureProcess.StartInfo = $startInfo
    try {
        if (-not $signatureProcess.Start()) {
            throw "Could not start signtool.exe."
        }
        $signatureStandardOutput = $signatureProcess.StandardOutput.ReadToEnd()
        $signatureStandardError = $signatureProcess.StandardError.ReadToEnd()
        $signatureProcess.WaitForExit()
        $signatureExitCode = $signatureProcess.ExitCode
    }
    finally {
        $signatureProcess.Dispose()
    }

    if ($signatureExitCode -eq 0) {
        Write-Host "$DisplayName Authenticode signature: valid."
        return $true
    }

    $signatureMessage = "$signatureStandardOutput`n$signatureStandardError"
    if ($signatureMessage -match "(?i)(no signature found|is not signed)") {
        if ($RequireSignature) {
            throw "$DisplayName is not Authenticode-signed, but -RequireSignature was requested."
        }
        Write-Warning "$DisplayName is NOT Authenticode-signed. Publish this status clearly with the checksum and GitHub provenance."
        return $false
    }

    throw "$DisplayName failed Authenticode verification with signtool exit code $signatureExitCode."
}

function Find-SignTool {
    $command = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)", "Process")
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $kitsDirectory = Join-Path $programFilesX86 "Windows Kits\10\bin"
        if (Test-Path -LiteralPath $kitsDirectory -PathType Container) {
            $candidates = @(
                Get-ChildItem -LiteralPath $kitsDirectory -Directory |
                    Sort-Object Name -Descending |
                    ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
                    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
            )
            if ($candidates.Count -gt 0) {
                return $candidates[0]
            }
        }
    }

    throw "Windows signtool.exe is required to verify Authenticode status but was not found."
}

function Get-Sha256Hex {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $algorithm.ComputeHash($stream)
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
    return -join ($digest | ForEach-Object { $_.ToString("x2") })
}

$defaultInstaller = Get-DefaultInstaller
$installer = Resolve-ReleaseFile -SuppliedPath $InstallerPath -DefaultPath $defaultInstaller -Description "NSIS installer"
$executable = Resolve-ReleaseFile -SuppliedPath $ExecutablePath -DefaultPath (Join-Path $releaseDirectory "crowflix.exe") -Description "CrowFlix executable"
$script:signToolPath = Find-SignTool

$package = Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json
$escapedVersion = [regex]::Escape([string]$package.version)
if ([IO.Path]::GetFileName($installer) -notmatch $escapedVersion) {
    throw "Installer filename does not contain the package version $($package.version)."
}

$patterns = @(New-ForbiddenPatterns)
Test-FileContents -Path $executable -Patterns $patterns -DisplayName "crowflix.exe"
Test-FileContents -Path $installer -Patterns $patterns -DisplayName ([IO.Path]::GetFileName($installer))

$sevenZipCommand = Get-Command "7z.exe" -ErrorAction SilentlyContinue
if ($null -eq $sevenZipCommand) {
    $standardSevenZip = "C:\Program Files\7-Zip\7z.exe"
    if (Test-Path -LiteralPath $standardSevenZip -PathType Leaf) {
        $sevenZipPath = $standardSevenZip
    }
    else {
        throw "7-Zip is required to inspect the NSIS payload but 7z.exe was not found."
    }
}
else {
    $sevenZipPath = $sevenZipCommand.Source
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\") + "\"
$tempDirectory = [IO.Path]::GetFullPath(
    (Join-Path $tempBase ("CrowFlix-release-verify-" + [guid]::NewGuid().ToString("N")))
)
if (-not $tempDirectory.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create a verification directory outside the system temporary directory."
}

New-Item -ItemType Directory -Path $tempDirectory -ErrorAction Stop | Out-Null
try {
    $extractOutput = & $sevenZipPath x "-o$tempDirectory" -y $installer 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "7-Zip could not inspect the NSIS installer: $($extractOutput | Select-Object -Last 5)"
    }

    $nestedArchives = @(
        Get-ChildItem -LiteralPath $tempDirectory -Recurse -File -Filter "*.7z"
    )
    foreach ($archive in $nestedArchives) {
        $nestedDirectory = Join-Path $archive.DirectoryName ($archive.BaseName + "-expanded")
        New-Item -ItemType Directory -Path $nestedDirectory -ErrorAction Stop | Out-Null
        $nestedOutput = & $sevenZipPath x "-o$nestedDirectory" -y $archive.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "7-Zip could not inspect nested payload $($archive.Name): $($nestedOutput | Select-Object -Last 5)"
        }
    }

    $payloadFiles = @(
        Get-ChildItem -LiteralPath $tempDirectory -Recurse -File
    )
    if ($payloadFiles.Count -eq 0) {
        throw "The NSIS installer extraction produced no files."
    }

    $forbiddenFiles = @(
        $payloadFiles | Where-Object {
            $_.Name -match "(?i)\.(?:pdb|map|log|env|pem|key|pfx|p12)$" -or
            $_.Name -match "(?i)^id_(?:rsa|dsa|ecdsa|ed25519)$"
        }
    )
    if ($forbiddenFiles.Count -gt 0) {
        $names = ($forbiddenFiles | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ", "
        throw "Forbidden debug, log, environment, or key files were packaged: $names"
    }

    foreach ($payloadFile in $payloadFiles) {
        Test-FileContents -Path $payloadFile.FullName -Patterns $patterns -DisplayName $payloadFile.Name
    }

    $packagedExecutables = @(
        $payloadFiles | Where-Object { $_.Name -ieq "crowflix.exe" }
    )
    if ($packagedExecutables.Count -eq 0) {
        throw "The extracted installer payload did not contain crowflix.exe."
    }

    $packagedVersionMatches = @(
        $packagedExecutables | Where-Object {
            $_.VersionInfo.ProductVersion -eq [string]$package.version -or
            $_.VersionInfo.FileVersion -eq [string]$package.version
        }
    )
    if ($packagedVersionMatches.Count -eq 0) {
        throw "The packaged crowflix.exe does not report version $($package.version)."
    }

    $tauriConfig = Get-Content -LiteralPath (Join-Path $repositoryRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
    $declaredResources = @($tauriConfig.bundle.resources)
    if ($declaredResources.Count -eq 0) {
        throw "The Tauri bundle declares no public legal resources."
    }
    foreach ($declaredResource in $declaredResources) {
        if ($declaredResource -isnot [string]) {
            throw "The release verifier does not support a non-string Tauri resource declaration."
        }

        $sourceResource = [IO.Path]::GetFullPath(
            (Join-Path (Join-Path $repositoryRoot "src-tauri") $declaredResource)
        )
        if (-not (Test-Path -LiteralPath $sourceResource -PathType Leaf)) {
            throw "Declared Tauri resource is missing from the source tree: $declaredResource"
        }

        $resourceName = [IO.Path]::GetFileName($sourceResource)
        $sourceHash = Get-Sha256Hex -Path $sourceResource
        $matchingPayloadResources = @(
            $payloadFiles | Where-Object {
                $_.Name -ieq $resourceName -and
                (Get-Sha256Hex -Path $_.FullName) -eq $sourceHash
            }
        )
        if ($matchingPayloadResources.Count -eq 0) {
            throw "The installer payload is missing the exact declared resource '$resourceName'."
        }
    }
}
finally {
    $resolvedTempDirectory = [IO.Path]::GetFullPath($tempDirectory)
    if ($resolvedTempDirectory.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedTempDirectory)) {
        Remove-Item -LiteralPath $resolvedTempDirectory -Recurse -Force
    }
}

$executableSigned = Test-Signature -Path $executable -DisplayName "crowflix.exe"
$installerSigned = Test-Signature -Path $installer -DisplayName ([IO.Path]::GetFileName($installer))

$hash = Get-Sha256Hex -Path $installer
$checksumPath = "$installer.sha256"
$checksumLine = "$hash  $([IO.Path]::GetFileName($installer))`n"
[IO.File]::WriteAllText($checksumPath, $checksumLine, $utf8WithoutBom)

$writtenChecksum = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
if ($writtenChecksum -ne $checksumLine.Trim()) {
    throw "The checksum sidecar could not be verified after writing."
}

Write-Host "Release verification passed."
Write-Host "Installer: $installer"
Write-Host "SHA-256: $hash"
Write-Host "Checksum: $checksumPath"
if (-not ($executableSigned -and $installerSigned)) {
    Write-Warning "Release status: UNSIGNED. The checksum is not a substitute for Authenticode; publish the GitHub provenance attestation too."
}
