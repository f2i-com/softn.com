@echo off
:: SoftN Shell Extension Uninstaller
:: Run as Administrator

echo SoftN Shell Extension Uninstaller
echo ==================================

:: Check for admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: This script requires Administrator privileges.
    echo Please right-click and select "Run as administrator"
    pause
    exit /b 1
)

set "INSTALL_DIR=%ProgramFiles%\SoftN"

:: Unregister the DLL
if exist "%INSTALL_DIR%\softn_shell_extension.dll" (
    regsvr32 /u /s "%INSTALL_DIR%\softn_shell_extension.dll"
    echo Unregistered shell extension

    del "%INSTALL_DIR%\softn_shell_extension.dll"
    echo Deleted DLL
)

:: Remove directory if empty
rmdir "%INSTALL_DIR%" 2>nul

echo.
echo SUCCESS: SoftN Shell Extension uninstalled!
echo.
echo Note: You may need to restart Explorer for changes to take effect.
echo.
pause
