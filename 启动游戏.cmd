@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0]) < 18) process.exit(1)"
if errorlevel 1 (
  echo 当前 Node.js 版本过旧，请安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
echo 正在启动斗地主。启动后请打开 http://localhost:3000
echo 若 Windows 防火墙询问网络权限，请允许专用网络访问。
node server.mjs
pause
