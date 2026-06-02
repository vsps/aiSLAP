#!/usr/bin/env pwsh
# Bump the program version across package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json.
#
# Usage:
#   scripts\versionup.ps1 0.1.1      # component-wise add: 0.1.2 -> 0.2.3
#   scripts\versionup.ps1 -v         # print current version
#   scripts\versionup.ps1            # print current version

param(
    [string]$Bump = '',
    [switch]$v
)

$ErrorActionPreference = 'Stop'

$repo     = Resolve-Path (Join-Path $PSScriptRoot '..')
$pkgPath  = Join-Path $repo 'package.json'
$tomlPath = Join-Path $repo 'src-tauri/Cargo.toml'
$confPath = Join-Path $repo 'src-tauri/tauri.conf.json'

function Get-CurrentVersion {
    $m = Select-String -Path $pkgPath -Pattern '"version"\s*:\s*"([^"]+)"' | Select-Object -First 1
    if (-not $m) { throw "cannot parse version from $pkgPath" }
    return $m.Matches[0].Groups[1].Value
}

if ($v -or -not $Bump) {
    Write-Output (Get-CurrentVersion)
    exit 0
}

if ($Bump -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    Write-Error "expected MAJOR.MINOR.PATCH (e.g. 0.1.1), got '$Bump'"
    exit 1
}
$dMaj = [int]$Matches[1]; $dMin = [int]$Matches[2]; $dPat = [int]$Matches[3]

$cur = Get-CurrentVersion
if ($cur -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    Write-Error "current version '$cur' is not MAJOR.MINOR.PATCH"
    exit 1
}
$cMaj = [int]$Matches[1]; $cMin = [int]$Matches[2]; $cPat = [int]$Matches[3]

$new = '{0}.{1}.{2}' -f ($cMaj + $dMaj), ($cMin + $dMin), ($cPat + $dPat)

# Regex-replace in place to preserve formatting / encoding / trailing newlines.
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

[System.IO.File]::WriteAllText($pkgPath,  ((Get-Content -Raw $pkgPath)  -replace '("version"\s*:\s*")[^"]+(")',         "`${1}$new`${2}"), $Utf8NoBom)
[System.IO.File]::WriteAllText($tomlPath, ((Get-Content -Raw $tomlPath) -replace '(?m)^(version\s*=\s*")[^"]+(")',      "`${1}$new`${2}"), $Utf8NoBom)
[System.IO.File]::WriteAllText($confPath, ((Get-Content -Raw $confPath) -replace '("version"\s*:\s*")[^"]+(")',         "`${1}$new`${2}"), $Utf8NoBom)

Write-Output "$cur -> $new"
