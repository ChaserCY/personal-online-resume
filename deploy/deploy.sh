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
SITE_NAME="${SITE_NAME:-resume}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

# 端口以 server/.env 为准 —— install.sh 支持 PORT=xxxx，这里不能再写死 3001，
# 否则换过端口的机器每次更新都会报「健康检查失败」，而站点其实是好的。
# 读不到 / 读到怪东西就退回 3001（和 server/index.js 的默认值一致）。
# 两个 `|| true` 不能省：set -e + pipefail 下，sed 读不到文件会让脚本直接退出。
PORT=3001
if [ -f "$APP_DIR/server/.env" ]; then
    PORT="$(sed -n 's/^PORT=//p' "$APP_DIR/server/.env" 2>/dev/null | tr -d '"[:space:]' | tail -n1 || true)"
    case "$PORT" in
        '' | *[!0-9]*) PORT=3001 ;;
    esac
fi

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
echo "    后端 127.0.0.1:$PORT/api/health"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" && echo "" \
    || echo "    /api/health 无响应，检查日志： journalctl -u $SERVICE -n 50 --no-pager" >&2

# 后端活着不代表访客能打开 —— nginx 的 proxy_pass 要是还指着旧端口，
# /api/ 全是 502 而上面那条检查是绿的。顺手对一下，能省掉一轮排查。
NGINX_SITE="/etc/nginx/sites-available/$SITE_NAME"
if [ -f "$NGINX_SITE" ]; then
    NGINX_PORT="$(sed -n 's/.*proxy_pass http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$NGINX_SITE" | head -n1 || true)"
    if [ -n "$NGINX_PORT" ] && [ "$NGINX_PORT" != "$PORT" ]; then
        echo "    [警告] nginx 的 proxy_pass 指向 $NGINX_PORT，而 .env 里是 $PORT —— 访客会看到 502。" >&2
        echo "           改一处：sudo sed -i 's|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:$PORT;|' $NGINX_SITE && sudo systemctl reload nginx" >&2
    fi
fi

log "完成"
