@echo off
setlocal
title Firmar y responder - preparar la instalacion en Outlook
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0generar_manifiesto.ps1"
echo.
pause
