@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\auto_enhance.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
if %EXITCODE% neq 0 (
    echo One or more files failed. Check the CSV log in the "logs" folder.
) else (
    echo Process completed successfully.
)
pause
exit /b %EXITCODE%
