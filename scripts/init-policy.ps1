$ErrorActionPreference = "Stop"

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

Push-Location $RepoRoot
try {
    cmd /c npm run devnet:init-policy
}
finally {
    Pop-Location
}
