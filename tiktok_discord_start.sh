#!/bin/bash
# Start/stop/status for TikTok → Discord feed daemon

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="/tmp/tiktok_discord.pid"
LOG_FILE="/tmp/tiktok_discord.log"

start() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
        echo "Already running (PID $(cat $PID_FILE))"
        exit 0
    fi
    echo "Starting TikTok → Discord feed..."
    nohup python3 "$SCRIPT_DIR/tiktok_discord_feed.py" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Started (PID $!)"
    echo "Logs: tail -f $LOG_FILE"
}

stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "Not running (no PID file)"
        exit 0
    fi
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        rm -f "$PID_FILE"
        echo "Stopped (PID $PID)"
    else
        echo "Process $PID not found, cleaning up"
        rm -f "$PID_FILE"
    fi
}

status() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
        echo "Running (PID $(cat $PID_FILE))"
        echo "Last 5 log lines:"
        tail -5 "$LOG_FILE" 2>/dev/null
    else
        echo "Not running"
    fi
}

case "$1" in
    start)  start ;;
    stop)   stop ;;
    restart) stop; sleep 1; start ;;
    status) status ;;
    logs)   tail -f "$LOG_FILE" ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
