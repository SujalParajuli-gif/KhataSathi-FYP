@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\ks-start.ps1"
exit /b %errorlevel%
