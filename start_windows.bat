@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js chua duoc cai. Hay cai Node.js 20 tro len tai nodejs.org.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Dang cai thu vien...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
start "" http://localhost:3000
npm start
pause
