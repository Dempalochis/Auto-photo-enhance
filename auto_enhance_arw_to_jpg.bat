@echo off
setlocal

set "RT=C:\Program Files\RawTherapee\5.12\rawtherapee-cli.exe"
set "PROFILE=%~dp0sony_a7ii_24-70f4_best.pp3"
set "OUTDIR=%~dp0edited_jpg"

if not exist "%RT%" (
    echo RawTherapee CLI not found:
    echo %RT%
    pause
    exit /b
)

if not exist "%PROFILE%" (
    echo Missing profile:
    echo %PROFILE%
    pause
    exit /b
)

if not exist "%OUTDIR%" mkdir "%OUTDIR%"

for %%F in (*.arw *.ARW) do (
    echo Enhancing %%F
    "%RT%" ^
    -p "%PROFILE%" ^
    -o "%OUTDIR%\%%~nF.jpg" ^
    -j95 ^
    -Y ^
    -c "%%F"
)

echo.
echo =====================================
echo Process completed successfully.
echo Edited JPG files are in:
echo %OUTDIR%
echo =====================================
pause