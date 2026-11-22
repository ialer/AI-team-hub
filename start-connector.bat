@echo off
REM AI Team Hub connector for alice (XPS). Started at logon by Task Scheduler.
cd /d "D:\ai\项目\AI-team-hub"
node connectors\connector.mjs --config connectors\run\alice.json >> "%TEMP%\alice-connector.log" 2>&1