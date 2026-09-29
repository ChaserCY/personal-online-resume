# CLAUDE.md

给在这个仓库里工作的 Claude 的说明。人看的文档在 `README.md`。

## 这是什么

个人简历 / 作品集网站。前台展示简历和游戏作品，后台（`admin.html`）用来改内容。

**仓库里不含任何真实个人资料。** `data.seed.json` 是一份虚构示例（张三），
真实内容只存在于服务器上的 `data.json` 和 `web/uploads/`，两者都不进 git。
在本地或服务器上看到的真实姓名、联系方式都属于运行时数据，不要提交回仓库。

**技术栈是刻意保持简单的：没有构建步骤，没有框架，没有 TypeScript。**
以前这里有一整套 React + Vite + Tailwind 工具链，但真正的页面是一个静态 HTML 文件，
那套工具链一行都没被用到，只在部署时增加失败面，已经删掉了。

改代码时请保持这个风格：**原生 HTML / CSS / JS，改完刷新浏览器就能看到效果。**
不要引入构建工具、包管理器、框架或转译步骤。

## 目录结构

```
Dockerfile                容器镜像：只跑 Node，静态文件和 /api/ 都归它
docker-compose.yml        docker compose up -d --build 一条命令起来
docker-entrypoint.sh      容器启动前的准备（补一份 data.seed.json）
.dockerignore             挡住真实数据，见下
.gitattributes            强制 LF，否则 Windows clone 出来的 .sh 带 \r 容器起不来

web/                      静态站点，nginx 直接托管
├── index.html            前台。只有结构和 class，逻辑都在 assets/ 里
├── admin.html            后台。同样只留结构
├── assets/
│   ├── style.css         前台样式
│   ├── main.js           前台逻辑：读 data.json → 渲染页面
│   ├── admin.css         后台样式
│   ├── admin.js          后台逻辑：登录、编辑、保存
│   └── favicon.svg       站点图标
├── data/
│   ├── data.seed.json    初始内容模板（被 git 跟踪，虚构示例）
│   └── data.json         线上真实内容（被 git 忽略，见下）
└── uploads/              后台传的图片（被 git 忽略）

server/
├── index.js              Express API：登录、写 data.json、收图片、解析简历
├── resume-parse.js       简历 PDF → 站点数据结构
├── package.json          后端依赖：express、dotenv、mupdf
└── .env                  密钥，不进 git

deploy/
├── install.sh            首次部署的一键安装脚本（Debian / Ubuntu）
├── deploy.sh             日常更新：拉代码 + 重启服务
├── nginx.conf            站点配置
└── resume-api.service    systemd 单元
```

`deploy/install.sh` 只在 Ubuntu / Debian 上能用（apt + systemd + nginx 的
`sites-available` 布局）。改它的时候别引入别的发行版的写法，也别假设有 rsync
之类的额外工具 —— 用 `apt-get` / `tar` / `sed` 这些一定有的。要支持别的系统
是另写一份，不是往这个脚本里加分支。`ADMIN_PASSWORD` 默认 `123456`，
是故意的（本地和演示省事），脚本最后会提醒用户改。

**`install.sh` 有四个开关**（`SKIP_NGINX` / `SKIP_UFW` / `PORT` / `HOST`），
都在文件开头的「0. 开关」那段里解析和校验。加新开关时守住两条：

- **不加开关时必须和以前一模一样。** 每个开关都有默认值，且默认值走的就是老路径。
- **开关要写在 `sudo` 后面**（`sudo SKIP_NGINX=1 bash ...`）。`export` 再 `sudo`
  会被 sudo 清掉，脚本内部看不出来，只能写在文件头注释里提醒。

`PORT` 和 `HOST` 比看上去难缠：脚本里有**五处**引用它们（`.env`、ufw、健康检查、
nginx 模板的 `proxy_pass`、收尾打印），漏一处就是静默故障。而且 `.env` 已存在时
脚本不重写它，所以开头有一段「以 `server/.env` 里的值为准」的解析 ——
没有那段的话，拿 `PORT=4000` 重跑会得到「systemd 还在 3001、nginx 改到 4000、
健康检查打 4000 失败」这种最难查的组合。`deploy.sh` 也读 `.env` 拿端口，
理由一样。

**`deploy/nginx.conf` 是模板，不是服务器上正在跑的那份，`deploy.sh` 从来不动它。**
它只拉代码 + 重启后端；nginx 那份里可能有 certbot 塞进去的 443 段和用户的域名，
自动覆盖会把 HTTPS 弄坏。所以改了 `nginx.conf` 得在服务器上手动同步那几行
（`diff` 出来照着抄，别 `cp`），README 的「nginx 配置的改动」一节有步骤。
改之前想清楚：这是整个仓库里**唯一不会跟着 `deploy.sh` 生效**的东西。

