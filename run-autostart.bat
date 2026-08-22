@echo off
cd /d "%~dp0"
node launch.js > autostart.log 2>&1
