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
# 不想要 nginx、不想动防火墙、或者要换端口，用下面这几个开关（默认值和以前一样）：
#
#   sudo SKIP_NGINX=1 bash deploy/install.sh            # 不装 nginx、不申请证书
#   sudo SKIP_NGINX=1 PORT=3005 bash deploy/install.sh  # 顺带换后端端口
#   sudo SKIP_UFW=1 bash deploy/install.sh              # 不碰 ufw
#   sudo HOST=0.0.0.0 bash deploy/install.sh            # 后端直接对外（没有反代时才用）
#
# 开关必须写在 sudo 后面。`export SKIP_NGINX=1` 再 sudo 是不行的 ——
# sudo 默认会把继承来的环境变量清掉，开关会被静默丢弃，nginx 照样装上。
#
# 它会做完这些事：
#   1. 装系统依赖：Node.js 20、nginx、certbot（要 HTTPS 才装后两个）
#   2. 把代码放到 /opt/resume（已经在那儿就跳过）
#   3. 生成 server/.env，写上后台密码和一个随机的 SESSION_SECRET，权限 600
#   4. npm install --omit=dev
#   5. 铺一份示例 data.json（已经有了就不动）
#   6. 装 systemd 服务 resume-api 并启动，跑一次 /api/health
#   7. 写 nginx 站点配置、去掉默认站点、reload（SKIP_NGINX=1 时第 7、8 步整段跳过）
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

# ---------- 0.5 开关 ----------
#
# 四个开关都走环境变量，默认值和没有开关的时候完全一样。
# 要加新开关就照这个写法：默认值 + 前置校验 + 在下面每一步里判断，
# 千万别让「没传开关」的路径行为和以前不一样。

SKIP_NGINX="${SKIP_NGINX:-0}"   # 1 = 完全不碰 nginx（反代 / 面板自己管）
SKIP_UFW="${SKIP_UFW:-0}"       # 1 = 完全不碰 ufw
PORT="${PORT:-3001}"            # 后端监听端口
HOST="${HOST:-127.0.0.1}"       # 后端监听地址，0.0.0.0 = 直接对外

# 只认 0/1。写成 SKIP_NGINX=true 这种「看着像开了」的值就直接报错 ——
# 否则用户以为跳过了 nginx，装完才发现两套 nginx 又在抢 80 端口。
for __sw in SKIP_NGINX SKIP_UFW; do
    case "${!__sw}" in
        0 | 1) ;;
        *) die "$__sw 只能是 0 或 1（当前是「${!__sw}」）" ;;
    esac
done

case "$PORT" in
    '' | *[!0-9]*) die "PORT 只能是数字（当前是「$PORT」）" ;;
esac
# 服务以 www-data 跑，绑不了 1024 以下的特权端口（80 / 443 也归 nginx）
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
    die "PORT 要在 1024-65535 之间（当前是 $PORT）"
fi

# 只允许这两个。写 ::1 / 具体网卡 IP 之类的会让脚本里的健康检查
# （打 127.0.0.1）和 ufw 判断对不上，不如直接拦住。
case "$HOST" in
    127.0.0.1 | 0.0.0.0) ;;
    *) die "HOST 只能是 127.0.0.1（默认，前面挂反代）或 0.0.0.0（后端直接对外）。当前是「$HOST」" ;;
esac

# ---------- 0.6 已经装过的话，端口以 server/.env 为准 ----------
#
# 这段必须在任何用到 $PORT 的地方之前跑（ufw、健康检查、nginx 模板都吃它）。
# 不这么做的话会出现最难查的错配：服务还在旧端口上跑，脚本却去新端口做健康检查、
# 还把 nginx 的 proxy_pass 改到新端口 —— 装完访客全是 502，脚本自己却报成功。
ENV_FILE="$APP_DIR/server/.env"
if [ -f "$ENV_FILE" ]; then
    ENV_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tr -d '"[:space:]' | tail -n1 || true)"
    case "$ENV_PORT" in
        '' | *[!0-9]*) ENV_PORT="" ;;
    esac
    if [ -n "$ENV_PORT" ] && [ "$ENV_PORT" != "$PORT" ]; then
        warn "server/.env 里已经是 PORT=$ENV_PORT，本次沿用（不覆盖已装好的配置）"
        warn "真要换端口：改 $ENV_FILE 的 PORT，同步改 nginx 的 proxy_pass，"
        warn "再 systemctl restart $SERVICE —— 三处漏一处就是 502"
        PORT="$ENV_PORT"
    fi
    # HOST 同理：.env 里是 0.0.0.0 的话，本次也得知道，否则 ufw 那步会少开一个口子
    ENV_HOST="$(sed -n 's/^HOST=//p' "$ENV_FILE" 2>/dev/null | tr -d '"[:space:]' | tail -n1 || true)"
    case "$ENV_HOST" in
        127.0.0.1 | 0.0.0.0) HOST="$ENV_HOST" ;;
    esac
