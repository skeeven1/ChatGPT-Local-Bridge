@echo off
setlocal
set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\ChatGPTLocalBridgeV19\app"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ChatGPT-Local-Bridge-V19.cmd"
echo Installation V19 dans "%DEST%"...
if not exist "%DEST%" mkdir "%DEST%"
xcopy "%SRC%*" "%DEST%\" /E /I /Y /Q >nul
(
  echo @echo off
  echo start "ChatGPT Local Bridge V19" /min "%DEST%\START-GPT-ACTIONS.cmd"
) > "%STARTUP%"
echo Auto-demarrage installe: "%STARTUP%"
echo Lancement maintenant...
start "ChatGPT Local Bridge V19" /min "%DEST%\START-GPT-ACTIONS.cmd"
pause
