#!/bin/sh
# Serves this folder at http://localhost:8000/ and opens it in your browser (WebUSB needs http://localhost, not a file:// page).
# Press Ctrl+C to stop the server.
cd "$(dirname "$0")" || exit 1
( sleep 2; (xdg-open http://localhost:8000/ || google-chrome http://localhost:8000/ || chromium http://localhost:8000/) >/dev/null 2>&1 ) &
if command -v python3 >/dev/null 2>&1; then exec python3 -m http.server 8000 --bind 127.0.0.1; fi
exec python -m http.server 8000 --bind 127.0.0.1