## 数据流（改动前务必先理解这个）

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

要点：

- **`data.json` 是唯一数据源。** 前台和后台读的是同一个文件。
  以前前台优先读 localStorage、后台只写 localStorage，导致"只有站长自己的浏览器看得到改动"，
  这个设计已经废弃。现在 localStorage 里只留 `portfolio_cache` 作为服务器不可达时的兜底。
- **`web/data/data.json` 故意被 git 忽略。** 它是运行时的内容，不是源码。
  如果跟踪它，服务器上后台一保存，下次 `git pull` 就会冲突。
  初始内容在 `data.seed.json`，`deploy.sh` 会在首次部署时自动复制过去。
- **`web/uploads/` 同样被忽略。** 后台传的图片和简历 PDF 都存在服务器本地磁盘上。
- **PDF 一律不进仓库**（`.gitignore` 里的 `*.pdf`）。简历 PDF 由后台
  「简历 PDF」面板上传，地址存在 `profile.resumePdf`；
  前台据此决定是否显示首页的下载按钮（空字符串 = 不显示）。

### 简历 PDF → 站点内容的同步

上传简历时顺带把简历内容读出来更新站点，链路是：

```
后台上传 PDF ──▶ POST /api/upload            落盘，返回 ./uploads/xxx.pdf
                        │
                        ▼
              POST /api/resume/parse  ──▶  resume-parse.js
                        │                  mupdf 读 PDF → 按坐标还原成行
                        ▼                  → 按章节切成 教育背景/项目经历/…
                  返回 { patch, report, warnings }   ← 只认字，不写文件
                        │
                        ▼
              admin.js applyResumePatch()  合并进内存里的 data
                        │
                        ▼
                   PUT /api/data           还是那条老路，没有第二个写入口
```

两条必须守住的规矩：

- **只覆盖解析成功的字段。** 简历排版千变万化，认不出来就保持原样，
  绝不能写空值把线上内容清掉。
- **同步流程不碰 `videos`。** 视频是独立的一块，和简历无关。
  作品卡片按标题匹配（`admin.js` 里的 `titleKey()` 只取括号前的部分），
  匹配上的只刷新描述和技术标签，图标 / 截图 / 外链一律保留 ——
  那些是站点特有的，简历里没有，重建会把它们弄丢。

另外三条和「示例内容」有关的规矩，都是为了让新用户传完 PDF 后看到的是自己的东西：

- **`sample: true` 是「这是虚构示例」的标记。** `data.seed.json` 里的 4 个作品
  和整个 `profile` 都带着它。同步时带标记的作品卡片会被删掉、带标记的 `profile`
  允许被拼出来的副标题覆盖。在后台编辑过之后（`saveGame()` / `saveProfile()`）
  标记就被删掉了，那张卡 / 那份资料从此归用户，同步不再动它。
  新增示例内容时记得带上这个标记。
- **简历项目匹配不上就新建卡片**，不要只写进 `resume.projects` 就完事 ——
  否则新用户的作品区永远是空的。新建的卡片图标用 🎮，截图和外链留空。
- **技能分类以简历为准**（`applyResumePatch` 里的 `next`）：简历里有的保留、只刷新
  说明文字，简历里没有的删掉。旧的「只增不减」写法会让示例分类一直留在线上。
- **联系方式是合并的，不是替换的**（`applyResumePatch` 里的 `socialLinks`）：
  解析只认 Phone / Email / QQ / 微信四种，整个替换的话用户在「个人信息 → 联系方式」
  里手加的行（知乎、博客…）传一次简历就没了。所以按名称合并，`profile.sample`
  还在时才整个替换（那几条本来就是虚构的）。

改解析逻辑时注意：**别换回 pdf.js**。这份简历的加粗字体没有可用的 ToUnicode 映射，
pdf.js 会把数字全解析成 `\u0000`（邮箱变成 `someone@.com`、列表编号消失），
而且会把「面」解析成康熙部首「⾯」。mupdf 会回退到字体自带的 cmap，两个问题都没有。
`resume-parse.js` 里的 `DATE_RANGE` 也有个坑：「至今」不能写成可选项里的「至今」，
连接符已经把「至」吃掉了，只剩一个「今」。

## 约定

- **所有路径必须是相对的**（`./assets/main.js`、`./data/data.json`、`./api/login`）。
  站点可能挂在域名根目录，也可能挂在子路径，绝对路径（`/foo`）会直接把页面搞坏。
