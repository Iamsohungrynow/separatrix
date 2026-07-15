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

function Get-DeclaredProgramId {
    $libPath = Join-Path $RepoRoot "programs\policy_controller\src\lib.rs"
    if (-not (Test-Path $libPath)) {
        return $null
    }

    $content = Get-Content $libPath -Raw
    $match = [regex]::Match($content, 'declare_id!\("([^"]+)"\);')
    if ($match.Success) {
        return $match.Groups[1].Value
    }

    return $null
}

function Get-AnchorTomlProgramIds {
    $anchorToml = Join-Path $RepoRoot "Anchor.toml"
    if (-not (Test-Path $anchorToml)) {
        return @{}
    }

    $content = Get-Content $anchorToml -Raw
    $ids = @{}
    foreach ($network in @("localnet", "devnet")) {
        $match = [regex]::Match($content, "(?ms)\[programs\.$network\].*?policy_controller\s*=\s*`"([^`"]+)`"")
        if ($match.Success) {
            $ids[$network] = $match.Groups[1].Value
        }
    }
    return $ids
}

function Ensure-ProgramKeypair {
    $keypairPath = Join-Path $RepoRoot "target\deploy\policy_controller-keypair.json"
    if (-not (Test-Path $keypairPath)) {
        Push-Location $RepoRoot
        try {
            & anchor keys list | Out-Null
        }
        finally {
            Pop-Location
        }
    }

    if (Test-Path $keypairPath) {
        return $keypairPath
    }

    return $null
}

if (-not $env:HOME -and $env:USERPROFILE) {
    $env:HOME = $env:USERPROFILE
}

Add-LocalToolchainPath

$issues = New-Object System.Collections.Generic.List[string]

foreach ($command in @("anchor", "solana", "solana-keygen")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        $issues.Add("Missing required command: $command")
    }
}

if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    $issues.Add("Missing required command: node")
}

if (Get-Command "anchor" -ErrorAction SilentlyContinue) {
    $anchorVersionOutput = (& anchor --version).Trim()
    if ($anchorVersionOutput -match '(\d+\.\d+\.\d+)') {
        $resolvedAnchorVersion = $Matches[1]
        if ($resolvedAnchorVersion -ne $AnchorVersion) {
            $issues.Add("Anchor CLI version mismatch. Expected $AnchorVersion but resolved $resolvedAnchorVersion from PATH/.tools. Install Anchor $AnchorVersion or update the repo's pinned version intentionally.")
        }
    }
}

if (-not (Get-Command "docker" -ErrorAction SilentlyContinue)) {
    $issues.Add("Docker Desktop is required to run anchor build and anchor test from native Windows in this repo. Install Docker Desktop or run the Anchor workflow inside WSL2.")
}

if ((Get-Command "anchor" -ErrorAction SilentlyContinue) -and (Get-Command "solana-keygen" -ErrorAction SilentlyContinue)) {
    $keypairPath = Ensure-ProgramKeypair
    if ($null -eq $keypairPath) {
        $issues.Add("Missing target/deploy/policy_controller-keypair.json. Run anchor keys list or generate the program keypair before build/test.")
    }
    else {
        $pubkey = (& solana-keygen pubkey $keypairPath).Trim()
        $declaredProgramId = Get-DeclaredProgramId
        $anchorTomlProgramIds = Get-AnchorTomlProgramIds

        if ($declaredProgramId -and $declaredProgramId -ne $pubkey) {
            $issues.Add("Program id mismatch in programs/policy_controller/src/lib.rs. declare_id! uses $declaredProgramId but target/deploy/policy_controller-keypair.json resolves to $pubkey. Run anchor keys sync locally before build/test.")
        }

        foreach ($network in $anchorTomlProgramIds.Keys) {
            $programId = $anchorTomlProgramIds[$network]
            if ($programId -and $programId -ne $pubkey) {
                $issues.Add("Program id mismatch in Anchor.toml. [programs.$network].policy_controller is $programId but target/deploy/policy_controller-keypair.json resolves to $pubkey. Run anchor keys sync locally before build/test.")
            }
        }
    }
}

if ($issues.Count -gt 0) {
    throw ("Anchor preflight failed:`n- " + ($issues -join "`n- "))
}

Write-Host "Anchor preflight passed."