fi

# 宝塔 / 类似面板自带一套 nginx（/www/server/nginx），和本脚本要装的 apt nginx
# 都在抢 80 端口，两套没法共存（一个端口不可能同时归两个服务）。
# 检测到就提前说明白，别等装完才发现站点打不开、排查半天。
if [ -d /www/server/nginx ] || [ -d /www/server/panel ] || command -v bt >/dev/null 2>&1; then
    if [ "$SKIP_NGINX" = "1" ]; then
        warn "检测到宝塔面板，SKIP_NGINX=1：本次不装 nginx、不碰 80/443、不申请证书，没有冲突。"
        warn "装完之后在面板里加站点："
        warn "  根目录    $APP_DIR/web"
        warn "  反代      /api/ → http://127.0.0.1:$PORT"
        warn "  整段配置和几个坑见 README 的「宝塔面板」一节"
        warn "────────────────────────────────────────────────────"
    else
        warn "检测到宝塔面板（它自带一套 nginx）。"
        warn "这脚本会再装一套 apt nginx，两套会抢 80 端口互相打架（bind() to 0.0.0.0:80 failed）。"
        warn "两条路，选一个："
        warn "  1) 用宝塔托管本站点（推荐，以后宝塔还能加别的网站）"
        warn "     让本脚本只装后端、nginx 归面板："
        warn "         sudo SKIP_NGINX=1 bash deploy/install.sh"
        warn "     然后照 README「宝塔面板」一节在面板里加站点。"
        warn "  2) 坚持用本脚本管 nginx：先去宝塔里把它的 nginx 停掉并关闭开机自启"
        warn "     （软件商店 → Nginx → 停止 / 设置），再回来跑。"
        warn "────────────────────────────────────────────────────"
    fi
fi

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

if [ "$SKIP_NGINX" = "1" ]; then
    warn "SKIP_NGINX=1：不装 nginx、不申请证书，静态文件交给你自己的反代托管"
    # 收尾那段要打印地址，set -u 下没定义会直接炸在最后一步
    DOMAIN="${DOMAIN:-}"
else
    ask DOMAIN "域名或公网 IP（nginx 的 server_name）"
    [ -n "$DOMAIN" ] || die "必须给一个域名或 IP。"
fi

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

# 只有「像域名」才申请证书；纯 IP 没法签，直接跳过。
# SKIP_NGINX=1 时连 certbot 都不装 —— Debian/Ubuntu 的 python3-certbot-nginx
# 依赖 nginx 包，装了会把 apt nginx 一起拖回来，正好又变成抢 80 端口那件事。
WANT_HTTPS=0
if [ "$SKIP_NGINX" = "1" ]; then
    : # 没装 nginx，certbot --nginx 用不了；证书归面板 / 你自己的反代
