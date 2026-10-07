@echo off
powershell.exe -NoProfile -File "%~dp0tools\ks-senior.ps1"
exit /b %errorlevel%
