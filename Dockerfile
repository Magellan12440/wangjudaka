# 网剧大咖 · 服务端镜像
#
# 服务端零第三方运行时依赖，所以镜像里不需要 npm install，
# 构建很快（几十秒），冷启动也快。web/ 是 PC 工作台静态页，一起打进去。
#
# 构建：docker build -t wangju-daka .
# 运行：docker run -d --name wangju -p 8787:8787 \
#         --env-file server/.env.local -e DATA_DIR=/data -v $PWD/server/data:/data wangju-daka
# 或：  docker compose up -d
FROM node:22-alpine

WORKDIR /app

# 运行期只需要 src/ 与 web/；tests、scripts、node_modules 都不进镜像
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY web ./web

# 端口默认 80：微信云托管只按 containerPort 探活，
# 若平台没有把 PORT 注入进容器，默认 8787 会导致探活全部失败 → Back-off restarting。
# 本地用 docker run -e PORT=8787 覆盖即可。
ENV NODE_ENV=production \
    PORT=80 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

WORKDIR /app/server
EXPOSE 80

# 健康检查跟随 PORT：容器内默认 80，本地覆盖 PORT 时同样可用
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:${PORT:-80}/health > /dev/null || exit 1

CMD ["node", "src/index.js"]
