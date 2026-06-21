# syntax=docker/dockerfile:1.7
# ───────────────────────────────────────────────────────────
# 阶段一:builder — 编译 TypeScript
# ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY tsconfig*.json ./
RUN npm install --include=dev

COPY src/ ./src/
RUN npm run build

# ───────────────────────────────────────────────────────────
# 阶段二:runner — 仅保留运行所需
# ───────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache tini wget

# 非 root 用户
RUN addgroup -S platform && adduser -S platform -G platform

# 复制构建产物和运行时依赖
COPY --from=builder --chown=platform:platform /app/build ./build
COPY --from=builder --chown=platform:platform /app/package.json ./
COPY --from=builder --chown=platform:platform /app/node_modules ./node_modules

# 持久化目录
RUN mkdir -p /app/data /app/logs && chown -R platform:platform /app/data /app/logs

USER platform

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV LOG_DIR=/app/logs

EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/api/v1/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/index.js", "--enable-web"]
