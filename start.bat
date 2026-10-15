@echo off
rem Serves this folder at http://localhost:8000/ and opens it in your browser (WebUSB needs http://localhost, not a file:// page).
rem Close this window to stop the server.
cd /d "%~dp0"
start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:8000/"
where py >nul 2>nul && (py -m http.server 8000 --bind 127.0.0.1 & goto :eof)
python -m http.server 8000 --bind 127.0.0.1
