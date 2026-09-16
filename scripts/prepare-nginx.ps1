$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$vendor = Join-Path $root 'vendor'
$target = Join-Path $vendor 'nginx'
if (Test-Path (Join-Path $target 'nginx.exe')) { exit 0 }
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
$version = '1.31.6'
$archive = Join-Path $vendor "nginx-$version.zip"
Invoke-WebRequest -Uri "https://nginx.org/download/nginx-$version.zip" -OutFile $archive -UseBasicParsing
$expected = 'BB65EDCFC22A2214A4AFAAC59F038F560C02B98D4B49C5DCA1206D3CC5D631C9'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'nginx archive checksum mismatch' }
Expand-Archive -LiteralPath $archive -DestinationPath $vendor -Force
Move-Item -LiteralPath (Join-Path $vendor "nginx-$version") -Destination $target
Get-FileHash -LiteralPath $archive -Algorithm SHA256 | Format-List
