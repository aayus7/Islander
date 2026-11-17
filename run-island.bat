@echo off
setlocal EnableExtensions
title Islander - setup and run
cd /d "%~dp0"

rem Re-open inside "cmd /k" so the window never closes on its own, even on errors.
if "%~1"=="inner" goto :main
cmd /k call "%~f0" inner
exit /b
:main

echo ==================================================
echo   Islander - installs what's missing, then runs it
echo   (safe to run again any time)
echo ==================================================
echo.

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "PATH=%PATH%;%ProgramFiles%\nodejs;%USERPROFILE%\.cargo\bin;%APPDATA%\npm"

where winget >nul 2>nul
if errorlevel 1 goto :nowinget

rem ---------- 1. Node.js ----------
where node >nul 2>nul
if not errorlevel 1 goto :havenode
echo [1/4] Installing Node.js LTS...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
:havenode
where node >nul 2>nul
if errorlevel 1 goto :fail_node
echo [1/4] Node.js OK

rem ---------- 2. Rust ----------
where cargo >nul 2>nul
if not errorlevel 1 goto :haverust
echo [2/4] Installing Rust...
winget install -e --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements
:haverust
where rustup >nul 2>nul
if errorlevel 1 goto :fail_rust
rem Make sure the toolchain actually works (a cut-off install leaves rustc broken).
rustc -vV >nul 2>nul
if not errorlevel 1 goto :rustok
echo [2/4] Repairing the Rust toolchain (minimal install, skips the slow docs)...
rustup toolchain uninstall stable-x86_64-pc-windows-msvc >nul 2>nul
rustup toolchain install stable-x86_64-pc-windows-msvc --profile minimal
rustup default stable-x86_64-pc-windows-msvc
rustc -vV >nul 2>nul
if errorlevel 1 goto :fail_rust
:rustok
echo [2/4] Rust OK

rem ---------- 3. Microsoft C++ Build Tools ----------
rem (no brackets here on purpose: the "(x86)" in the path breaks cmd blocks)
if not exist "%VSWHERE%" goto :installvc
"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%TEMP%\island_vc.txt" 2>nul
for %%A in ("%TEMP%\island_vc.txt") do if %%~zA GTR 0 goto :havevc
:installvc
echo [3/4] Installing Microsoft C++ Build Tools.
echo       This is a big download (a few GB) and can take 10-20 minutes.
echo       Windows will ask for permission - click Yes.
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
:havevc
echo [3/4] C++ Build Tools OK

rem ---------- 4. Project ----------
if exist node_modules goto :havemods
echo [4/4] Installing project packages...
call npm install
if errorlevel 1 goto :fail
:havemods
echo [4/4] Packages OK
echo.
echo Starting Islander. The FIRST start compiles everything and can take 3-8 minutes.
echo Later starts take a few seconds. Close this window to quit Islander.
echo.
call npm run tauri dev
if errorlevel 1 goto :fail
exit /b

:nowinget
echo [!] winget is missing. Install "App Installer" from the Microsoft Store, then run this again.
goto :fail
:fail_node
echo [!] Node.js still isn't available. Close this window and run the script again
echo     (a fresh window picks up newly installed programs).
goto :fail
:fail_rust
echo [!] Rust still isn't available. Close this window and run the script again.
goto :fail
:fail
echo.
echo Something went wrong - copy the red/error text above and paste it to Claude.
pause
