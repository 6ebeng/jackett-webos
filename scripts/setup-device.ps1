# Optional: register the TV with the webOS CLI (ares) so you can use
# `ares-install` / `ares-launch` instead of the SSH deploy script.
#
#   powershell -ExecutionPolicy Bypass -File scripts/setup-device.ps1
#
# Note: ares prefers SSH key auth. On a rooted TV you can still add the device
# with a password; if ares refuses, use scripts/deploy.ps1 (pure SSH) instead.

param(
    [string]$Name     = 'jacketttv',
    [string]$TVHost   = '10.5.50.13',
    [string]$User     = 'root',
    [string]$Password = 'alpine',
    [int]   $SshPort  = 22
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$ares = Join-Path $root 'node_modules\.bin\ares-setup-device.cmd'
if (-not (Test-Path $ares)) {
    Push-Location $root
    try { npm install --no-audit --no-fund } finally { Pop-Location }
}

$info = "{'host':'$TVHost','port':$SshPort,'username':'$User','password':'$Password'}"
& $ares --add $Name --info $info
& $ares --list

Write-Host ''
Write-Host "Registered '$Name'. Install with:"
Write-Host "  node_modules\.bin\ares-install -d $Name dist\<package>.ipk"
Write-Host "  node_modules\.bin\ares-launch  -d $Name com.jackett.app"
