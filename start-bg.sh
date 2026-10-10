#!/bin/bash
# ============================================================
#  在受限容器（/etc 只读、无 crond/systemd 守护）里后台跑网关。
#  用法: bash start-bg.sh [start|stop|status|restart]
#
#  说明:
#   - 本脚本只管理「本容器内」的网关后台进程，关闭终端不影响运行
#   - 若容器重启，需再次执行（或在宿主/entrypoint 里加一行调用）
#   - 请用 bash 执行（sh ./start-bg.sh 会因 pipefail 报错）
# ============================================================
set -uo pipefail
cd "$(dirname "$0")"

APP_DIR="$(pwd)"
PIDFILE="$APP_DIR/.aigateway.pid"
LOGFILE="$APP_DIR/.aigateway.log"
PORT=3100
BIN=/usr/local/bin/node

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

cmd_start() {
  if is_running; then
    echo "✓ 已在运行 (pid=$(cat "$PIDFILE"))"
    return 0
  fi
  # 清理可能残留的旧进程（端口占用）
  local old
  old=$(ss -ltnp 2>/dev/null | grep ":$PORT" | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  [ -n "${old:-}" ] && echo "… 停止残留进程 pid=$old" && kill "$old" 2>/dev/null && sleep 1
  # 后台启动，脱离终端
  nohup "$BIN" server.js >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  if is_running; then
    echo "✓ 已后台启动 (pid=$(cat "$PIDFILE"))"
    echo "  日志: $LOGFILE"
    echo "  状态: curl http://127.0.0.1:$PORT/health"
  else
    echo "✗ 启动失败，查看 $LOGFILE"
    tail -5 "$LOGFILE"
    exit 1
  fi
}

cmd_stop() {
  if is_running; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE"
    echo "✓ 已停止"
  else
    echo "· 未在运行"
  fi
}

cmd_status() {
  if is_running; then
    local hp
    hp=$(curl -s --max-time 3 http://127.0.0.1:$PORT/health || echo "无响应")
    echo "✓ 运行中 (pid=$(cat "$PIDFILE"))"
    echo "  health: $hp"
  else
    echo "✗ 未运行"
  fi
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  restart) cmd_stop; sleep 1; cmd_start ;;
  *) echo "用法: $0 [start|stop|status|restart]"; exit 1 ;;
esac
