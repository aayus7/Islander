@echo off
setlocal EnableExtensions
title Islander - build the installer
cd /d "%~dp0"
set "PATH=%PATH%;%ProgramFiles%\nodejs;%USERPROFILE%\.cargo\bin;%APPDATA%\npm"

echo ==================================================
echo   Building the Islander installer (release)
echo   This takes 5-15 minutes the first time.
echo ==================================================
echo.

call npm install
if errorlevel 1 goto :fail

rem Updates are signed with the project's updater key (kept in .keys, never share it).
if not exist ".keys\islander-updater.key" (
  echo Missing .keys\islander-updater.key - updates can't be signed without it.
  goto :fail
)
set "TAURI_SIGNING_PRIVATE_KEY=%~dp0.keys\islander-updater.key"
set /p TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<".keys\password.txt"

call npm run tauri build
if errorlevel 1 goto :fail

if exist release rmdir /s /q release
mkdir release
call node scripts\make-update-feed.mjs
if errorlevel 1 goto :fail
copy /y "RELEASE-README.txt" "release\Read Me.txt" >nul

echo.
echo Done! The installer is in the "release" folder.
echo To ship it as an update to everyone: tell Claude "publish the update",
echo or upload everything in "release" to a new GitHub release named v^<version^>.
explorer "%~dp0release"
pause
exit /b

:fail
echo.
echo The build failed - copy the error text above and paste it to Claude.
pause
