#!/bin/sh
#
# 容器启动前的准备工作，做完 exec 成 CMD（node）。
# 只做两件事，都在下面写清楚了为什么需要。
set -e

mkdir -p /app/web/data /app/web/uploads /app/server/backups

# web/data 是 bind mount，会把镜像里的同名目录整个盖住 —— 宿主机那个目录里
# 没有 data.seed.json 的话，index.js 的 ensureDataFile() 会静默跳过（它把 ENOENT
# 吞了，只打一行 warn），结果是首次启动前台一片空白：没有名字、没有作品，
# 看着像项目坏了。所以这里补一份。
if [ ! -f /app/web/data/data.seed.json ]; then
    cp /app/seed/data.seed.json /app/web/data/data.seed.json
fi

exec "$@"
