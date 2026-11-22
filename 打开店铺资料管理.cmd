@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open.ps1" -View Merchant
if errorlevel 1 pause