- **任何密码、密钥都不能出现在 `web/` 里。** 后台密码只存在于 `server/.env`，
  校验在服务端做，前端拿到的只是一个签名 token。
  （历史教训：`admin.html` 里曾经硬编码着明文密码，任何人查看源码就能拿到。）
- **`assets/*.js` 必须是经典脚本，不能加 `type="module"`。**
  两个 HTML 里大量使用内联 `onclick="foo()"`，函数必须留在全局作用域。
- 样式改动写进对应的 `.css` 文件，不要在 HTML 里堆 `style="..."`。
  （现有代码里还有不少历史遗留的内联样式，别跟着学。）
- **联系方式只在「个人信息 → 联系方式」里编辑**（可增删的行，名称随便写，
  前台认不出来就给通用图标）。「简历管理」里只剩「所在地」一项，它喂的是前台左栏
  那一行键值对，不是链接。前台左栏读的是 `profile.socialLinks`，
  `resume.contact` 只在它为空时兜底 —— 别再把邮箱 / 电话做回固定表单，
  那样又会出现两份数据互相盖。
- **主题只在两个 HTML 的 `<head>` 内联脚本里算一次**（存过的优先，没存过跟随系统），
  算完显式写到 `documentElement` 的 `data-theme` 上。`main.js` / `admin.js` 只读这个
  属性去对图标和按钮文字，**不要再算一遍** —— 那段必须赶在首次绘制前跑，
  放到 `<body>` 末尾的脚本里就晚了，深色用户每次刷新会闪一下白屏。
  顺带：属性必须总是有值（哪怕跟随系统），`toggleTheme()` 读的是它，
  为空时第一次点「切换」会算出和当前一样的主题，看着像按钮坏了。
- **Docker 那条路不能引入构建步骤。** `Dockerfile` 只做三件事：`npm ci`、
  拷 `web/` 和 `server/`、跑 `node index.js`。别在里面加前端打包、
  别改 `web/` 里文件的内容 —— 容器里跑的就是仓库里那份静态文件。
- **`.dockerignore` 是安全控制，不是体积优化。** 构建上下文是**工作区**不是 git，
  漏一条就会把真实资料烤进镜像层：`web/data/data.json`（真名、联系方式）、
  `web/uploads/`（照片、简历 PDF）、`server/.env`（后台密码）。
  另外注意 `.dockerignore` 的 `*` **不跨目录** —— `*.pdf` 只挡根目录，
  `web/uploads/` 里的 PDF 得靠 `**/*.pdf`。
- **Docker 里的 `HOST` 必须是 `0.0.0.0`。** 容器里绑 `127.0.0.1` 等于只能自己访问自己，
  端口映射进不来，症状是「容器 running，外面连不上」。`Dockerfile` 的 `ENV` 和
  `docker-compose.yml` 的 `environment` 各写了一遍 —— 别删，也别加
  `env_file: ./server/.env`（那份是 `127.0.0.1`，优先级比镜像 ENV 高）。

## 常用命令

```bash
# 本地跑（会同时托管 web/ 和 API，访问 http://127.0.0.1:3001，后台密码 123456）
cd server && cp .env.example .env
cd server && npm install && npm start

# 检查前端语法（没有构建步骤，用 node 直接解析一遍）
node --check web/assets/main.js && node --check web/assets/admin.js

# 服务器上首次部署
sudo bash /opt/resume/deploy/install.sh

# 只装后端、不碰 nginx（宝塔机器 / 已经有反代占着 80）
sudo SKIP_NGINX=1 bash /opt/resume/deploy/install.sh

# 服务器上日常更新
sudo bash /opt/resume/deploy/deploy.sh

# 看后端日志
journalctl -u resume-api -f

# Docker：起 / 更新 / 日志（--build 不能省，不加就是跑旧镜像）
ADMIN_PASSWORD='xxx' docker compose up -d --build
docker compose logs -f
```

## 排查

