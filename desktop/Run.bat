@echo off
REM NewTube launcher — Windows 8 / 8.1 / 10 / 11
REM Double-click this file.  It will:
REM   1. Detect Python (3.9+) on this machine
REM   2. If missing, open the official Python download page
REM   3. Otherwise, run the NewTube GUI (which handles the rest)

setlocal

set "NEWTUBE_DIR=%~dp0"
set "NEWTUBE_GUI=%NEWTUBE_DIR%NewTube.py"

echo.
echo ===========================================
echo   NewTube - YouTube for legacy Samsung TVs
echo ===========================================
echo.

REM --- Detect Python ----------------------------------------------------------

set "PY="
for /f "delims=" %%P in ('where python 2^>nul') do (
    if not defined PY set "PY=%%P"
)

if defined PY goto :have_python

echo [NewTube] Python not found on this system.
echo.
echo   You need Python 3.9 or newer to run NewTube.
echo   Opening the official Python download page in your browser...
echo.
echo   IMPORTANT:  When installing, tick the box that says
echo   "Add python.exe to PATH" -- without it, this launcher cannot
echo   find Python.
echo.
start "" "https://www.python.org/downloads/windows/"
echo After Python is installed, please re-run this file.
echo.
pause
exit /b 0

:have_python
for /f "tokens=2" %%V in ('"%PY%" --version 2^>^&1') do set "PYVER=%%V"
echo [NewTube] Found Python %PYVER% at %PY%

REM --- Verify version is 3.9+ -------------------------------------------------

"%PY%" -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" 2>nul
if errorlevel 1 (
    echo.
    echo [NewTube] Python %PYVER% is too old.  Need 3.9 or newer.
    echo Opening the download page so you can get a newer version...
    echo.
    start "" "https://www.python.org/downloads/windows/"
    pause
    exit /b 0
)

REM --- Run the GUI ------------------------------------------------------------

echo [NewTube] Launching GUI...
echo.

cd /d "%NEWTUBE_DIR%"
"%PY%" "%NEWTUBE_GUI%"

endlocal
