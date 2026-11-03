#!/usr/bin/env bash
# ShanweiGeo 3D Geoscience Platform - web build launcher (macOS / Linux)
set -e
cd "$(dirname "$0")"

PORT=8765

echo
echo "  ShanweiGeo 3D Geoscience Platform (web build)"
echo "  ----------------------------------------------"
echo "  Starting a local server on http://127.0.0.1:$PORT"
echo "  Press Ctrl+C to stop the server."
echo

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "[ERROR] Python 3 was not found on this computer."
  echo "        Install it from https://www.python.org/downloads/"
  exit 1
fi

echo "  Using interpreter: $PY"
echo

# Open the browser once the server has had a moment to start
(
  sleep 2
  if command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:$PORT/index8.html"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:$PORT/index8.html" >/dev/null 2>&1
  fi
) &

exec "$PY" -m http.server "$PORT" --bind 127.0.0.1
