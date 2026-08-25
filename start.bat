@echo off
setlocal

cd /d "%~dp0"

if not exist "webapp\client\dist\index.html" (
    echo webapp\client\dist\ hasn't been built yet.
    echo Run setup.bat first ^(or "npm run build" if you've already run setup once^).
    pause
    exit /b 1
)

rem Waits for the server to actually respond before opening the browser, instead of guessing a
rem fixed delay - a real V8 acceptance-verification run on real hardware showed 2s isn't always
rem enough (antivirus scanning a freshly-built app, a loaded machine, etc.), which opened the
rem browser before the server was listening and caused a flurry of 502s on first load that only
rem cleared after a manual page refresh. Polls up to 30 times, 500ms apart (15s ceiling); opens
rem the browser either way once that's up, so a slower-than-expected start still isn't stuck
rem forever - matches the app's own "advisory, don't block" philosophy elsewhere (e.g. the
rem disk-space warning). The server itself runs in *this* window, so closing it stops the app.
start "" powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { try { Invoke-WebRequest -Uri 'http://localhost:5175/api/health' -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }; Start-Process 'http://localhost:5175'"

echo Starting Auto Photo Enhance - closing this window stops the server.
npm start
pause
