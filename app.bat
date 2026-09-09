@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 优先启动桌面版（若已安装则直接运行）
if exist "%LOCALAPPDATA%\Programs\工作日报\工作日报.exe" (
  start "" "%LOCALAPPDATA%\Programs\工作日报\工作日报.exe"
  exit /b
)
rem 回退：Web 模式
if exist "server.js" (
  start "工作日报服务" /min "D:\通用工具\nodejs\node.exe" server.js
  timeout /t 2 /nobreak >nul
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:8080 --window-size=1280,860
)
