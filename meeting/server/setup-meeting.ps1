# One-time setup of our meeting room (run again to update Jitsi).
#   powershell -ExecutionPolicy Bypass -File setup-meeting.ps1
# Needs Docker Desktop running. Safe to run twice: existing secrets in .env
# are kept, so Odoo's copy of JWT_APP_SECRET keeps working.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# 1. Our settings file, with every empty secret filled in.
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-Secret([int]$bytes) {
    $b = New-Object byte[] $bytes; $rng.GetBytes($b)
    ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}
$lines = Get-Content .env
$lines = $lines | ForEach-Object {
    if ($_ -match '^(JWT_APP_SECRET)=\s*$') { "$($Matches[1])=$(New-Secret 32)" }
    elseif ($_ -match '^([A-Z_]+_PASSWORD)=\s*$') { "$($Matches[1])=$(New-Secret 16)" }
    else { $_ }
}
Set-Content .env $lines -Encoding ascii
$version = (($lines | Where-Object { $_ -like 'JITSI_IMAGE_VERSION=*' }) -split '=', 2)[1]

# 2. The official Jitsi docker files for that version, unedited, in .\jitsi.
$zip = Join-Path $env:TEMP "docker-jitsi-meet-$version.zip"
Invoke-WebRequest "https://github.com/jitsi/docker-jitsi-meet/archive/refs/tags/$version.zip" -OutFile $zip -UseBasicParsing
if (Test-Path jitsi) { Remove-Item jitsi -Recurse -Force }
Expand-Archive $zip -DestinationPath $env:TEMP -Force
Move-Item (Join-Path $env:TEMP "docker-jitsi-meet-$version") jitsi

# 3. Jitsi's own data folders.
foreach ($d in 'web','transcripts','prosody\config','prosody\prosody-plugins-custom','jicofo','jvb','storage','tmp') {
    New-Item -ItemType Directory -Force (Join-Path 'data' $d) | Out-Null
}

$app = (($lines | Where-Object { $_ -like 'JWT_APP_ID=*' }) -split '=', 2)[1]
$secret = (($lines | Where-Object { $_ -like 'JWT_APP_SECRET=*' }) -split '=', 2)[1]
Write-Host ''
Write-Host "Jitsi $version is ready to start: run start-meeting.cmd"
Write-Host 'Put these two values in Odoo > Settings > AI & Transcription > Meeting Server:'
Write-Host "  Jitsi App ID:     $app"
Write-Host "  Jitsi App Secret: $secret"
