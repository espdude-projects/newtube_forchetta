@echo off
REM build_exe.bat - create a single NewTube.exe from NewTube.py
REM
REM Result: dist\NewTube.exe  (~25-35 MB, includes Python + deps)
REM
REM Requirements:  Python 3.9+ (same one you use to run the GUI)

setlocal
set "NEWTUBE_DIR=%~dp0"

echo.
echo ===========================================
echo   Building NewTube.exe (single-file)
echo ===========================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [build_exe] Python not found in PATH.
    echo Please install Python 3.9+ and re-run.
    pause
    exit /b 1
)

echo [1/3] Installing PyInstaller...
python -m pip install --upgrade pyinstaller
if errorlevel 1 goto :fail

echo.
echo [2/3] Bundling NewTube.py + assets into a single .exe...
cd /d "%NEWTUBE_DIR%"
python -m PyInstaller ^
    --noconfirm ^
    --clean ^
    --onefile ^
    --windowed ^
    --name NewTube ^
    --collect-all fastapi ^
    --collect-all starlette ^
    --collect-all yt_dlp ^
    --collect-all anyio ^
    --collect-all sniffio ^
    --collect-data uvicorn ^
    --hidden-import "tkinter" ^
    --hidden-import "tkinter.ttk" ^
    --hidden-import "tkinter.scrolledtext" ^
    --hidden-import "tkinter.messagebox" ^
    NewTube.py
if errorlevel 1 goto :fail

echo.
echo [3/3] Done.
echo.
echo   Your single-file installer is here:
echo       %NEWTUBE_DIR%dist\NewTube.exe
echo.
echo   Copy NewTube.exe to any Windows 8/8.1/10/11 PC, double-click,
echo   and it just works - no Python install required.
echo.
pause
exit /b 0

:fail
echo.
echo [build_exe] Build failed.  See the error above.
pause
exit /b 1
