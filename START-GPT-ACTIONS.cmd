@echo off
setlocal
cd /d "%~dp0"
title ChatGPT Local Bridge V19.9.28 - GPT Actions
where node >nul 2>nul || (echo Node.js introuvable.& pause & exit /b 1)
node "%~dp0launch-gpt-actions.mjs"
echo.
echo Le bridge V19.9.28 s'est arrete.
pause
