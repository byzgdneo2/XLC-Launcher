@echo off
chcp 65001 >nul
setlocal
set "ELECTRON_RUN_AS_NODE="
rem 依赖与 Electron 二进制都走国内镜像（二进制默认从 GitHub 拉，国内常超时）
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [XLC] 没有找到 npm，请先安装 Node.js（https://nodejs.org/），装好后重新运行本脚本。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [XLC] 首次运行，正在安装依赖（Electron 二进制约 270MB，视网速 1-5 分钟）...
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  if errorlevel 1 (
    echo [XLC] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

call npm start
pause
