$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
node (Join-Path $PSScriptRoot 'prepare-nginx.cjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
