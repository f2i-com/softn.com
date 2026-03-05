@echo off
:: SoftN Shell Extension Installer
:: Run as Administrator

echo SoftN Shell Extension Installer
echo ================================

:: Check for admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: This script requires Administrator privileges.
    echo Please right-click and select "Run as administrator"
    pause
    exit /b 1
)

:: Create installation directory
set "INSTALL_DIR=%ProgramFiles%\SoftN"
if not exist "%INSTALL_DIR%" (
    mkdir "%INSTALL_DIR%"
    echo Created directory: %INSTALL_DIR%
)

:: Copy DLL
copy /Y "%~dp0target\release\softn_shell_extension.dll" "%INSTALL_DIR%\softn_shell_extension.dll"
if %errorlevel% neq 0 (
    echo ERROR: Failed to copy DLL
    pause
    exit /b 1
)
echo Copied DLL to: %INSTALL_DIR%

:: Register the DLL
regsvr32 /s "%INSTALL_DIR%\softn_shell_extension.dll"
if %errorlevel% neq 0 (
    echo ERROR: Failed to register DLL
    pause
    exit /b 1
)

echo.
echo SUCCESS: SoftN Shell Extension installed!
echo.
echo Note: You may need to restart Explorer or log out/in for changes to take effect.
echo.
pause
