@echo off
rem Start (or restart after a change) our meeting room. Docker brings it back
rem by itself after a reboot, so this is only needed after changing settings
rem or branding.
cd /d "%~dp0"
if not exist .env ( echo Run setup-meeting.ps1 first. & exit /b 1 )
copy /y ..\branding\custom-config.js data\web\custom-config.js >nul
copy /y ..\branding\custom-interface_config.js data\web\custom-interface_config.js >nul
docker compose -p meeting --project-directory . --env-file .env -f jitsi\docker-compose.yml -f docker-compose.override.yml up -d --force-recreate
