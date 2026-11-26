@echo off
REM AI Team Hub connector launcher (Windows).
REM Set CONNECTOR_CONFIG to your own connector JSON; keep it out of git.
cd /d "%~dp0"
if "%CONNECTOR_CONFIG%"=="" set CONNECTOR_CONFIG=connectors\run\connector.json
node connectors\connector.mjs --config "%CONNECTOR_CONFIG%" >> "%TEMP%\ath-connector.log" 2>&1
