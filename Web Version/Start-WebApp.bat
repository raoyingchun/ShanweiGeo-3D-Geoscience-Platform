@echo off
REM ============================================================
REM  ShanweiGeo 3D Geoscience Platform - web build launcher
REM  Starts a local static server and opens the application.
REM ============================================================
setlocal

set PORT=8765
cd /d "%~dp0"

echo.
echo   ShanweiGeo 3D Geoscience Platform (web build)
echo   ----------------------------------------------
echo   Starting a local server on http://127.0.0.1:%PORT%
echo   Keep this window open while you use the application.
echo   Press Ctrl+C to stop the server.
echo.

REM --- pick an interpreter -------------------------------------------------
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY (
  where python >nul 2>nul && set PY=python
)
if not defined PY (
  echo [ERROR] Python was not found on this computer.
  echo         Install Python 3 from https://www.python.org/downloads/
  echo         and tick "Add Python to PATH" during setup.
  echo.
  pause
  exit /b 1
)

echo   Using interpreter: %PY%
echo.

REM --- start the server in the background ----------------------------------
start "" /min %PY% -m http.server %PORT% --bind 127.0.0.1
set SERVER_PID=%ERRORLEVEL%

REM --- give the server a moment, then open the browser --------------------
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:%PORT%/index8.html

echo   The application should open in your browser shortly.
echo   If it does not, visit: http://127.0.0.1:%PORT%/index8.html
echo.

REM --- wait for the server, then close -------------------------------------
echo   (Close this window to stop the server.)
powershell -NoProfile -Command "while (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }" 2>nul

endlocal
