@echo off
set "PATH=C:\Users\zhanxh\.cargo\bin;%PATH%"
echo [1/3] Building frontend assets...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo Frontend build failed!
    exit /b %ERRORLEVEL%
)

echo [2/3] Building Tauri release binary...
call npx tauri build --no-bundle
if %ERRORLEVEL% NEQ 0 (
    echo Tauri build failed!
    exit /b %ERRORLEVEL%
)

echo [3/3] Copying to release\LiteLauncher.exe...
copy /Y "src-tauri\target\release\tauri-app.exe" "release\LiteLauncher.exe"
echo Build and release completed successfully!
