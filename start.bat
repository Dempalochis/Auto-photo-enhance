@echo off
setlocal

cd /d "%~dp0"

if not exist "webapp\client\dist\index.html" (
    echo webapp\client\dist\ hasn't been built yet.
    echo Run setup.bat first ^(or "npm run build" if you've already run setup once^).
    pause
    exit /b 1
)

rem Opens the browser a couple seconds after this window starts, giving the server time to
rem bind its port first - the server itself runs in *this* window, so closing it stops the app.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5175"

echo Starting Auto Photo Enhance - closing this window stops the server.
npm start
pause
