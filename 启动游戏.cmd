@echo off
title DARCUO
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 18+: https://nodejs.org/
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0]) < 18) process.exit(1)"
if errorlevel 1 (
  echo Update Node.js to 18+: https://nodejs.org/
  pause
  exit /b 1
)
echo Starting DARCUO: http://localhost:3000
echo Allow private network access if prompted.
node server.mjs
pause
