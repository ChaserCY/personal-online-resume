#!/usr/bin/env bash
#
# 在服务器上跑，把最新代码拉下来并重启服务。
#   sudo bash /opt/resume/deploy/deploy.sh
#
# 为什么敢用 git reset --hard：web/data/data.json 和 web/uploads/ 都在
# .gitignore 里，后台写的内容不归 git 管，所以不会被这个命令抹掉。

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/resume}"
SERVICE="${SERVICE:-resume-api}"
BRANCH="${BRANCH:-master}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

cd "$APP_DIR"

log "拉取 origin/$BRANCH"
git fetch --prune origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

log "检查数据文件"
if [ ! -f web/data/data.json ]; then
    cp web/data/data.seed.json web/data/data.json
    echo "    首次部署：已从 data.seed.json 初始化 data.json"
else
    echo "    已有 data.json，保持不动"
fi

log "安装后端依赖"
cd "$APP_DIR/server"
npm install --omit=dev --no-audit --no-fund

log "修正权限（后端以 www-data 运行，需要写 data/ 和 uploads/）"
mkdir -p "$APP_DIR/web/uploads" "$APP_DIR/server/backups"
chown -R www-data:www-data "$APP_DIR/web/data" "$APP_DIR/web/uploads" "$APP_DIR/server/backups"
# nginx 也要能读到静态文件
chmod -R a+rX "$APP_DIR/web"

log "重启服务"
systemctl restart "$SERVICE"
sleep 1
if systemctl is-active --quiet "$SERVICE"; then
    echo "    $SERVICE 运行中"
else
    echo "    启动失败，看日志： journalctl -u $SERVICE -n 50 --no-pager" >&2
    exit 1
fi

log "健康检查"
curl -fsS http://127.0.0.1:3001/api/health && echo "" || echo "    /api/health 无响应，检查日志" >&2

log "完成"
