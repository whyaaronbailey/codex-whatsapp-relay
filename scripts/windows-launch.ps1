param(
    [ValidateSet('controller', 'auth', 'pair', 'startup')]
    [string]$Mode = 'startup',
    [switch]$EnableController
)
$ErrorActionPreference = 'Stop'
$relayNode = (Get-Command node.exe -ErrorAction Stop).Source
$relayLauncher = Join-Path $PSScriptRoot 'launch.mjs'
# For MCP/worker stdio use node scripts/launch.mjs directly. PowerShell -File
# wrappers are only for interactive pairing and noninteractive login startup.
if ($Mode -eq 'pair' -and $EnableController) { & $relayNode $relayLauncher $Mode --enable-controller }
else { & $relayNode $relayLauncher $Mode }
exit $LASTEXITCODE
