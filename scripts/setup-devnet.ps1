$ErrorActionPreference = "Stop"

$SolanaVersion = if ($env:SOLANA_VERSION) { $env:SOLANA_VERSION } else { "1.18.17" }
$AnchorVersion = if ($env:ANCHOR_VERSION) { $env:ANCHOR_VERSION } else { "0.30.1" }
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

Assert-Command "solana"
Assert-Command "solana-keygen"
Assert-Command "anchor"
Assert-Command "node"

$keysDir = Join-Path $RepoRoot "keys"
New-Item -ItemType Directory -Force -Path $keysDir | Out-Null

$ownerKey = Join-Path $keysDir "owner-devnet.json"
$agentKey = Join-Path $keysDir "agent-devnet.json"
$treasuryKey = Join-Path $keysDir "treasury-devnet.json"

& solana config set --url https://api.devnet.solana.com

if (-not (Test-Path $ownerKey)) {
    & solana-keygen new --outfile $ownerKey --no-bip39-passphrase
}

if (-not (Test-Path $agentKey)) {
    & solana-keygen new --outfile $agentKey --no-bip39-passphrase
}

if (-not (Test-Path $treasuryKey)) {
    & solana-keygen new --outfile $treasuryKey --no-bip39-passphrase
}

Write-Host "Airdropping devnet SOL..."
try {
    & solana airdrop 2 (& solana-keygen pubkey $ownerKey) | Out-Null
}
catch {
    Write-Warning "Owner wallet airdrop failed; continuing."
}

try {
    & solana airdrop 2 (& solana-keygen pubkey $agentKey) | Out-Null
}
catch {
    Write-Warning "Agent wallet airdrop failed; continuing."
}

try {
    & solana airdrop 2 (& solana-keygen pubkey $treasuryKey) | Out-Null
}
catch {
    Write-Warning "Treasury wallet airdrop failed; continuing."
}

Write-Host @"
Devnet setup finished.

Pinned targets:
  Solana CLI: $SolanaVersion
  Anchor CLI: $AnchorVersion

Next steps:
  1. powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
  2. verify POLICY_CONTROLLER_PROGRAM_ID in .env matches Anchor.toml and declare_id!
  3. run anchor test
"@
