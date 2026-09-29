# 简历站。容器里只跑 Node 一个进程：Express 同时托管 web/ 静态文件和 /api/，
# 里面没有 nginx —— HTTPS 交给前面那层反代（宝塔 / nginx / Caddy）。
#
# 构建上下文是仓库根目录（要 web/ 和 server/ 两棵树），所以这个文件必须在根目录。
# 平时不用手敲 docker build，用 docker compose up -d --build 就行。
FROM node:20-alpine

WORKDIR /app/server

# 先装依赖：改代码时这一层能命中缓存，不用每次重下。
# 用 npm ci 而不是 npm install —— package-lock.json 在仓库里，装出来的版本可复现；
# 谁改了 package.json 忘了更新 lock，这里会直接报错，比装出个不一样的依赖树强。
#
# 不需要 gcc / python：mupdf 是 WASM 的（dist/ 里只有 .js 和 .wasm，没有 .node），
# express 和 dotenv 是纯 JS，alpine 完全够用。
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 后端代码 + 静态站点。真实数据（data.json / uploads / .env）由 .dockerignore 挡住。
COPY server/ /app/server/
COPY web/ /app/web/

# web/data 运行时会被 bind mount 整个盖住，镜像里那份 seed 就看不见了。
# 单独留一份给 entrypoint，宿主机目录是空的时候补回去（否则首次启动前台一片空白）。
COPY web/data/data.seed.json /app/seed/data.seed.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# HOST 必须写进 ENV，不能只写在文档里：容器里绑 127.0.0.1 的话端口映射进不来，
# 症状是「容器明明 running，外面就是连不上」。
# dotenv 不覆盖已存在的环境变量，所以就算有人塞一份 HOST=127.0.0.1 的 .env 进来，
# 这里也压得住。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

EXPOSE 3001

# 用现成的 /api/health。alpine 自带 busybox wget，不用额外装东西。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O- "http://127.0.0.1:${PORT:-3001}/api/health" >/dev/null 2>&1 || exit 1

# entrypoint 做完准备工作后 exec 成 CMD，node 保持 PID 1 ——
# 这样 docker stop 发的 SIGTERM 直接落到 node 上，写 data.json 的
# 「临时文件 + rename」不会被打断在半路。
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "index.js"]
