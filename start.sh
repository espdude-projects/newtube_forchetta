#!/usr/bin/env bash
# NewTube — start the server.
# Usage: ./start.sh [port]
# Default port: 80 (required for the TV's User App Sync to find widgetlist.xml)
set -e

PORT="${1:-80}"
cd "$(dirname "$0")/server"

echo "Starting NewTube server on port $PORT..."
echo "(If you see 'permission denied', re-run with sudo or set NEWTUBE_PORT=8088)"
echo ""

NEWTUBE_PORT=$PORT python3 app.py
