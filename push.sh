#!/usr/bin/env bash
# ============================================================
#  一键把当前项目改动提交并推送到 GitHub
#
#  用法:
#    ./push.sh                       # 提交全部改动（自动写 commit message）
#    ./push.sh "feat: xxx"           # 提交全部改动并指定 commit message
#
#  环境变量（可选覆盖）:
#    GITHUB_TOKEN   推送用的 PAT（默认读项目内 .github_token；该文件已被 git 忽略，不会入库）
#    GITHUB_REPO    目标仓库（默认 TomTonys/ai-gateway）
#    GITHUB_PROXY   代理地址（默认 http://192.168.31.69:1000，容器内 git 直连 GitHub 被墙时使用）
#
#  说明:
#    容器内 git 协议（github.com:443）不通，本脚本默认走 GitHub REST API 上传；
#    如果你在有直连 GitHub 的环境跑，可以设置 GITHUB_PROXY= 留空尝试 git push。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

REPO="${GITHUB_REPO:-TomTonys/ai-gateway}"
PROXY="${GITHUB_PROXY:-http://192.168.31.69:1000}"

# token: 优先环境变量，其次 .github_token 文件（git 已忽略）
TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .github_token ]; then
  TOKEN="$(cat .github_token | tr -d '[:space:]')"
fi
if [ -z "$TOKEN" ]; then
  echo "✗ 缺少 GitHub token：请设置 GITHUB_TOKEN 或创建 .github_token 文件（已被 gitignore，不会入库）" >&2
  exit 1
fi

# ---------- 1. 提交本地改动 ----------
git add -A
if git diff --cached --quiet; then
  echo "✓ 没有新改动需要提交"
else
  MSG="${1:-chore: update $(date +%Y-%m-%d\ %H:%M)}"
  git commit -m "$MSG"
  echo "✓ 已提交: $MSG"
fi

# 最终安全检查：暂存内容里绝不能有你的 API key 模式
if git show --stat HEAD -- . | grep -qE 'sk-[A-Za-z0-9]{20,}'; then
  echo "⚠ 检测到提交内容可能含密钥，请人工确认后继续"
  read -r -p "继续推送? (y/N) " ans || ans=N
  [ "$ans" = "y" ] || exit 0
fi

# ---------- 2. 探测通道 ----------
if [ -n "$PROXY" ]; then
  # 走代理：REST API 上传
  echo "… 通过代理 $PROXY 上传 (REST API)"
  python3 - "$REPO" "$TOKEN" "$PROXY" << 'PYEOF'
import json, os, sys, urllib.request, base64, subprocess

repo, token, proxy = sys.argv[1], sys.argv[2], sys.argv[3]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))

def gh(method, path, body=None):
    url = f'https://api.github.com{path}'
    headers = {'Authorization': f'token {token}', 'Accept': 'application/vnd.github+json', 'User-Agent': 'ai-gateway-push'}
    data = json.dumps(body).encode() if body else None
    if data: headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = opener.open(req, timeout=60)
        txt = resp.read().decode()
        return json.loads(txt) if txt else {}
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        print(f'  HTTP {e.code} {path}: {txt[:300]}')
        try: return json.loads(txt)
        except: return {'__raw': txt}

# 与远端 main 对比，找出有差异的文件（用 git diff 本地 vs 远端文件）
changed = subprocess.run(['git', 'diff', '--name-only', 'HEAD~1', 'HEAD'],
                         capture_output=True, text=True).stdout.split()
if not changed:  # 首次或历史特殊：全部上传
    changed = subprocess.run(['git', 'ls-files'], capture_output=True, text=True).stdout.split()

# 跳过被忽略的大文件/数据
skip_dirs = ('node_modules', 'data', 'docs', '.git')
changed = [f for f in changed if not any(f.startswith(s) for s in skip_dirs) and f]

print(f'  待上传 {len(changed)} 个文件')
for fp in changed:
    content = open(fp, 'rb').read()
    b64 = base64.b64encode(content).decode()
    cur = gh('GET', f'/repos/{repo}/contents/{urllib.parse.quote(fp)}?ref=main')
    body = {'message': f'chore: sync {fp}', 'content': b64, 'encoding': 'base64'}
    if cur.get('sha'): body['sha'] = cur['sha']
    res = gh('PUT', f'/repos/{repo}/contents/{urllib.parse.quote(fp)}', body)
    if 'commit' in res:
        print(f'  ✓ {fp} -> {res["commit"]["sha"][:8]}')
    else:
        print(f'  ✗ {fp}: {res}')
print('完成')
PYEOF
else
  # 无代理：尝试 git push（有直连 GitHub 的环境）
  echo "… 直连 git push"
  git remote set-url origin "https://x-access-token:${TOKEN}@github.com/${REPO}.git"
  git push origin main
  git remote set-url origin "https://github.com/${REPO}.git"
fi

echo ""
echo "✓ 已推送: https://github.com/$REPO"
