@echo off
rem Stop the meeting room. Calls in progress end. Nothing is deleted.
cd /d "%~dp0"
docker compose -p meeting --project-directory . --env-file .env -f jitsi\docker-compose.yml -f docker-compose.override.yml down
