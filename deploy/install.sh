#!/usr/bin/env bash
#
# 首次部署脚本：把整个站点从「一份代码」变成「一个能访问的网站」。
# 在服务器上、仓库目录里跑：
#
#   sudo bash deploy/install.sh
#
# 想无人值守就把答案先放进环境变量：
#
#   sudo DOMAIN=resume.example.com ADMIN_PASSWORD='你的密码' EMAIL=you@example.com \
#        bash deploy/install.sh
#
# 它会做完这些事：
#   1. 装系统依赖：nginx、Node.js 20、certbot（要 HTTPS 才装）
#   2. 把代码放到 /opt/resume（已经在那儿就跳过）
#   3. 生成 server/.env，写上后台密码和一个随机的 SESSION_SECRET，权限 600
#   4. npm install --omit=dev
#   5. 铺一份示例 data.json（已经有了就不动）
#   6. 装 systemd 服务 resume-api 并启动，跑一次 /api/health
#   7. 写 nginx 站点配置、去掉默认站点、reload
#   8. 域名解析好的话签一张 Let's Encrypt 证书并开启 80 → 443 跳转
#   9. 打印前台 / 后台地址和后台密码
#
# 可以重复跑：已经装好的部分会跳过，data.json 和 web/uploads/ 不会被覆盖。
# 装完之后日常更新用 deploy/deploy.sh，那个只拉代码 + 重启服务。
#
# 只在 Debian / Ubuntu 上测过（apt + systemd + nginx 的 sites-available 布局）。
# CentOS / RHEL / AlmaLinux / Arch / macOS 请照着 README 的「手动版」做，
# 或者自己把 apt-get、systemd 单元、nginx 路径这几处换成本系统的写法。

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

# 回车就用 123456。图省事可以，但站点是公开的，后台谁都能登 ——
# 真上线的话强烈建议在这里填一个自己的密码，或者装完去改 server/.env。
DEFAULT_PASSWORD=123456
ask_secret ADMIN_PASSWORD "后台登录密码（回车用默认的 $DEFAULT_PASSWORD）"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$DEFAULT_PASSWORD}"

# .env 是 KEY="value" 这种格式，这几个字符会把文件写坏
case "$ADMIN_PASSWORD" in
    *'"'*|*'\'*|*'$'*|*'`'*|*'#'*)
        die '密码里不要有 " \ $ ` # 这几个字符，换成字母数字组合。' ;;
esac
[ ${#ADMIN_PASSWORD} -ge 6 ] || die "密码太短了，至少 6 位。"
[ "$ADMIN_PASSWORD" = "$DEFAULT_PASSWORD" ] && WEAK_PASSWORD=1 || WEAK_PASSWORD=0

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
apt-get install -y -qq ca-certificates curl gnupg openssl nginx >/dev/null

# 系统防火墙。放行 SSH 再 enable，顺序反了会把自己关在门外。
# 注意：这只管机器里的 ufw，云厂商控制台的**安全组**得你自己去开 80/443，
# 阿里云腾讯云的实例默认只开 22，不开的话外面照样访问不到。
if command -v ufw >/dev/null 2>&1; then
    ufw allow OpenSSH >/dev/null 2>&1 || true
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    ufw --force enable >/dev/null 2>&1 || true
    ok "ufw 已放行 22 / 80 / 443"
fi

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

# deploy.sh 要用 sudo 跑（它得 restart systemd 服务），也就是说 git 会以 root 身份
# 操作一个别人 clone 下来的仓库。git 2.35.2 起会因此报 "detected dubious ownership"
# 直接拒绝干活，所以先把 APP_DIR 加进 root 的 safe.directory。
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

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
    # 640 root:www-data —— 服务以 www-data 跑，systemd 读 EnvironmentFile 时
    # 有的版本是按服务用户去读的，给 600 root:root 会直接起不来。
    # 组读就够了，不用给 other。
    chown root:www-data "$APP_DIR/server/.env"
    chmod 640 "$APP_DIR/server/.env"
    ok "已生成（权限 640 root:www-data，只有 root 和 www-data 读得到）"
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
    后台密码    $ADMIN_PASSWORD
                （存在 $APP_DIR/server/.env，改完 systemctl restart $SERVICE）

    接下来      打开后台 → 登录 → 左边「简历 PDF」→ 传你的简历
                姓名、简介、技能、作品会自动跟着简历更新
                视频是独立的一块，在「视频」面板手动加，不受简历影响

    日常更新    sudo bash $APP_DIR/deploy/deploy.sh
    看日志      journalctl -u $SERVICE -f

EOF

if [ "$WEAK_PASSWORD" = "1" ]; then
    cat <<EOF
$(printf '\033[1;33m注意：后台密码还是默认的 %s。\033[0m' "$ADMIN_PASSWORD")
    站点是公开的，知道这个默认值的人都能登进后台改内容。要改的话：

        sudo sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD="你的新密码"/' $APP_DIR/server/.env
        sudo systemctl restart $SERVICE

EOF
fi
