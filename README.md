# 个人简历 / 作品集网站

一套可以直接部署上线的个人简历站。前台给访客看简历和作品，后台（`/admin.html`）
在线改内容，改完所有访客立刻能看到。另外还能上传简历 PDF 替换首页的下载文件，
**并自动把 PDF 里的内容读出来同步到展示页面**。

**没有构建步骤。** `web/` 里就是最终产物，改完刷新浏览器即可，不需要编译、
打包或安装任何前端依赖。

> 仓库里**不含任何真实个人资料**。`web/data/data.seed.json` 是一份虚构示例
> （张三 + 假作品 + `example@example.com`），真实内容只存在于服务器上。

---

## 目录

- [它有什么](#它有什么)
- [架构](#架构)
- [本地跑起来](#本地跑起来)
- [部署到服务器](#部署到服务器)
- [日常使用](#日常使用)
- [备份与恢复](#备份与恢复)
- [排查](#排查)
- [安全须知](#安全须知)
- [二次开发](#二次开发)

---

## 它有什么

**前台**（`web/index.html`）

- 首屏：头像 emoji、昵称、副标题、下载简历 PDF 按钮
- 关于我：按「标题：内容」写的段落会渲染成一张张卡片
- 求职意向：一条横向信息条（期望职位 / 城市 / 薪资 / 性质）
- 技能：等高卡片网格，每类一张，标签 + 一句话说明
- 游戏作品：卡片墙，点开是弹窗，支持多张截图和外部链接
- 视频：B 站链接或 BV 号，点开是内嵌播放器
- 深色 / 浅色主题切换，跟随系统偏好，选择记在 localStorage

**后台**（`web/admin.html`，需要密码）

| 面板 | 干什么 |
|---|---|
| 个人信息 | 昵称、头像、标题、副标题、关于我、技能标签、社交链接 |
| 视频管理 | 增删 B 站视频 |
| 游戏作品 | 增删作品，传截图，加技术标签 |
| 我的简历 | 联系方式、求职意向、教育背景、项目经历 |
| 简历 PDF | 上传 / 下载 / 清除简历文件，上传后自动同步上面几项内容 |

后台的编辑是 500ms 防抖自动保存的，没有「预览」和「发布」两步。

---

## 架构

### 目录结构

```
web/                      静态站点，nginx 直接托管这一层
├── index.html            前台。只有结构和 class，逻辑都在 assets/ 里
├── admin.html            后台。同样只留结构
├── assets/
│   ├── style.css         前台样式
│   ├── main.js           前台逻辑：读 data.json → 渲染页面
│   ├── admin.css         后台样式
│   ├── admin.js          后台逻辑：登录、编辑、保存、PDF 上传与同步
│   └── favicon.svg       站点图标（内联 SVG，没有二进制文件）
├── data/
│   ├── data.seed.json    初始内容模板（在 git 里，虚构示例）
│   └── data.json         线上真实内容（不在 git 里，由后台写入）
└── uploads/              后台传的图片和简历 PDF（不在 git 里）

server/                   后端：登录校验 + 写 data.json + 收文件 + 解析简历 PDF
├── index.js              HTTP 接口，约 300 行
├── resume-parse.js       简历 PDF → 站点内容，约 390 行
├── package.json          依赖只有 express / dotenv / mupdf
├── .env                  密钥，不进 git
└── backups/              每次写 data.json 前的自动备份（不在 git 里）

deploy/
├── install.sh            首次部署：一条命令装完（Debian / Ubuntu）
├── deploy.sh             日常更新：拉代码 + 重启服务
├── nginx.conf            站点配置
└── resume-api.service    systemd 单元
```

### 数据流

```
后台 admin.html
   │  编辑 → save()（500ms 防抖）
   ▼
PUT /api/data  ──Bearer token──▶  server/index.js
                                     │ 原子写（临时文件 + rename）
                                     ▼
                              web/data/data.json
                                     │ nginx 直接发这个文件
                                     ▼
前台 index.html  ──GET ./data/data.json──▶  渲染
```

**`data.json` 是唯一数据源。** 前台和后台读的是同一个文件，所以你在后台点保存，
访客刷新就能看到。localStorage 里只留 `portfolio_cache` 作为服务器不可达时的兜底，
不参与写入。

### 后端接口

一共六个，都在 `server/index.js` 里。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/login` | 密码 | 校验密码，返回签名 token |
| GET | `/api/session` | token | 检查登录态是否还有效 |
| GET | `/api/health` | 无 | 返回 `{"ok":true}`，给部署脚本和监控用 |
| PUT | `/api/data` | token | 原子写 `data.json`，写前备份 |
| POST | `/api/upload` | token | 收 base64 图片或 PDF，落盘到 `web/uploads/` |
| POST | `/api/resume/parse` | token | 解析已上传的简历 PDF，返回一份「内容补丁」 |

### 三个关键设计

**1. 为什么没有构建步骤。** 这个站点的页面本来就只有一个 HTML 文件，
以前却配了一整套 React + Vite + Tailwind 工具链，一行都没被用到，只在部署时
增加失败面。现在 `web/` 就是产物，`git pull` 完刷新浏览器就是最新版。
改代码时请保持这个风格：**原生 HTML / CSS / JS**。

**2. 为什么 `data.json` 不进 git。** 它是运行时的内容，不是源码。
如果跟踪它，服务器上后台一保存，下次 `git pull` 就会冲突。
所以 `deploy.sh` 敢用 `git reset --hard` —— 后台改的内容和上传的文件
不归 git 管，不会被抹掉。

**3. 为什么密码校验在服务端。** 后台密码只存在于 `server/.env`，
登录成功后前端拿到的是一个 HMAC 签名 token（`有效期.签名`），
服务端无状态校验，重启不掉登录。比较密码用 `timingSafeEqual`，
连续错 5 次限流 15 分钟。

### 简历 PDF 是怎么变成网页内容的

```
后台「简历 PDF」上传
   │  ① POST /api/upload          → 存到 web/uploads/，返回相对路径
   │  ② PUT  /api/data            → 把路径写进 profile.resumePdf，下载按钮立刻生效
   ▼
  ③ POST /api/resume/parse       → resume-parse.js 读 PDF，返回 patch
   │
   ▼
后台 admin.js 的 applyResumePatch(patch)
   │  只覆盖解析成功的字段，然后 save() → PUT /api/data
   ▼
前台刷新可见
```

解析分四步：读 PDF → 按坐标还原成「视觉顺序的行」→ 按章节标题切段 →
逐段用正则抽出结构化字段。

**两条铁律**（改 `resume-parse.js` 时别破坏）：

1. **只覆盖解析成功的字段。** 简历排版千变万化，任何一处认不出来都不该把
   线上已有的内容清空。`parseResume` 返回的 `patch` 里没有的键，调用方就不动它。
2. **整个同步流程不碰 `videos`。** 视频是独立的一块，和简历无关。

**作品卡片按标题匹配。** 简历里的「星轨回响(联机版)」会匹配到网站上的
「星轨回响 (多人合作射击)」（`titleKey` 只取括号前的部分），
匹配上就刷新描述和技术标签，图标、截图、外链保留 —— 那些是网站特有的，简历里没有。

匹配不上的简历项目**会直接新建一张卡**（图标用默认的 🎮，截图和外链留空，
之后在后台补）。不建的话，第一次上传简历的人作品区会是空的。

**示例卡片会被清掉。** `data.seed.json` 里的 4 个作品和整个 `profile` 都带
`"sample": true`，第一次同步时删掉 —— 否则虚构的「星轨回响」会一直挂在你的作品区。
在后台编辑过某张示例卡片后，`saveGame()` 会把标记去掉，那张卡就归你了，以后同步不会动它。
副标题同理：简历里没有对应的东西，只在 `profile.sample` 还在时用
「学校 · 专业 · 届别 | 求职意向」拼一句顶上；你自己改过之后就不再覆盖。

**技能分类以简历为准。** 简历里有的分类保留下来、只刷新说明文字（标签是你手写的），
简历里没有的分类删掉。新分类的标签留空 —— 从说明文字里抠关键词不可靠，手填比乱猜好。

**同步前会自动备份**到 `server/backups/data.json.bak`。

#### 为什么用 MuPDF 而不是 pdf.js

`resume-parse.js` 用 `mupdf`（WASM 版）读 PDF。**别换回 pdf.js。**

有些简历的加粗字体没有可用的 ToUnicode 映射，pdf.js 会把那些字形的数字统统
解析成 `\u0000`（邮箱变成 `someone@.com`、列表编号整段消失），还会把汉字映射到
康熙部首区（`面`→`⾯`、`人`→`⼈`）。MuPDF 会回退到字体自带的 cmap，两个问题都没有。

代价是 `mupdf` 这个依赖有 14MB，而且它是 ESM + 顶层 await 的包，
CommonJS 里只能 `await import('mupdf')`。这个代价是值得的。

---

## 本地跑起来

需要 Node.js >= 18。

```bash
cd server
cp .env.example .env          # 预置的后台密码是 123456，本地够用
npm install
npm start
```

然后访问 <http://127.0.0.1:3001>，后台在 <http://127.0.0.1:3001>/admin.html，
密码 `123456`（部署到公网前记得改，见[安全须知](#安全须知)）。

`web/data/data.json` 是运行时内容、不在 git 里，所以刚 clone 下来是没有的 ——
**后端启动时会自动从 `data.seed.json` 生成一份示例内容**，直接就能看到一个完整的站点，
不用手动复制。后台一保存就覆盖掉了。

> 后端同时托管了 `web/` 静态目录，所以本地不需要装 nginx。

检查前端语法（没有构建步骤，用 node 直接解析一遍就行）：

```bash
node --check web/assets/main.js && node --check web/assets/admin.js
```

---

## 部署到服务器

**假设你已经有：**

- 一台能 SSH 的云服务器（1 核 1G 就够，这个站几乎不吃资源）
- 一个**已完成 ICP 备案**、并解析到这台服务器公网 IP 的域名

下面按实际操作顺序走一遍，全程大约 10 分钟，其中大半时间在等 `apt` 装包。

### 走一遍：从零到能访问

#### 第 0 步：先在网页控制台做两件事（脚本管不了）

1. **安全组放行 80 和 443** —— 阿里云、腾讯云的实例默认只开 22，
   不开的话装完 nginx 外面照样访问不到。**这一步最容易漏。**
2. **确认域名已备案、并解析到这台机器的公网 IP**

```bash
dig +short 你的域名     # 应该返回你的服务器 IP
```

#### 第 1 步：SSH 进去，把代码拉下来

```bash
ssh root@你的服务器IP
```

```bash
apt update && apt install -y git

mkdir -p /opt/resume
git clone https://gitee.com/Chance_Li_swpu/personal-online-resume.git /opt/resume
```

> 上面是 Gitee 的地址，国内服务器拉得快。GitHub 那份是
> `https://github.com/ChaserCY/personal-online-resume.git`，服务器在国外才用。
> 私有仓库要先在服务器上配好 SSH key，把地址换成 `git@...`。

#### 第 2 步：跑安装脚本

```bash
sudo bash /opt/resume/deploy/install.sh
```

它会问你三个问题：

| 提示 | 输入什么 |
|---|---|
| `域名或公网 IP（nginx 的 server_name）` | 你的域名，比如 `resume.example.com` |
| `后台登录密码（回车用默认的 123456）` | **建议在这里就填自己的密码**。回车也行，脚本最后会打黄字提醒你改 |
| `邮箱（申请 Let's Encrypt 证书用，留空则不配 HTTPS）` | 你的邮箱。**留空就只跑 http**，80 端口一样能用 |

然后它自动装完 nginx、Node.js、systemd 服务、站点配置和证书。等它跑完。

成功的话最后会打印：

```
部署完成

    前台        https://你的域名/
    后台        https://你的域名/admin.html
    后台密码    xxxxxx
```

> 脚本可以重复跑，已经装好的部分会跳过，`data.json` 和 `web/uploads/` 不会被覆盖 ——
> 中途哪一步错了，修完直接重跑就行。

#### 第 3 步：验证

```bash
systemctl status resume-api            # 应该是 active (running)
curl http://127.0.0.1:3001/api/health  # 应该输出 {"ok":true}
```

浏览器打开 `https://你的域名/`，能看到示例站点（张三 + 4 个虚构作品）就算通了。

#### 第 4 步：登录后台，传你的简历

1. 打开 `https://你的域名/admin.html`，输密码
2. 左边「**个人信息**」面板顶上有条蓝色提示，说「现在显示的是示例内容」
3. 点左边「**简历 PDF**」→ 选你的 PDF 上传
4. 等几秒，面板会列出来这次同步了什么。刷新前台，张三就变成你了，
   示例作品也换成你的项目了
5. 视频是独立的，在「**视频管理**」面板手动加，不受简历影响

#### 卡住了看这里

| 现象 | 多半是 |
|---|---|
| 浏览器打不开，但服务器上 `curl 127.0.0.1:3001/api/health` 通 | **安全组没放行 80/443**（第 0 步） |
| IP 能打开，域名打不开 | 域名没解析，或者**没备案被运营商拦了** |
| 脚本提示「证书没申请成功」 | 域名还没解析好。解析生效后单独重跑：`certbot --nginx -d 你的域名 --redirect` |
| `systemctl status` 说服务起不来 | `journalctl -u resume-api -n 50 --no-pager` 看日志；多半是读不到 `server/.env` |
| 页面样式全丢 | 路径被改成了绝对路径，见[排查](#排查) |

---

### 安装脚本到底做了什么

`deploy/install.sh` 是把上面这一串操作打包成的一条命令。它依次做：

| 步骤 | 做的事 |
|---|---|
| 1 | 装系统依赖：nginx、Node.js 20（低于 18 就从 NodeSource 装）、openssl；要 HTTPS 才装 certbot |
| 2 | 用 ufw 放行 22 / 80 / 443（先放 SSH 再 enable，免得把自己关在门外） |
| 3 | 把代码放到 `/opt/resume`，排除 `.git`、`node_modules`、`.env`、`data.json`、`uploads`；顺手把 `/opt/resume` 加进 root 的 `safe.directory` |
| 4 | 生成 `server/.env`：后台密码 + 一个随机的 `SESSION_SECRET`，权限 `640 root:www-data` |
| 5 | `npm install --omit=dev` |
| 6 | 铺一份示例 `data.json`，并把 `web/data`、`web/uploads`、`server/backups` 划给 `www-data` |
| 7 | 写 systemd 单元（`ExecStart` 里的 node 路径按 `which node` 自动填）并启动，跑一次 `/api/health` |
| 8 | 写 nginx 站点配置、去掉默认站点、`nginx -t` 通过后 reload |
| 9 | 签 Let's Encrypt 证书并开启 80 → 443 跳转 |
| 10 | 打印前台 / 后台地址和后台密码 |

几个细节：

- **可以重复跑**：已经装好的部分会跳过，`data.json` 和 `web/uploads/` 不会被覆盖。
- 密码留在默认值 `123456` 时，最后会多打一段黄色的提醒 —— 后台是公开页面，真上线要改掉。
- 有些小厂的机器没开 IPv6，`listen [::]:80` 会让 `nginx -t` 失败，脚本会自动去掉那行重试。
- 证书签失败不算致命（多半是域名还没解析好），脚本会告诉你怎么单独重跑 certbot。
- 如果服务器上已经有 `server/.env`，脚本不会动它，改密码得自己编辑。

想无人值守（比如写进自己的开机脚本）就先把答案放进环境变量：

```bash
sudo DOMAIN=resume.example.com ADMIN_PASSWORD='你的密码' EMAIL=you@example.com \
     bash /opt/resume/deploy/install.sh
```

**操作系统支持**

`install.sh` 只在 **Ubuntu / Debian** 上测过，用的是 `apt-get` + `systemd` +
nginx 的 `sites-available` 布局。CentOS / RHEL / AlmaLinux / Arch / macOS
用不了这个脚本，两条路：

1. 照着下面的[手动版](#手动版)一步步做，步骤和脚本是一一对应的；
2. 或者自己转换脚本 —— 要改的就三处：`apt-get` 换成 `dnf` / `yum` / `pacman`，
   systemd 单元和 nginx 配置的路径（RHEL 系是 `/etc/nginx/conf.d/`，
   没有 `sites-enabled` 那一层），以及 Node.js 的安装方式。

`deploy.sh`（日常更新）和 `web/`、`server/` 本身不依赖发行版，
任何跑得动 Node.js 18+ 的 Linux 都能用。

### 手动版

不想用脚本、或者系统不是 Debian 系的话，照着这里做。步骤和脚本一一对应。

**0. 先把代码推到你的仓库** —— 服务器从 git 拉代码，本地改动得先推上去：

```bash
git add -A
git commit -m "chore: 初始化我的简历站"
git push origin master
```

#### 1. 放行端口（最容易漏的一步）

去云厂商控制台的**安全组 / 防火墙**里放行 **80** 和 **443** 端口。
阿里云、腾讯云的实例默认只开 22，不开 80 —— 装好了 nginx 外面也访问不到，
这是新手最常卡住的地方。系统里的 ufw 也顺手开一下：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
```

同时确认域名解析已经生效（应该返回你的服务器 IP）：

```bash
dig +short 你的域名
```

#### 2. 装环境

```bash
sudo apt update
sudo apt install -y nginx git nodejs npm
node -v      # 需要 >= 18
```

如果 `node -v` 显示低于 18（Ubuntu 22.04 及更早的默认源版本很旧），用 NodeSource 装新版：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

#### 3. 拉代码

```bash
sudo mkdir -p /opt/resume
sudo chown "$USER":"$USER" /opt/resume
git clone <你的仓库地址> /opt/resume
cd /opt/resume

# deploy.sh 要用 sudo 跑，也就是让 root 去操作一个你 clone 下来的仓库。
# git 2.35.2 起会因此报 "detected dubious ownership" 拒绝干活，先把它加进白名单。
sudo git config --global --add safe.directory /opt/resume
```

> 私有仓库的话，先在服务器上生成 SSH key 加到 GitHub / Gitee，
> 然后把 clone 地址换成 `git@...`。服务器在国内建议用 Gitee，拉取更快。

#### 4. 配置后端密钥

```bash
cd /opt/resume/server
cp .env.example .env
nano .env
```

`.env.example` 里 `ADMIN_PASSWORD` 预置的是 `123456`，**上线前一定改掉** ——
后台是公开可访问的页面，留着默认密码谁都能登进来改内容。
`SESSION_SECRET` 单独设一个随机串（不设会退化成用密码派生，以后改密码会把所有登录态踢掉）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```ini
ADMIN_PASSWORD="你的后台密码"
SESSION_SECRET="上一条命令输出的那串"
```

改完把权限收紧 —— 服务是以 `www-data` 跑的，systemd 读 `EnvironmentFile` 时
有的版本按服务用户去读，`600 root:root` 会让它读不到、服务直接起不来，
所以给组读就够：

```bash
sudo chown root:www-data /opt/resume/server/.env
sudo chmod 640 /opt/resume/server/.env
```

装依赖：

```bash
npm install --omit=dev
```

#### 5. 起后端服务

```bash
sudo cp /opt/resume/deploy/resume-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now resume-api
systemctl status resume-api        # 应该是 active (running)
```

先确认它在跑：

```bash
curl http://127.0.0.1:3001/api/health
# 期望输出：{"ok":true}
```

如果报错，`journalctl -u resume-api -n 50 --no-pager` 看日志。
最常见的两个原因：`.env` 没填 `ADMIN_PASSWORD`，或者 `which node` 不是 `/usr/bin/node`
（用 nvm 装的就会这样，改一下 service 文件里的 `ExecStart`）。

#### 6. 配 nginx

```bash
sudo cp /opt/resume/deploy/nginx.conf /etc/nginx/sites-available/resume
sudo nano /etc/nginx/sites-available/resume     # 把 server_name 改成你的域名

sudo ln -sf /etc/nginx/sites-available/resume /etc/nginx/sites-enabled/resume
sudo rm -f /etc/nginx/sites-enabled/default     # 不删掉的话默认站点会抢 80 端口

sudo nginx -t                                   # 必须先测通再 reload
sudo systemctl reload nginx
```

现在用浏览器打开 `http://你的域名/` 应该能看到简历页，`/admin.html` 能登录。

> nginx 只把 `/api/` 转发给 Node，其余全部由它自己发静态文件 ——
> 所以后端进程绑在 `127.0.0.1`，外网碰不到。

#### 7. 初始化内容

后端启动时发现没有 `data.json` 会自己从 `data.seed.json` 铺一份，所以这一步通常不用管。
想手动来一份也行：

```bash
sudo cp /opt/resume/web/data/data.seed.json /opt/resume/web/data/data.json
sudo chown www-data:www-data /opt/resume/web/data/data.json
```

这份模板是虚构示例（张三）。后台的「个人信息」面板顶上会有一条提示告诉你现在还是示例内容。
登录后台把内容改成你自己的，或者直接上传一份简历 PDF 让内容自动同步过来（见下节）。

#### 8. 上 HTTPS

域名已经备案、解析也生效了，配证书就是两条命令：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

certbot 会自动改 nginx 配置并设置好自动续期。验证续期正常：

```bash
sudo certbot renew --dry-run
```

> 证书能签下来 ≠ 域名能用。**没备案的域名解析到大陆服务器会被运营商拦截**，
> 签了证书访客照样打不开。先确认备案通过再做这一步。

---

## 日常使用

### 改内容

直接在网站后台改，点保存即可 —— 改动会写进服务器的 `data.json`，
所有访客立刻看到。不需要动代码，也不需要重启服务。

### 更新简历 PDF

后台左侧「简历文件 → 简历 PDF」，面板里能看到当前线上的文件、大小，以及
「⬆ 上传新 PDF 替换 / ⬇ 下载当前 PDF / 清除」。

**上传新简历时，网站内容会跟着一起更新。** 服务器会把你上传的 PDF 读一遍，
把联系方式、求职意向、教育背景、在校经历、项目经历、技能说明同步到展示页面，
面板上会列出这次到底同步了哪些东西。上传后不用再点「保存更改」。

几条规矩：

- **识别不出来的部分保持原样**，不会写空值把已有内容清掉。
- **视频管理不受影响**，同步流程完全不碰视频。
- **作品卡片按标题匹配**，匹配上的只刷新描述和技术标签，
  图标、截图、外链都保留 —— 那些是网站特有的，简历里没有。
  简历里有、网站上没有的项目会**自动新建一张卡片**（截图和外链留空，之后自己补）。
- **示例作品会被清掉。** 第一次上传时，`data.seed.json` 里那 4 个虚构作品
  （以及示例的昵称 / 副标题）会被你的真实内容替换掉。
- **技能分类以简历为准**，简历里没有的分类会删掉；标签是你手写的，只刷新说明文字。
- 同步前会把上一版内容存到 `server/backups/data.json.bak`。

> **一个取舍**：简历受篇幅限制，写得比网页简略。同步之后，
> 「关于我」的卡片和作品描述会变成简历原文 —— 更准确，但比手写的短，
> 标点也会变成半角逗号。想让网页保持更长的文案，就在后台手动改回来，
> 改完不重新上传 PDF 就不会被覆盖。

**注意 PDF 不进 git**（`.gitignore` 里的 `*.pdf`）。这是故意的 —— 简历源文件是个人资料，
而且会频繁替换，塞进仓库只会让每次更新都留一份历史副本。

由此带来一个部署上的后果：**新服务器 clone 下来是没有 PDF 的**，
`data.seed.json` 里 `resumePdf` 是空字符串，所以按钮默认不显示，不会出现点了 404 的情况。
上传一次之后就有了，文件存在服务器的 `web/uploads/` 下。

访客点「下载简历」拿到的文件名是 **`你的名字-简历.pdf`** ——
上传的文件名是时间戳（`1790081750725-24cb6336.pdf`），不覆盖的话访客下到手就是这串数字。
`main.js` 用 `download` 属性把它改掉了（同源才生效，简历正好是同源的 `./uploads/xxx.pdf`）。

每次上传都会生成新文件名，**旧 PDF 不会自动删除**，会一直留在 `web/uploads/` 里。
换得多了可以自己进去删掉不用的：

```bash
ssh 你的服务器
ls -lt /opt/resume/web/uploads/     # 按时间列出来，看看哪些是旧的
rm /opt/resume/web/uploads/旧的.pdf
```

备份时记得把 `web/uploads/` 一起打包（见下节），否则换服务器要重新传一遍。

> 也可以不用后台：把 PDF 直接 scp 到服务器的 `web/resume.pdf`，
> 然后在后台「个人信息」的「文件地址」里填 `./resume.pdf`。
> 但这样只换了下载文件，不会触发内容同步。

### 改代码

```bash
# 本地改完推上去
git push origin master

# 服务器上拉下来并重启
ssh 你的服务器
sudo bash /opt/resume/deploy/deploy.sh
```

`deploy.sh` 会拉代码、装依赖、修权限、重启服务、做健康检查。
它用的是 `git reset --hard`，但 `web/data/data.json` 和 `web/uploads/` 都在 `.gitignore` 里，
所以**后台改的内容和上传的图片不会被覆盖**。

---

## 备份与恢复

要备份的就两样东西：

```bash
# 内容 + 图片 + 简历 PDF，打包下载到本地
ssh 你的服务器 "sudo tar czf - -C /opt/resume web/data web/uploads" > resume-backup-$(date +%F).tar.gz
```

恢复就是解回去，然后修一下属主：

```bash
tar xzf resume-backup-2026-01-01.tar.gz -C /tmp
sudo cp -r /tmp/web/data /tmp/web/uploads /opt/resume/web/
sudo chown -R www-data:www-data /opt/resume/web/data /opt/resume/web/uploads
```

另外后端每次写入前都会把上一版存到 `server/backups/data.json.bak`，
改坏了可以直接 `cp` 回去：

```bash
sudo cp /opt/resume/server/backups/data.json.bak /opt/resume/web/data/data.json
```

---

## 排查

| 症状 | 多半是 |
|---|---|
| 页面样式全丢 / 404 | 路径被写成了绝对路径，检查有没有 `/xxx` 开头的引用 |
| 后台改了内容，前台没变 | 浏览器缓存了 `data.json`；nginx 里 `location = /data/data.json` 的 `no-cache` 头还在不在 |
| 后台点保存提示"保存失败" | 后端没起来（`systemctl status resume-api`）或 token 过期（重新登录） |
| 图片 / PDF 上传失败 | `web/uploads/` 的属主不是 `www-data`，跑一遍 `deploy.sh` 里的 chown |
| 上传大 PDF 报 413 | 三处上限要对齐：`.env` 的 `MAX_PDF_MB`、`index.js` 的 `express.json` limit、`nginx.conf` 的 `client_max_body_size` |
| 登录一直失败 | `server/.env` 里的 `ADMIN_PASSWORD`；连续错 5 次会被限流 15 分钟 |
| `systemctl status` 说服务起不来 | 多半是读不到 `server/.env`。它得是 `640 root:www-data`（`chown root:www-data` + `chmod 640`），`600 root:root` 会让以 www-data 运行的服务读不到 |
| `deploy.sh` 报 `detected dubious ownership` | git 以 root 操作别人 clone 的仓库被拒了。跑一次 `sudo git config --global --add safe.directory /opt/resume`（`install.sh` 会自动加） |
| PDF 传上去了但内容没同步 | 面板上会写明哪些章节没认出来。解析器只认固定的章节标题，见 `resume-parse.js` 顶部的 `SECTION_HEADINGS` |
| 改坏了 `data.json` | 上一版在 `server/backups/data.json.bak`，直接 `cp` 回去 |
| 服务起不来 | `journalctl -u resume-api -n 50 --no-pager`；`ExecStart` 里的 node 路径对不对 |

---

## 安全须知

- **后台密码只存在于 `server/.env`。** 校验在服务端做，前端拿到的只是一个签名 token。
  永远不要把密码写进 `web/` 里的任何文件。
- **`.env` 不要提交进 git**（`.gitignore` 已经覆盖），也不要贴给任何人或 AI。
- **`ADMIN_PASSWORD` 的默认值是 `123456`，上线前必须改掉。** `install.sh` 和
  `.env.example` 都用这个值，是为了本地跑起来少一步。后台是公网可访问的页面，
  密码就是唯一的门 —— 不改的话，任何人试一下默认值就能改你站上的内容。
  改法：编辑 `server/.env` 里的 `ADMIN_PASSWORD`，然后 `systemctl restart resume-api`。
- 后台页面加了 `X-Robots-Tag: noindex`，不会被搜索引擎收录，但**这不等于访问控制** ——
  真正的门是登录。
- 站点没有用户系统，只有你一个管理员。如果你要做多用户，得先加一层用户表，
  现在的 token 里没有身份概念，任何人拿到密码都是同一个管理员。

---

## 二次开发

想改样式：`web/assets/style.css`（前台）、`admin.css`（后台）。
主题变量都在文件顶部的 `:root` 和 `[data-theme="dark"]` 里，改那里就行。

想加一个内容板块（比如「博客」）：`data.json` 里加一个数组，
`index.html` 里加一个 `<section>`，`main.js` 的 `render()` 里加一段渲染，
后台再加一个面板。`blogs` 这个键已经在数据结构里留好了，但没有界面。

几个坑：

- **`assets/*.js` 必须是经典脚本，不能加 `type="module"`。**
  两个 HTML 里大量使用内联 `onclick="foo()"`，函数必须留在全局作用域。
- **所有路径必须是相对的**（`./assets/main.js`、`./data/data.json`、`./api/login`）。
  站点可能挂在域名根目录，也可能挂在子路径，绝对路径（`/foo`）会直接把页面搞坏。
- **改 `resume-parse.js` 前先读它的文件头注释**，那里写了为什么用 MuPDF、
  以及「只覆盖解析成功的字段」这条铁律的来由。

### 已知待办

- **`resume` 里的内容大部分没有在前台显示。** 目前前台只渲染了
  `resume.target`（求职意向那条信息条）。`resume.contact`、`resume.education`、
  `resume.projects`、`resume.activities` 都能在后台编辑、也会被简历 PDF 同步写入，
  但前台没有对应的板块，等于只存不显。想用起来的话，在 `index.html` 加一个
  `<section>`、在 `main.js` 的 `render()` 里加一段渲染即可，数据都是现成的。
- 前台在深色模式下会闪一下白屏：主题是在 `main.js` 里应用的，而脚本在 `<body>` 末尾。
  修法是在 `<head>` 里加一段内联脚本提前设置 `data-theme`。
- 没有任何自动化测试。站点小，靠人肉点一遍。

---

## 在服务器上继续用 Claude

这个仓库里有一份 `CLAUDE.md`，写清了架构、数据流、约定和排查表。
在服务器上装好 Claude Code 后，它会自动读这个文件，所以不用你从头解释项目。

```bash
# 用非 root 用户装（Claude Code 不建议用 root 跑）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g @anthropic-ai/claude-code

cd /opt/resume
claude
```

第一次运行会让你登录 Anthropic 账号（或者设 `ANTHROPIC_API_KEY` 环境变量）。
之后直接说需求就行，比如：

- 「看 CLAUDE.md，然后把前台的深色模式闪烁修掉」
- 「deploy.sh 跑完健康检查失败，帮我查日志」
- 「加一个新的作品板块，数据结构和现有 games 保持一致」

几个建议：

- **在 `/opt/resume` 目录里启动**，这样它能读到 `CLAUDE.md` 和 git 历史。
- **别把 `.env` 内容贴给它**，也不需要 —— 它知道密码在 `.env` 里，但不需要看见。
- 让它改完代码后跑 `sudo bash deploy/deploy.sh` 验证，别只看代码不看结果。
- 服务器上跑 `claude` 需要网络能通 Anthropic API。如果国内服务器连不上，
  就在本地改完推 git，服务器只负责 `git pull`，这也是更稳的做法。
