$ErrorActionPreference = "Stop"

$AnchorVersion = if ($env:ANCHOR_VERSION) { $env:ANCHOR_VERSION } else { "0.30.1" }
$SolanaVersion = if ($env:SOLANA_VERSION) { $env:SOLANA_VERSION } else { "1.18.17" }
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Add-LocalToolchainPath {
    $candidatePaths = @()

    foreach ($solanaFolder in @($SolanaVersion, "v$SolanaVersion") | Select-Object -Unique) {
        $solanaBin = Join-Path $RepoRoot ".tools\solana\$solanaFolder\solana-release\bin"
        if (Test-Path $solanaBin) {
            $candidatePaths += $solanaBin
            break
        }
    }

    $anchorBin = Join-Path $RepoRoot ".tools\anchor\$AnchorVersion"
    if (Test-Path (Join-Path $anchorBin "anchor.exe")) {
        $candidatePaths += $anchorBin
    }
    else {
        $fallbackAnchor = Get-ChildItem (Join-Path $RepoRoot ".tools\anchor") -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            Where-Object { Test-Path (Join-Path $_.FullName "anchor.exe") } |
            Select-Object -First 1
        if ($null -ne $fallbackAnchor) {
            $candidatePaths += $fallbackAnchor.FullName
        }
    }

    if ($candidatePaths.Count -gt 0) {
        $env:PATH = (($candidatePaths + @($env:PATH)) -join ";")
    }
}

function Assert-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

Add-LocalToolchainPath

Assert-Command "anchor"
Assert-Command "solana"

Push-Location $RepoRoot
try {
    & (Join-Path $RepoRoot "scripts\preflight-anchor.ps1")
    & anchor build
    & anchor deploy --provider.cluster devnet
}
finally {
    Pop-Location
}

Write-Host @"
Anchor deploy completed.

Replace POLICY_CONTROLLER_PROGRAM_ID in .env with the deployed program id.
Then initialize the policy PDA before wiring the Python client.
"@
