# 排练字幕修订台 —— 本地运行镜像
FROM node:20-bookworm-slim

# better-sqlite3 在缺少预编译二进制时可回退源码编译
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 优先拷贝依赖描述，利用构建缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# 应用代码
COPY server ./server
COPY public ./public

# 数据库与持久化目录
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

VOLUME ["/app/data"]

# 容器启动时确保数据库与表结构已初始化（幂等），随后启动服务
CMD ["sh", "-c", "node server/db.js && node server/index.js"]

EXPOSE 3000
