@echo off
chcp 65001 >nul
cd /d "%~dp0"
node launch.js --menu
pause
