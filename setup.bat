@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
if %EXITCODE% neq 0 (
    echo Setup did not finish cleanly - see the messages above.
) else (
    echo Setup finished. Double-click start.bat to launch Auto Photo Enhance.
)
pause
exit /b %EXITCODE%
