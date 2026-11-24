param(
    [string]$Avd = "Pixel_9a",
    [string]$Apk = (Join-Path $PSScriptRoot "..\dist-apk\pit-management.apk"),
    [string]$Activity = "com.softn.app.management_pit_suite/com.softn.android.MainActivity",
    [switch]$ColdBoot
)

$ErrorActionPreference = "Stop"
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$emu = Join-Path $sdk "emulator\emulator.exe"
$adb = Join-Path $sdk "platform-tools\adb.exe"

if (-not (Test-Path $Apk)) {
    throw "APK not found at $Apk"
}

# Check whether an online emulator is already running
& $adb start-server | Out-Null
$devices = & $adb devices
$online = $devices | Select-String -Pattern "emulator-\d+\s+device"

if (-not $online) {
    # Clear any stuck/offline emulator instance and stale AVD locks
    $offline = $devices | Select-String -Pattern "emulator-\d+\s+offline"
    if ($offline) {
        Write-Host "[softn] Cleaning up offline emulator..." -ForegroundColor Yellow
        Get-Process -Name "qemu-system-x86_64*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    $avdDir = Join-Path $env:USERPROFILE ".android\avd\$Avd.avd"
    if (Test-Path $avdDir) {
        Get-ChildItem -Path $avdDir -Filter "*.lock" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    }

    Write-Host "[softn] Launching $Avd..." -ForegroundColor Cyan
    $emuArgs = @("-avd", $Avd)
    if ($ColdBoot -or $offline) {
        $emuArgs += "-no-snapshot-load"
    }
    Start-Process -FilePath $emu -ArgumentList $emuArgs

    Write-Host "[softn] Waiting for Android to finish booting..." -ForegroundColor Cyan
    & $adb wait-for-device | Out-Null
    while ((& $adb shell getprop sys.boot_completed 2>$null).Trim() -ne "1") {
        Start-Sleep -Seconds 2
    }
    Start-Sleep -Seconds 2
}

$pkg = $Activity.Split("/")[0]
Write-Host "[softn] Installing $Apk..." -ForegroundColor Cyan
& $adb install -r $Apk
if ($LASTEXITCODE -ne 0) {
    Write-Host "[softn] Reinstall failed (often low /data space) — trimming caches, uninstalling previous build, and retrying..." -ForegroundColor Yellow
    & $adb shell pm trim-caches 512M | Out-Null
    & $adb uninstall $pkg | Out-Null
    & $adb install $Apk
    if ($LASTEXITCODE -ne 0) {
        throw "adb install failed with exit code $LASTEXITCODE"
    }
}

Write-Host "[softn] Launching $Activity..." -ForegroundColor Green
& $adb shell am force-stop $pkg
& $adb shell am start -n $Activity
