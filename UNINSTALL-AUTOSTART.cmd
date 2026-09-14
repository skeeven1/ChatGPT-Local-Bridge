@echo off
setlocal
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ChatGPT-Local-Bridge-V19.cmd"
if exist "%STARTUP%" del /f /q "%STARTUP%"
echo Auto-demarrage V19 retire. Les donnees et watches locales sont conservees.
pause
