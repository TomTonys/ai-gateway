#!/bin/bash
# ============================================================
#  为本机 Node 版本编译 better-sqlite3 原生模块
#
#  为什么需要它:
#    better-sqlite3 是原生模块，它的 .node 二进制与 Node 的 ABI 版本
#    (process.versions.modules) 强绑定。本项目的 node_modules 目录可能
#    被多个不同 Node 版本的环境共用（例如宿主机 systemd 跑 Node 18、
#    容器里跑 Node 24）。此时 node_modules 里只有一份二进制，
#    "谁最后 rebuild 谁赢"，另一边启动时会加载失败甚至段错误。
#
#  解决方式:
#    每个环境执行一次本脚本，产物按 ABI 命名放进 .native/，
#    启动时 src/db.js 会按当前 Node 的 ABI 精确选取，互不干扰。
#
#  用法:
#    bash native-build.sh          # 为当前 node 编译
#    bash native-build.sh --list   # 查看已编译的 ABI
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

# postinstall 内部调用 npm rebuild 时会再次触发 postinstall，这里直接跳过
if [ -n "${AIGW_NATIVE_BUILDING:-}" ]; then
  exit 0
fi

NATIVE_DIR=".native"
ABI="$(node -p 'process.versions.modules')"
NODE_VER="$(node -v)"
OUT="$NATIVE_DIR/better_sqlite3-node-v${ABI}.node"

if [ "${1:-}" = "--list" ]; then
  echo "当前 Node: $NODE_VER (ABI $ABI)"
  echo "已编译的产物:"
  if [ -d "$NATIVE_DIR" ] && ls "$NATIVE_DIR"/*.node >/dev/null 2>&1; then
    for f in "$NATIVE_DIR"/*.node; do
      printf '  %-45s %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
    done
  else
    echo "  (无)"
  fi
  exit 0
fi

echo "→ 为 Node $NODE_VER (ABI $ABI) 编译 better-sqlite3"
echo "  产物: $OUT"

mkdir -p "$NATIVE_DIR"

# 幂等：已有当前 ABI 的产物且可用时直接跳过（postinstall 会频繁调用）
if [ -f "$OUT" ] && [ "${1:-}" != "--force" ]; then
  if node -e "
    const D = require('better-sqlite3');
    const d = new D(':memory:', { nativeBinding: '$OUT' });
    d.exec('CREATE TABLE t(x)');
    d.close();
  " 2>/dev/null; then
    echo "✓ 已存在且可用，跳过编译（强制重编：bash native-build.sh --force）"
    exit 0
  fi
  echo "… 已有产物不可用，重新编译"
fi

# 防止 postinstall 递归触发
export AIGW_NATIVE_BUILDING=1

# 强制从源码编译，避免 prebuild-install 拿到别的 ABI 的预编译包
npm rebuild better-sqlite3 --build-from-source

BUILT="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -f "$BUILT" ]; then
  echo "✗ 编译产物不存在: $BUILT"
  exit 1
fi

cp "$BUILT" "$OUT"
echo "✓ 已生成 $OUT"

# 自检：确认当前 Node 能加载它
if node -e "
  const D = require('better-sqlite3');
  const d = new D(':memory:', { nativeBinding: '$OUT' });
  d.exec('CREATE TABLE t(x)');
  d.close();
" 2>/dev/null; then
  echo "✓ 自检通过（当前 Node 可正常加载）"
else
  echo "✗ 自检失败：产物无法被当前 Node 加载"
  exit 1
fi
