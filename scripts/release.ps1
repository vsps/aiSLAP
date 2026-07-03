#!/usr/bin/env pwsh
# Full release flow: bump version, commit everything, push dev, merge dev into
# main, push main. Building is handled by the GitHub release workflow, not here.
#
# Usage:
#   scripts\release.ps1              # auto patch bump (0.2.14 -> 0.2.15), then release
#   scripts\release.ps1 0.3.0        # explicit version, then release
#   scripts\release.ps1 -v           # print current version only, no changes
#
# Must be run from the 'dev' branch. Delegates version bumping to
# versionup.ps1 (keeps package.json / Cargo.toml / Cargo.lock / tauri.conf.json
# in sync via in-place regex replace, rather than re-serializing JSON here).

param(
    [string]$Version = '',
    [switch]$v
)

$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$versionupPath = Join-Path $PSScriptRoot 'versionup.ps1'

Set-Location $repo

if ($v) {
    & $versionupPath -v
    exit 0
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Cmd,
        [Parameter(Mandatory)][string[]]$CmdArgs
    )
    & $Cmd @CmdArgs
    if ($LASTEXITCODE -ne 0) {
        throw "'$Cmd $($CmdArgs -join ' ')' failed with exit code $LASTEXITCODE"
    }
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'dev') {
    throw "release.ps1 must be run from 'dev' (currently on '$branch')"
}

# 1. Bump version across package.json / Cargo.toml / Cargo.lock / tauri.conf.json.
# Must be a hashtable, not a string array — array-splatting passes "-bump" as
# a literal positional value instead of binding the $bump switch by name.
$bumpArgs = if ($Version) { @{ version = $Version } } else { @{ bump = $true } }
$bumpResult = & $versionupPath @bumpArgs
Write-Host $bumpResult
$newVersion = ($bumpResult -split '->')[-1].Trim()
if ($newVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "could not parse new version from versionup.ps1 output: '$bumpResult'"
}

# 2. Commit everything currently pending (version bump + whatever else is
#    staged/unstaged) and push dev.
Invoke-Native git @('add', '-A')
Invoke-Native git @('commit', '-m', "chore: release v$newVersion")
Invoke-Native git @('push', 'origin', 'dev')

# 3. Merge dev into main and push.
Invoke-Native git @('checkout', 'main')
Invoke-Native git @('pull', 'origin', 'main', '--ff-only')
Invoke-Native git @('merge', 'dev', '--no-ff', '-m', "Merge dev: release v$newVersion")
Invoke-Native git @('push', 'origin', 'main')
Invoke-Native git @('checkout', 'dev')

Write-Host "Released v$newVersion"
