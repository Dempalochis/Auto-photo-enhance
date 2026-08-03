@echo off
setlocal

set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%webapp\server"
set "CLIENT_DIR=%ROOT%webapp\client"

if not exist "%SERVER_DIR%\node_modules" (
    echo Server dependencies not installed. Run this first:
    echo   cd webapp\server
    echo   npm install
    pause
    exit /b 1
)

if not exist "%CLIENT_DIR%\node_modules" (
    echo Client dependencies not installed. Run this first:
    echo   cd webapp\client
    echo   npm install
    pause
    exit /b 1
)

echo Starting backend server in its own window...
start "Auto Photo Enhance - Server" /D "%SERVER_DIR%" cmd /k node server.js

echo Starting frontend dev server in its own window...
start "Auto Photo Enhance - Client" /D "%CLIENT_DIR%" cmd /k npm run dev

echo Waiting for the dev server to come up...
ping -n 6 127.0.0.1 >nul

echo Opening the app in your browser...
start "" "http://localhost:5173"

echo.
echo =====================================
echo Both servers are running in their own windows.
echo Close those windows (or Ctrl+C in each) to stop everything.
echo =====================================
