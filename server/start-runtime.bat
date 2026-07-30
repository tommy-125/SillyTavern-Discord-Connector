@echo off
setlocal
cd /d "%~dp0"
echo Checking dependencies...
call npm install
if errorlevel 1 exit /b %errorlevel%
echo Starting KuroHelper AI Runtime...
node server.js
pause
