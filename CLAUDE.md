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
  作品卡片按标题匹配（`titleKey()` 只取括号前的部分），
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

## 常用命令

```bash
# 本地跑（会同时托管 web/ 和 API，访问 http://127.0.0.1:3001）
cd server && cp .env.example .env   # 第一次要填密码
cd server && npm install && npm start

# 检查前端语法（没有构建步骤，用 node 直接解析一遍）
node --check web/assets/main.js && node --check web/assets/admin.js

# 服务器上首次部署
sudo bash /opt/resume/deploy/install.sh

# 服务器上日常更新
sudo bash /opt/resume/deploy/deploy.sh

# 看后端日志
journalctl -u resume-api -f
```

## 排查

| 症状 | 多半是 |
|---|---|
| 页面样式全丢 / 404 | 路径被写成了绝对路径，检查有没有 `/xxx` 开头的引用 |
| 后台改了内容，前台没变 | 浏览器缓存了 data.json；nginx 里 `location = /data/data.json` 的 `no-cache` 头还在不在 |
| 后台点保存提示"保存失败" | 后端没起来（`systemctl status resume-api`）或 token 过期（重新登录） |
| 图片上传失败 | `web/uploads/` 的属主不是 `www-data`，跑一遍 `deploy.sh` 里的 chown |
| 登录一直失败 | `server/.env` 里的 `ADMIN_PASSWORD`；连续错 5 次会被限流 15 分钟 |
| 改坏了 data.json | 上一版在 `server/backups/data.json.bak`，直接 `cp` 回去 |
| 上传简历后提示"内容没能识别" | PDF 是扫描件（图片）或者排版变了。用 `node -e "require('./server/resume-parse').extractRows(require('fs').readFileSync('x.pdf')).then(r=>console.log(r.map(x=>x.text).join('\n')))"` 看看认出来的是什么 |
| 简历内容同步错位 | `resume-parse.js` 的章节识别靠标题文字 + 缩进位置。换个模板要调 `SECTION_HEADINGS` |
| 首页还挂着「张三」「星轨回响」 | seed 的示例内容没被清掉。检查 `data.seed.json` 里 `profile` 和各作品的 `sample: true` 还在不在，以及 `applyResumePatch` 里的删除分支 |
| 访客下载到的是一串数字文件名 | `main.js` 里给 `#resume-download` 设 `download` 属性的那段；只在同源时生效 |

## 还没做的事

- 前台在深色模式下会闪一下白屏：主题是在 `main.js` 里应用的，而脚本在 `<body>` 末尾。
  修法是在 `<head>` 里加一段内联脚本提前设置 `data-theme`。
- 没有任何自动化测试。站点小，靠人肉点一遍。
- 简历同步会把「关于我」的卡片和作品描述换成简历原文。
  简历受篇幅限制写得比网页简略，所以同步之后文案会比手写的短一些，
  而且标点会变成半角逗号。想要网页版的长文案，得在后台手动改回去。
- 技能只同步说明文字。简历里没有「标签」这个结构，
  自动从说明文字里抠关键词不可靠，所以标签一律保留手写的那份。
- 每次上传简历都生成新文件名，旧 PDF 留在 `web/uploads/` 不会自动清理。
  换得多了会堆一堆，暂时靠手动删。