| 症状 | 多半是 |
|---|---|
| 页面样式全丢 / 404 | 路径被写成了绝对路径，检查有没有 `/xxx` 开头的引用 |
| 部署完访客还是旧样式 / 旧 JS，页面错位或整片空白 | 浏览器缓存。先硬刷新（F12 开着时按住刷新按钮选「清空缓存并硬性重新加载」）确认；根治靠 nginx 里 `location /` 的 `Cache-Control: no-cache`（见「nginx 配置的改动」）。注意 `location = /admin.html` 得单独再写一遍，`add_header` 不继承 |
| 后台改了内容，前台没变 | 浏览器缓存了 data.json；nginx 里 `location = /data/data.json` 的 `no-cache` 头还在不在 |
| 调大 `MAX_PDF_MB` 之后传 PDF 还是失败 | nginx 的 `client_max_body_size` 还停在 20m。后端启动时会打 `[warn]` 告诉你该改成多少（express 那边的上限是自动跟的，不用管） |
| 后台点保存提示"保存失败" | 后端没起来（`systemctl status resume-api`）或 token 过期（重新登录） |
| 图片上传失败 | `web/uploads/` 的属主不是 `www-data`，跑一遍 `deploy.sh` 里的 chown |
| 登录一直失败 | `server/.env` 里的 `ADMIN_PASSWORD`；连续错 5 次会被限流 15 分钟 |
| 改坏了 data.json | 上一版在 `server/backups/data.json.bak`；改了一轮才发现的话，挑一份更早的 `data-*.json` 快照（见 `backupCurrent()`） |
| 上传简历后提示"内容没能识别" | PDF 是扫描件（图片）或者排版变了。用 `node -e "require('./server/resume-parse').extractRows(require('fs').readFileSync('x.pdf')).then(r=>console.log(r.map(x=>x.text).join('\n')))"` 看看认出来的是什么 |
| 简历内容同步错位 | `resume-parse.js` 的章节识别靠标题文字 + 缩进位置。换个模板要调 `SECTION_HEADINGS` |
| 首页还挂着「张三」「星轨回响」 | seed 的示例内容没被清掉。检查 `data.seed.json` 里 `profile` 和各作品的 `sample: true` 还在不在，以及 `applyResumePatch` 里的删除分支 |
| 访客下载到的是一串数字文件名 | `main.js` 里给 `#resume-download` 设 `download` 属性的那段；只在同源时生效 |
| nginx 起不来，日志是 `bind() to 0.0.0.0:80 failed (98)` | 80 被别的进程占了。`sudo ss -tlnp \| grep ':80 '` 看是谁 —— 装了宝塔的话多半是宝塔自带的 nginx（`/www/server/nginx`）。两套 nginx 不能共存，站点要么迁进宝塔（见 README「宝塔面板」一节），要么把宝塔的 nginx 停掉 |
| 宝塔机器上「部署完访客还是旧 JS」 | 宝塔模板里的 `location ~ .*\.(js\|css)?$ { expires 12h; }` 是**正则** location，优先级高于 `location /`，会把手改的 `no-cache` 完全盖掉。整段删掉，见 README「宝塔面板」2b |
| 裸跑过 `install.sh` 又想改用宝塔 | 机器上多了一套 apt nginx 在抢 80。`systemctl stop nginx && systemctl disable nginx`，以后用 `SKIP_NGINX=1` 重跑 |
| 换过 `PORT` 之后 `deploy.sh` 报健康检查失败 | 它从 `server/.env` 读端口；`.env` 里还是旧的，或者 nginx 的 `proxy_pass` 没跟着改。脚本会把「nginx 指向 X、.env 里是 Y」直接打出来 |
| Docker 里容器 running 但外面连不上 | `HOST` 没设成 `0.0.0.0`。别往 compose 里加 `env_file: ./server/.env`（那份是 `127.0.0.1`，优先级比镜像 ENV 高） |
| Docker 首次启动前台一片空白 | bind mount 盖住了镜像里的 `web/data/`，而宿主机那份没有 `data.seed.json`。`docker-entrypoint.sh` 会补，看 `docker compose logs` 确认它跑了 |

## 还没做的事

- 没有任何自动化测试。站点小，靠人肉点一遍。
- 简历同步会把「关于我」的卡片和作品描述换成简历原文。
  简历受篇幅限制写得比网页简略，所以同步之后文案会比手写的短一些，
  而且标点会变成半角逗号。想要网页版的长文案，得在后台手动改回去。
- 技能标签：手写过的永远保留，一条都没有时由 `extractTags()` 从说明文字里抠
  （按标点切、剥掉开头的动词，丢掉带连接词或太长的碎片）。抠出来的是近似值 ——
  简历里没有「标签」这个结构，只有一整句说明，所以像「熟练掌握虚幻引擎核心功能」
  这种会被整条丢掉，宁可少几个也不要塞半句话进去。抠得不满意就在后台手填，
  填过之后同步不会再覆盖。
- 每次上传简历都生成新文件名，旧 PDF 留在 `web/uploads/` 不会自动清理。
  换得多了会堆一堆，暂时靠手动删。