elif [[ "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    warn "server_name 是 IP，跳过 HTTPS（IP 签不了证书）"
elif [ "${SKIP_HTTPS:-0}" = "1" ]; then
    warn "SKIP_HTTPS=1，跳过 HTTPS"
else
    ask EMAIL "邮箱（申请 Let's Encrypt 证书用，留空则不配 HTTPS）"
    if [ -n "$EMAIL" ]; then WANT_HTTPS=1; fi
fi

# ---------- 2. 系统依赖 ----------
#
# 这一段是全程最慢的（国内机器 apt 走默认源可能要 5～10 分钟），所以刻意
# 不用 -qq 把 apt 的输出吞掉：卡住的时候至少能看出是卡在哪一行。
# 下面这些 apt 调用也别改成 >/dev/null，那会让人以为脚本死了。

log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
# Ubuntu 22.04 起自带 needrestart。apt 装完包它会弹一个全屏的
# 「Which services should be restarted?」，那个界面不吃 DEBIAN_FRONTEND，
# 会把无人值守的 apt 卡在那儿等人按键。设成 a 让它自己决定。
export NEEDRESTART_MODE=a

# 新开的云服务器常在跑 unattended-upgrades，它占着 dpkg 锁，
# 我们的 apt 会在那儿默默排队，看起来跟卡死一样。先说一声再等。
#
# 进程名在 /proc 里最多 15 个字符，所以 unattended-upgrades 要写成 unattended-upgr。
# 注意 "unattended-upgrades" 里没有 "apt" 这个连续子串（是 a-t-t 不是 a-p-t），
# 所以 `ps aux | grep apt` 看不见它 —— 下面提示里给的命令一定要带上 unattended。
DPKG_LOCK_HINT="ps aux | grep -iE 'apt|dpkg|unattended' | grep -v grep"

# 打印正在占用锁的进程，等的人不用自己去猜是哪个
dpkg_busy_pids() {
    pgrep -x apt-get 2>/dev/null
    pgrep -x apt 2>/dev/null
    pgrep -x dpkg 2>/dev/null
    pgrep -x unattended-upgr 2>/dev/null
}

dpkg_busy() {
    [ -n "$(dpkg_busy_pids)" ]
}

wait_for_dpkg() {
    if ! dpkg_busy; then
        return 0
    fi
    # 先把「在等谁」亮出来，省得人在那儿干瞪眼
    local pids
    pids="$(dpkg_busy_pids | tr '\n' ' ')"
    warn "锁被占着，在等这些进程跑完："
    for p in $pids; do
        warn "    PID $p  $(ps -p "$p" -o comm=,etime= 2>/dev/null || echo '(读不到)')"
    done
    warn "（多半是云服务器开机的自动更新 unattended-upgrades，慢的能跑十几分钟）"
    warn "不想等就另开一个窗口停掉它：sudo systemctl stop unattended-upgrades"
    warn "停了之后这里会自动继续，不用重跑脚本。"

    local i=0
    while dpkg_busy; do
        sleep 3
        i=$((i + 1))
        if [ $((i % 10)) -eq 0 ]; then
            warn "还在等（已 $((i * 3)) 秒）—— 另开一个窗口：$DPKG_LOCK_HINT"
        fi
        if [ "$i" -gt 200 ]; then
            die "等了 10 分钟还没等到。手动看看谁占着： $DPKG_LOCK_HINT
      也可以直接看锁本身： sudo fuser -v /var/lib/dpkg/lock-frontend
      实在不想等： sudo systemctl stop unattended-upgrades
      然后重跑这个脚本。"
        fi
    done
    ok "锁拿到了，继续"
}

wait_for_dpkg
# 上一次跑被打断（SSH 掉线、Ctrl+C）会留下 pending trigger，
# 或者更糟：包装了一半。这两条都是幂等的，没事就跑一下。
if ! dpkg --audit 2>/dev/null | grep -q .; then
    : # dpkg 库是干净的，什么都不用做
else
    warn "dpkg 里还有没做完的事（多半是上次被打断留下的），先收拾干净"
    dpkg --configure --pending
    dpkg --audit 2>/dev/null | grep -q . && die "dpkg 还是没收拾干净，先把上面那段输出发给懂的人看看"
    ok "收拾干净了"
fi

echo "    apt-get update（国内机器走默认源可能要几分钟，会刷很多行，别急着 Ctrl+C）"
apt-get update -q

wait_for_dpkg
# SKIP_NGINX=1 时连 nginx 包都不装。apt 装它会顺手 enable + start，
# 下次开机就绑上 0.0.0.0:80 —— 正是这个开关要避免的那件事，
# 而且发生在脚本刚说完「已跳过 nginx」之后，最难解释。
APT_PKGS="ca-certificates curl gnupg openssl xz-utils"
if [ "$SKIP_NGINX" != "1" ]; then
    APT_PKGS="$APT_PKGS nginx"
fi
# 故意不加引号：让 shell 按空格拆成多个包名
# shellcheck disable=SC2086
apt-get install -y -q $APT_PKGS

# 系统防火墙。放行 SSH 再 enable，顺序反了会把自己关在门外。
# 注意：这只管机器里的 ufw，云厂商控制台的**安全组**得你自己去开 80/443，
# 阿里云腾讯云的实例默认只开 22，不开的话外面照样访问不到。
if [ "$SKIP_UFW" = "1" ]; then
    warn "SKIP_UFW=1，不动防火墙。自己确认这些端口是通的：22（SSH）、80 / 443"
    warn "（云厂商控制台的**安全组**是另一回事，脚本管不了）"
elif command -v ufw >/dev/null 2>&1; then
    ufw allow OpenSSH >/dev/null 2>&1 || true
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    # 后端直接对外时才开这个口子。走反代的话反代和 node 在同一台机器上，
    # 把后端端口暴露到公网纯属多余。
    if [ "$HOST" != "127.0.0.1" ]; then
        ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
    fi
    ufw --force enable >/dev/null 2>&1 || true
    if [ "$HOST" != "127.0.0.1" ]; then
        ok "ufw 已放行 22 / 80 / 443 / $PORT（HOST=$HOST，后端直接对外）"
    else
        # SKIP_NGINX=1 时 80/443 是留给面板/反代自己那套 nginx 的，别关
        ok "ufw 已放行 22 / 80 / 443"
    fi
fi

# node 18 起步：mupdf 和 express 都要它。
# 三级降级：已有的 → NodeSource 的 deb 源 → 官方二进制包（走国内镜像）。
# 之所以要第三级：deb.nodesource.com 在国内经常连得上但龟速，或者干脆连不上，
# 而 apt 装的 nodejs 在 Ubuntu 22.04 上只有 v12，不够用。
install_node_tarball() {
    local arch url tmp
    arch="$(uname -m)"
    case "$arch" in
        x86_64 | amd64) arch=x64 ;;
        aarch64 | arm64) arch=arm64 ;;
        *)
            warn "不认识的架构 $arch，没法自动下 Node"
            return 1
            ;;
    esac
    echo "    从 npmmirror 找 Node 20 的 linux-$arch 包……"
    url="$(curl -fsSL --max-time 30 'https://registry.npmmirror.com/-/binary/node/latest-v20.x/' |
        grep -o "https://[^\"]*linux-${arch}\.tar\.xz" | sort -V | tail -1)"
    if [ -z "$url" ]; then
        warn "镜像里没找到合适的包"
        return 1
    fi
    echo "    $url"
    tmp="$(mktemp -d)"
    if ! curl -fL --max-time 900 --progress-bar -o "$tmp/node.tar.xz" "$url"; then
        rm -rf "$tmp"
        return 1
    fi
    # 解到 /usr/local 下就是 bin/node、bin/npm、lib/node_modules，在 PATH 里
    tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1 \
        --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
    rm -rf "$tmp"
    hash -r 2>/dev/null || true
    return 0
}

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi

