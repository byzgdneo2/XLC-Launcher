@echo off
chcp 65001 >nul
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if not exist node_modules (
  echo [LMC] 首次运行，正在安装依赖（约 1-3 分钟）...
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
)
call npm start
pause
