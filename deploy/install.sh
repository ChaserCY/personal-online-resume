#!/usr/bin/env bash
#
# 一键部署。在服务器上、仓库目录里跑：
#   sudo bash deploy/install.sh
#
# 想无人值守就把答案先放进环境变量：
#   sudo DOMAIN=resume.example.com ADMIN_PASSWORD='你的密码' EMAIL=you@example.com \
#        bash deploy/install.sh
#
# 脚本可以重复跑：已经装好的部分会跳过，data.json 和 uploads 不会被覆盖。
# 装完之后日常更新用 deploy/deploy.sh，那个只拉代码 + 重启服务。

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/resume}"
SERVICE="${SERVICE:-resume-api}"
SITE_NAME="${SITE_NAME:-resume}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$1" >&2; }
die()  { printf '\n\033[1;31m[x] %s\033[0m\n' "$1" >&2; exit 1; }

# ---------- 0. 前提检查 ----------

[ "$(id -u)" -eq 0 ] || die "请用 root 跑：sudo bash deploy/install.sh"
command -v apt-get >/dev/null 2>&1 || die "这个脚本只支持 Debian/Ubuntu。其它发行版照着 README 手动装。"

[ -f "$REPO_DIR/server/index.js" ] || die "没找到 server/index.js，请在仓库根目录里跑这个脚本。"
[ -f "$REPO_DIR/deploy/nginx.conf" ] || die "没找到 deploy/nginx.conf，代码不完整。"

# ---------- 1. 问几个问题 ----------

ask() {  # ask <变量名> <提示语> [默认值]
    local __var="$1" __prompt="$2" __default="${3:-}" __answer=""
    if [ -n "${!__var:-}" ]; then return; fi
    [ -t 0 ] || die "当前不是交互终端，请用环境变量提供 $__var"
    # || true：按 Ctrl-D 时 read 返回非零，不加的话 set -e 会让脚本一声不响地退出
    read -rp "    $__prompt${__default:+ [$__default]}: " __answer || true
    printf -v "$__var" '%s' "${__answer:-$__default}"
}

ask_secret() {  # 同上，但输入不回显
    local __var="$1" __prompt="$2" __answer=""
    if [ -n "${!__var:-}" ]; then return; fi
    [ -t 0 ] || die "当前不是交互终端，请用环境变量提供 $__var"
    read -rsp "    $__prompt: " __answer || true
    echo ""
    printf -v "$__var" '%s' "$__answer"
}

log "准备部署到 $APP_DIR"

ask DOMAIN "域名或公网 IP（nginx 的 server_name）"
[ -n "$DOMAIN" ] || die "必须给一个域名或 IP。"

ask_secret ADMIN_PASSWORD "后台登录密码（回车则随机生成一个）"
if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' || true)"
    ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')}"
    GENERATED_PASSWORD=1
fi
# .env 是 KEY="value" 这种格式，这几个字符会把文件写坏
case "$ADMIN_PASSWORD" in
    *'"'*|*'\'*|*'$'*|*'`'*|*'#'*)
        die '密码里不要有 " \ $ ` # 这几个字符，换成字母数字组合。' ;;
