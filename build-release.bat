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
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VER=%%v"
rem One click opens a new release on GitHub with the tag and title filled in.
> "release\Publish %VER% on GitHub.url" (
  echo [InternetShortcut]
  echo URL=https://github.com/aayus7/Islander/releases/new?tag=v%VER%^&title=Islander%%20%VER%
)

echo.
echo Done! The installer is in the "release" folder.
echo To ship it as an update to everyone: tell Claude "publish the update",
echo or open "Publish %VER% on GitHub" in the release folder and attach the installer,
echo its .sig file and latest.json to the new release (github.com/aayus7/Islander).
explorer "%~dp0release"
pause
exit /b

:fail
echo.
echo The build failed - copy the error text above and paste it to Claude.
pause
