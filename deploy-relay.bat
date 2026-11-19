@echo off
setlocal EnableExtensions
title Islander - deploy the free AI relay
cd /d "%~dp0relay"
set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
echo ==================================================
echo   Islander AI relay (Cloudflare Workers, free plan)
echo   - a browser opens: sign in to Cloudflare (or make a free account)
echo   - then paste your Gemini API key once when asked
echo ==================================================
echo.
call npm install --no-audit --no-fund --legacy-peer-deps
if errorlevel 1 goto :fail
rem Sign in only if needed.
call npx wrangler whoami | findstr /i "not authenticated" >nul
if not errorlevel 1 call npx wrangler login
call node setup.mjs
if errorlevel 1 goto :fail
echo.
echo Done! Tell Claude "relay deployed" and it builds the URL into Islander.
pause
exit /b
:fail
echo.
echo Something went wrong - tell Claude (the text above is also what it needs).
pause