esac
[ ${#ADMIN_PASSWORD} -ge 8 ] || die "密码太短了，至少 8 位。"

# 只有「像域名」才申请证书；纯 IP 没法签，直接跳过
WANT_HTTPS=0
if [[ "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    warn "server_name 是 IP，跳过 HTTPS（IP 签不了证书）"
elif [ "${SKIP_HTTPS:-0}" = "1" ]; then
    warn "SKIP_HTTPS=1，跳过 HTTPS"
else
    ask EMAIL "邮箱（申请 Let's Encrypt 证书用，留空则不配 HTTPS）"
    [ -n "$EMAIL" ] && WANT_HTTPS=1
fi

# ---------- 2. 系统依赖 ----------

log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg nginx >/dev/null

# node 18 起步：mupdf 和 express 都要它
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi
if [ "$NODE_MAJOR" -lt 18 ]; then
    ok "安装 Node.js 20（当前版本 $NODE_MAJOR）"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
else
    ok "Node.js $(node -v) 已满足要求"
fi
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || die "node 装完还是找不到，检查 PATH。"

if [ "$WANT_HTTPS" = "1" ]; then
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    ok "certbot 已装"
fi

# ---------- 3. 把代码放到 APP_DIR ----------

log "放置代码到 $APP_DIR"
if [ "$REPO_DIR" = "$APP_DIR" ]; then
    ok "代码已经在 $APP_DIR，跳过复制"
else
    mkdir -p "$APP_DIR"
    # 用 tar 而不是 rsync：tar 每个系统都有。
    # 排除的都是运行时内容 —— 本地那份 data.json / uploads 不该盖掉服务器上的。
    tar -C "$REPO_DIR" \
        --exclude=./.git \
        --exclude=./.claude \
        --exclude=./server/node_modules \
        --exclude=./server/.env \
        --exclude=./server/backups \
        --exclude=./web/data/data.json \
        --exclude=./web/uploads \
        -cf - . | tar -C "$APP_DIR" -xf -
    ok "已复制（.git / node_modules / .env / data.json / uploads 已排除）"
fi

# ---------- 4. 写 .env ----------

log "配置 server/.env"
if [ -f "$APP_DIR/server/.env" ]; then
    ok "已存在，保持不动（改密码就编辑它，然后 systemctl restart $SERVICE）"
else
    # 签名密钥单独随机：以后改密码不会把已登录的浏览器全踢掉
    SECRET="$(openssl rand -hex 32 2>/dev/null || "$NODE_BIN" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    cat > "$APP_DIR/server/.env" <<EOF
# 由 deploy/install.sh 生成。改完记得 systemctl restart $SERVICE
ADMIN_PASSWORD="$ADMIN_PASSWORD"
SESSION_SECRET="$SECRET"
TOKEN_TTL_HOURS=168
PORT=3001
HOST=127.0.0.1
MAX_UPLOAD_MB=5
MAX_PDF_MB=10
EOF
    chmod 600 "$APP_DIR/server/.env"
    chown root:root "$APP_DIR/server/.env"
    ok "已生成（权限 600，只有 root 读得到）"
fi

# ---------- 5. 依赖 + 初始内容 ----------

log "安装后端依赖"
( cd "$APP_DIR/server" && npm install --omit=dev --no-audit --no-fund >/dev/null )
ok "npm install 完成"

log "准备数据文件"
mkdir -p "$APP_DIR/web/data" "$APP_DIR/web/uploads" "$APP_DIR/server/backups"
if [ -f "$APP_DIR/web/data/data.json" ]; then
    ok "已有 data.json，保持不动"
else
    cp "$APP_DIR/web/data/data.seed.json" "$APP_DIR/web/data/data.json"
    ok "已从 data.seed.json 生成示例内容（登录后台改成你自己的）"
fi

log "修正权限（后端以 www-data 运行）"
chown -R www-data:www-data "$APP_DIR/web/data" "$APP_DIR/web/uploads" "$APP_DIR/server/backups"
chmod -R a+rX "$APP_DIR/web"
ok "web/data、web/uploads、server/backups 归 www-data"

# ---------- 6. systemd ----------

log "安装 systemd 服务"
sed -e "s|/opt/resume/server|$APP_DIR/server|g" \
    -e "s|/usr/bin/node|$NODE_BIN|g" \
    "$APP_DIR/deploy/resume-api.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || {
    journalctl -u "$SERVICE" -n 30 --no-pager >&2
    die "$SERVICE 起不来，日志见上。"
}
ok "$SERVICE 正在运行"

curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1 \
    && ok "API 健康检查通过" \
    || warn "API 没响应，journalctl -u $SERVICE -n 50 看看"

# ---------- 7. nginx ----------

log "配置 nginx"
sed -e "s|server_name resume.example.com;|server_name $DOMAIN;|" \
    -e "s|root /opt/resume/web;|root $APP_DIR/web;|" \
    "$APP_DIR/deploy/nginx.conf" > "/etc/nginx/sites-available/$SITE_NAME"

ln -sf "/etc/nginx/sites-available/$SITE_NAME" "/etc/nginx/sites-enabled/$SITE_NAME"
# 默认站点会抢 80 端口，先让开
rm -f /etc/nginx/sites-enabled/default

if ! nginx -t >/dev/null 2>&1; then
    # 有些小厂的机器没开 IPv6，listen [::]:80 会让 nginx -t 直接失败
    warn "nginx 配置检查没过，去掉 IPv6 监听再试一次"
    sed -i '/listen \[::\]:80;/d' "/etc/nginx/sites-available/$SITE_NAME"
fi
nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx 配置有问题，见上。"; }
systemctl reload nginx
ok "nginx 已加载 $SITE_NAME"

# ---------- 8. HTTPS ----------

if [ "$WANT_HTTPS" = "1" ]; then
    log "申请 HTTPS 证书"
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
        ok "证书已装好，80 会自动跳 443"
    else
        warn "证书没申请成功。常见原因：域名还没解析到这台机器，或者 80 端口被墙。"
        warn "解析好之后重跑： certbot --nginx -d $DOMAIN --redirect"
    fi
fi

# ---------- 9. 收尾 ----------

SCHEME="http"
[ "$WANT_HTTPS" = "1" ] && SCHEME="https"

cat <<EOF

$(printf '\033[1;32m部署完成\033[0m')

    前台        $SCHEME://$DOMAIN/
    后台        $SCHEME://$DOMAIN/admin.html
$(if [ "${GENERATED_PASSWORD:-0}" = "1" ]; then
    printf '\n    \033[1;33m后台密码（随机生成的，记下来）: %s\033[0m\n' "$ADMIN_PASSWORD"
    printf '    存在 %s/server/.env 里，也能自己改\n' "$APP_DIR"
fi)
    接下来      打开后台 → 登录 → 左边「简历 PDF」→ 传你的简历
                姓名、简介、技能、作品会自动跟着简历更新
                视频是独立的一块，在「视频」面板手动加，不受简历影响

    日常更新    sudo bash $APP_DIR/deploy/deploy.sh
    看日志      journalctl -u $SERVICE -f

EOF
