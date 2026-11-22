@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open.ps1" -View Hub
if errorlevel 1 pause
