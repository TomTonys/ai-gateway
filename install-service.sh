#!/usr/bin/env bash
# ============================================================
#  把 AI Gateway 安装为 systemd 服务（后台自启、挂了自愈、开机启动）
#  用法: sudo ./install-service.sh
# ============================================================
set -euo pipefail

UNIT="aigateway.service"
SYSTEMD_DIR="/etc/systemd/system"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行: sudo $0" >&2
  exit 1
fi

# 1) 先停掉当前手动跑的 node server.js（避免端口冲突）
OLD_PID=$(ss -ltnp 2>/dev/null | grep ':3100' | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "${OLD_PID:-}" ]; then
  echo "… 停止当前占用 3100 的进程 (pid=$OLD_PID)"
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
fi

# 2) 复制 unit 到系统目录
echo "… 安装 ${UNIT} → ${SYSTEMD_DIR}/"
cp "$(dirname "$0")/${UNIT}" "${SYSTEMD_DIR}/${UNIT}"
chown root:root "${SYSTEMD_DIR}/${UNIT}"
chmod 644 "${SYSTEMD_DIR}/${UNIT}"

# 3) 重载 systemd 并启用开机自启
echo "… systemctl daemon-reload"
systemctl daemon-reload
echo "… 启用开机自启"
systemctl enable "${UNIT}"

# 4) 启动服务
echo "… 启动服务"
systemctl start "${UNIT}"
sleep 1

# 5) 显示状态
echo ""
echo "=== 服务状态 ==="
systemctl --no-pager status "${UNIT}" | head -15
echo ""
echo "=== 健康检查 ==="
sleep 1
curl -s http://127.0.0.1:3100/health && echo "" || echo "健康检查失败"

echo ""
echo "🎉 安装完成！现在你可以关掉小黑窗，网关继续在后台运行。"
echo "   常用命令:"
echo "     systemctl status ${UNIT}          # 查看状态"
echo "     systemctl restart ${UNIT}         # 重启"
echo "     systemctl stop ${UNIT}            # 停止"
echo "     journalctl -u ${UNIT} -f          # 实时看日志"
echo "     journalctl -u ${UNIT} --since '5 min ago'  # 看最近5分钟"