if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "Node.js $(node -v) 已满足要求"
else
    echo "    当前 Node.js 是 v$NODE_MAJOR，需要装 20。依次试这两条路："
    echo "      1) deb.nodesource.com（限时 60 秒，国内经常慢或连不上）"
    echo "      2) npmmirror 上的官方二进制包（国内快）"

    node_ok=0
    if curl -fsSL --max-time 60 https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh; then
        if bash /tmp/nodesource_setup.sh; then
            wait_for_dpkg
            if apt-get install -y -q nodejs; then
                node_ok=1
            fi
        fi
        rm -f /tmp/nodesource_setup.sh
    else
        warn "连不上 deb.nodesource.com（国内常见），直接走镜像"
    fi

    if [ "$node_ok" != "1" ]; then
        if install_node_tarball; then
            node_ok=1
        else
            die "两条路都没装成。手动装一个 Node >= 18（见 README 的「排查」）再重跑这个脚本。"
        fi
    fi
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$NODE_MAJOR" -lt 18 ]; then
        die "装完还是 v$NODE_MAJOR，不对。检查一下 which -a node。"
    fi
    ok "Node.js $(node -v) 装好了"
fi
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || die "node 装完还是找不到，检查 PATH。"

if [ "$WANT_HTTPS" = "1" ]; then
    wait_for_dpkg
    apt-get install -y -q certbot python3-certbot-nginx
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
PORT=$PORT
HOST=$HOST
MAX_UPLOAD_MB=5
MAX_PDF_MB=10
BACKUP_INTERVAL_MINUTES=10
BACKUP_KEEP=20
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

curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
    && ok "API 健康检查通过（127.0.0.1:$PORT）" \
    || warn "API 没响应，journalctl -u $SERVICE -n 50 看看"

# ---------- 7. nginx ----------

NGINX_SITE="/etc/nginx/sites-available/$SITE_NAME"

if [ "$SKIP_NGINX" = "1" ]; then
    log "跳过 nginx（SKIP_NGINX=1）"
    ok "静态文件交给你自己的反代：根目录 $APP_DIR/web，/api/ 转给 127.0.0.1:$PORT"
