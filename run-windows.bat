@echo off
setlocal
cd /d "%~dp0"

set "PYTHON=.venv\Scripts\python.exe"

rem Reuse the existing environment. Recreate it only if it cannot import Flask.
if exist "%PYTHON%" (
    "%PYTHON%" -c "import flask, google.auth" >nul 2>&1
    if errorlevel 1 set "REBUILD_ENV=1"
) else (
    set "REBUILD_ENV=1"
)

if defined REBUILD_ENV (
    where py >nul 2>&1
    if not errorlevel 1 (
        py -3 -m venv --clear .venv
    ) else (
        where python >nul 2>&1
        if errorlevel 1 (
            echo Python was not found. Install Python 3.10 or newer and try again.
            pause
            exit /b 1
        )
        python -m venv --clear .venv
    )
    if errorlevel 1 (
        echo Could not create .venv. Check that Python 3.10 or newer is installed.
        pause
        exit /b 1
    )
    "%PYTHON%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo Could not install requirements. Check your internet connection and try again.
        pause
        exit /b 1
    )
)

echo Starting UniPath at http://127.0.0.1:8080/
start "UniPath local server" /D "%CD%" "%CD%\%PYTHON%" app.py
for /l %%i in (1,1,20) do (
    powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8080/' -TimeoutSec 1).StatusCode | Out-Null } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 goto server_ready
    timeout /t 1 /nobreak >nul
)
echo The server did not respond yet. Check the UniPath local server window for an error.
pause
exit /b 1
:server_ready
start "" "http://127.0.0.1:8080/"

echo Keep the server window open while using the site or Lighthouse.
endlocal
