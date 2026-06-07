@echo off
echo.
echo ========================================
echo YT Downloader - Build Setup
echo ========================================
echo.

echo [1/3] Installing dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [2/3] Building Windows app...
call npm run build:win
if errorlevel 1 (
    echo ERROR: Failed to build application
    pause
    exit /b 1
)

echo.
echo [3/3] Done!
echo.
echo The exe file is in: release\
echo.
echo YT Downloader Setup.exe - main installer
echo YT Downloader-1.0.0.exe - portable version
echo.
pause