else
    log "配置 nginx"

    # 已经配过 HTTPS 的站点文件里带着 certbot 写进去的 listen 443 段和 80→443 跳转。
    # 直接覆盖会把 HTTPS 弄没，而 nginx -t 照样通过 —— 症状是「更新完突然只剩 http」。
    if [ -f "$NGINX_SITE" ] && grep -q 'listen 443' "$NGINX_SITE"; then
        warn "$NGINX_SITE 里已经有 HTTPS 配置（certbot 写进去的），本次不覆盖它"
        warn "只是要改端口的话："
        warn "  sudo sed -i 's|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:$PORT;|' $NGINX_SITE"
        warn "  sudo nginx -t && sudo systemctl reload nginx"
    else
        sed -e "s|server_name resume.example.com;|server_name $DOMAIN;|" \
            -e "s|root /opt/resume/web;|root $APP_DIR/web;|" \
            -e "s|proxy_pass http://127.0.0.1:3001;|proxy_pass http://127.0.0.1:$PORT;|" \
            "$APP_DIR/deploy/nginx.conf" > "$NGINX_SITE"

        # sed 没匹配上时一声不吭，nginx 照样能 reload，只是 /api/ 全 502 ——
        # 而后端健康检查一切正常，是最难查的那种。所以这里必须验一下。
        grep -q "proxy_pass http://127.0.0.1:$PORT;" "$NGINX_SITE" \
            || die "nginx 配置里的 proxy_pass 没改成 $PORT（deploy/nginx.conf 的格式被改过？）。
      不改就 reload 的话 /api/ 会全部 502，后端却是好的。手动改：
        sudo sed -i 's|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:$PORT;|' $NGINX_SITE
        sudo nginx -t && sudo systemctl reload nginx"
    fi

    ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/$SITE_NAME"
    # 默认站点会抢 80 端口，先让开
    rm -f /etc/nginx/sites-enabled/default

    if ! nginx -t >/dev/null 2>&1; then
        # 有些小厂的机器没开 IPv6，listen [::]:80 会让 nginx -t 直接失败
        warn "nginx 配置检查没过，去掉 IPv6 监听再试一次"
        sed -i '/listen \[::\]:80;/d' "$NGINX_SITE"
    fi
    nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx 配置有问题，见上。"; }

    # 有的人 apt 装 nginx 时没自动启动它（装到一半被打断就会这样），
    # reload 一个没在跑的服务会直接报错。所以先 ensure 起来 + 开机自启，
    # 然后 reload-or-restart：在跑就热加载，没跑就启动。
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl reload-or-restart nginx
    systemctl is-active --quiet nginx || die "nginx 起不来，journalctl -u nginx -n 30 看看。"
    ok "nginx 已加载 $SITE_NAME"
fi

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

if [ "$SKIP_NGINX" = "1" ]; then
    cat <<EOF

$(printf '\033[1;32m部署完成\033[0m')（SKIP_NGINX=1：没装 nginx、没申请证书）

    后端 API    http://127.0.0.1:$PORT/api/health
    站点根目录  $APP_DIR/web              ← 反代 / 面板里填这个
    反代目标    http://127.0.0.1:$PORT      ← 只需要把 /api/ 转过去
    后台密码    $ADMIN_PASSWORD
                （存在 $APP_DIR/server/.env，改完 systemctl restart $SERVICE）

    还要做      1) 在你的反代 / 面板里加站点：
                   根目录 $APP_DIR/web，/api/ 转给 127.0.0.1:$PORT
                   （README「宝塔面板」一节有整段现成配置）
                2) 证书在面板里申请，或者自己 certbot --nginx
                3) 打开 你的域名/admin.html 登录 → 左边「简历 PDF」→ 传你的简历
                   姓名、简介、技能、作品会自动跟着简历更新

    日常更新    sudo bash $APP_DIR/deploy/deploy.sh
    看日志      journalctl -u $SERVICE -f

EOF
else
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
fi

if [ "$HOST" != "127.0.0.1" ]; then
    cat <<EOF
$(printf '\033[1;33m注意：HOST=%s，后端直接对外，而且没有 HTTPS。\033[0m' "$HOST")
    后台密码是明文在网络上传输的，别在公网上这么用 —— 要么前面挂一层带证书的
    反代（HOST 改回 127.0.0.1），要么只在完全可信的内网里这样跑。

EOF
fi

if [ "$WEAK_PASSWORD" = "1" ]; then
    cat <<EOF
$(printf '\033[1;33m注意：后台密码还是默认的 %s。\033[0m' "$ADMIN_PASSWORD")
    站点是公开的，知道这个默认值的人都能登进后台改内容。要改的话：

        sudo sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD="你的新密码"/' $APP_DIR/server/.env
        sudo systemctl restart $SERVICE

EOF
fi
