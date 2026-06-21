# Deployment Guide

> 把 **opsgate** DevOps 中台用 Docker Compose 一键起跑的完整说明。
> 涵盖前置、构建、访问、数据持久化、升级、备份、监控、生产加固、FAQ。

## 目录

- [1. 前置要求](#1-前置要求)
- [2. 快速开始](#2-快速开始)
- [3. 镜像构建](#3-镜像构建)
- [4. 访问与登录](#4-访问与登录)
- [5. 数据持久化](#5-数据持久化)
- [6. 升级](#6-升级)
- [7. 备份与恢复](#7-备份与恢复)
- [8. 监控与日志](#8-监控与日志)
- [9. 生产加固](#9-生产加固)
- [10. 常见问题](#10-常见问题)

---

## 1. 前置要求

- **Docker Engine** ≥ 20.10
- **Docker Compose** v2(`docker compose`,不是老版 `docker-compose`)
- **1 GB** 可用内存(monorepo build 期间需要 ~500 MB)
- **2 GB** 可用磁盘

验证:
```bash
docker --version         # Docker version 20.10+
docker compose version   # Docker Compose version v2.x+
```

---

## 2. 快速开始

### 2.1 克隆仓库
```bash
git clone https://github.com/liuzkang6/opsgate.git
cd opsgate
```

### 2.2 生成密钥

两个必填环境变量,生成一次永久用:

```bash
# 32 字节 base64 编码 — 用于 AES-256-GCM 加密 SSH 凭证
openssl rand -base64 32
# 例:fErMj8t/Uozv3N8fRbX1xQ5J6zH4iSw9aPqV0yB2nMc=

# 任意长字符串 — 用于 JWT 签名
openssl rand -hex 32
# 例:a1b2c3d4e5f6...
```

> ⚠️ **不要使用示例值**。这两个密钥决定整个平台的安全性,丢一个就要全员改密 + 重新签 JWT。建议存到 secret manager(Vault / 1Password / Bitwarden)。

### 2.3 准备 `.env`

```bash
cp .env.example .env
vi .env
```

填入:
```env
ENCRYPTION_KEY=fErMj8t/Uozv3N8fRbX1xQ5J6zH4iSw9aPqV0yB2nMc=
JWT_SECRET=a1b2c3d4e5f6...
PORT=3000
```

### 2.4 启动

```bash
docker compose up -d
```

首次会触发多阶段构建(~2-3 分钟),之后秒起。

### 2.5 验证

```bash
# 1) 容器状态
docker compose ps

# 2) healthcheck
docker inspect --format='{{json .State.Health}}' opsgate | jq

# 3) 直接打 health 端点
curl http://localhost:3000/api/v1/health
# 预期:{"status":"ok","activeSessions":0,"uptime":42,"version":"2.0.0"}
```

---

## 3. 镜像构建

### 3.1 多阶段构建说明

`Dockerfile` 用两阶段:

| 阶段 | 基础镜像 | 作用 |
|------|----------|------|
| `builder` | `node:22-alpine` | 装依赖 + `npm run build` 编译 server/cli/web |
| `runner` | `node:22-alpine` | 只复制 `dist/` `web-dist/` `node_modules/`,非 root 运行 + `tini` PID 1 |

最终镜像 **~200MB**。

### 3.2 自定义构建

```bash
# 自定义 tag
docker build -t my-registry.example.com/opsgate:2.0.0 .

# 推私有 registry
docker push my-registry.example.com/opsgate:2.0.0

# 改 docker-compose.yml image 指向私有仓库后,直接拉现成镜像
```

### 3.3 镜像内布局

```
/app/
├── packages/
│   ├── server/dist/   # HTTP + MCP 入口
│   └── cli/dist/      # opsgate CLI
├── web-dist/          # 静态前端(Vite build 产物)
├── node_modules/      # 运行时依赖
├── data/              # SQLite DB + 上传/下载缓存(挂载卷)
└── logs/              # 日志(挂载卷)
```

---

## 4. 访问与登录

### 4.1 Web UI

浏览器打开 `http://<host>:3000/`,默认登录:
```
用户名: admin
密码:   admin123
```

> ⚠️ 首次登录后**立刻改密**!admin 凭据启动时打印警告到 stdout。

### 4.2 创建其他 Operator(给人用)

通过 Web UI 的"用户管理"页面,或调 API:
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"name":"admin","password":"admin123"}' | jq -r .token)

curl -X POST http://localhost:3000/api/v1/operators \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "name": "alice",
    "type": "human",
    "scopes": ["read", "write"],
    "serverPermissions": []
  }'
```

### 4.3 创建 API Key(给 AI Agent 用)

```bash
curl -X POST http://localhost:3000/api/v1/operators \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "name": "deploy-bot",
    "type": "agent",
    "scopes": ["read", "write"],
    "serverPermissions": ["web-1", "web-2"]
  }'
```

返回的 `apiKey`(`sk-...`)**只显示一次**,立即存到 secret manager。

### 4.4 Agent 用 API Key 调 API

```bash
curl -X POST http://localhost:3000/api/v1/servers/web-1/exec \
  -H "authorization: Bearer sk-xxx" \
  -H "content-type: application/json" \
  -d '{"command":"uptime"}'
```

### 4.5 CLI(`opsgate`)

容器内自带:
```bash
docker compose exec opsgate opsgate ping
docker compose exec opsgate opsgate batch "uptime" --tag web
```

本机装:
```bash
npm install -g @opsgate/cli
opsgate login
opsgate ping
```

---

## 5. 数据持久化

### 5.1 挂载点

`docker-compose.yml` 定义两个 named volume:

| Volume | 容器内路径 | 存什么 |
|--------|------------|--------|
| `opsgate-data` | `/app/data` | SQLite DB + 上传/下载缓存 |
| `opsgate-logs` | `/app/logs` | 应用日志 |

容器删了数据还在。要彻底清,`docker volume rm opsgate-data`。

### 5.2 改 host bind mount

把数据放特定目录:
```yaml
volumes:
  - /srv/opsgate/data:/app/data
  - /srv/opsgate/logs:/app/logs
```

---

## 6. 升级

```bash
# 1) 拉新代码
git pull
git checkout v2.0.1   # 或新 tag

# 2) 重建 + 重启(数据卷保留,DB 自动 migrate)
docker compose build
docker compose up -d

# 3) 验证
curl http://localhost:3000/api/v1/health
```

升级前建议:
- **先备份**(见 §7)
- **先看 CHANGELOG**,看是否有 breaking change
- **小版本**(2.0.x)无缝升级,**大版本**(2.x → 3.x)看迁移指南

---

## 7. 备份与恢复

### 7.1 备份

```bash
docker run --rm \
  -v opsgate-data:/data:ro \
  -v $(pwd):/backup \
  alpine:3.20 sh -c "
    apk add --no-cache sqlite
    sqlite3 /data/platform.db \".backup '/backup/platform-\$(date +%Y%m%d).db'\"
  "
```

输出 `./backup/platform-20260621.db`。

### 7.2 恢复

```bash
docker compose stop opsgate
docker run --rm \
  -v opsgate-data:/data \
  -v $(pwd):/backup \
  alpine:3.20 sh -c "
    apk add --no-cache sqlite
    cp /backup/platform-20260621.db /data/platform.db
  "
docker compose start opsgate
```

> 💡 DB 备份包含**加密后的** SSH 凭证,只要 `ENCRYPTION_KEY` 没丢,恢复到新环境时密钥不丢就能解。

### 7.3 定时备份(crontab)

```cron
0 2 * * * cd /srv/opsgate && /usr/local/bin/docker run --rm -v opsgate-data:/data:ro -v $(pwd)/backups:/backup alpine:3.20 sh -c "apk add --no-cache sqlite >/dev/null && sqlite3 /data/platform.db \".backup '/backup/platform-\$(date +\%Y\%m\%d).db'\" && find /backup -name 'platform-*.db' -mtime +30 -delete"
```

每天凌晨 2 点备份,保留 30 天。

---

## 8. 监控与日志

### 8.1 健康检查

`docker-compose.yml` 配了:
```yaml
healthcheck:
  test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/api/v1/health"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s
```

查看:
```bash
docker compose ps        # STATUS 列显示 (healthy) / (unhealthy)
docker inspect --format='{{.State.Health.Status}}' opsgate
```

### 8.2 Prometheus 集成(可选)

opsgate 暂未自带 `/metrics`,推荐用 blackbox exporter 探 health:
```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'opsgate'
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets: ['opsgate.local:3000/api/v1/health']
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox_exporter:9115
```

### 8.3 日志

```bash
# 实时
docker compose logs -f opsgate

# 最近 100 行
docker compose logs --tail=100 opsgate

# 应用日志(host)
ls -lah /var/lib/docker/volumes/opsgate-logs/_data/
```

`docker-compose.yml` 配了 json-file 驱动,单文件最大 10MB,保留 3 个。

---

## 9. 生产加固

按需勾选(以重要程度排序):

- [ ] **改 admin 默认密码**(首次登录后立刻)
- [ ] **HTTPS + 反向代理**(nginx / Caddy / Traefik) — 详情见 §9.1
- [ ] **防火墙只暴露 443**,3000 端口只对内网或反代开
- [ ] **定期备份** SQLite DB(§7.3)
- [ ] **`ENCRYPTION_KEY` / `JWT_SECRET` 用 secret manager**(不要 commit 到 git)
- [ ] **禁用 admin 给 Agent** — 单独建 `type: "agent"` 的 operator,只给必要的 `serverPermissions`
- [ ] **资源限制**(`docker-compose.yml` 加):
  ```yaml
  services:
    opsgate:
      deploy:
        resources:
          limits:
            cpus: '2'
            memory: 1G
          reservations:
            memory: 256M
  ```
- [ ] **定期 rotate API Key** — 90 天一次
- [ ] **审计日志导出** — v2.1 将支持 S3 归档

### 9.1 反代示例(nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name opsgate.example.com;

  ssl_certificate     /etc/letsencrypt/live/opsgate.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/opsgate.example.com/privkey.pem;

  # 限制 body 大小(防大文件上传 DoS)
  client_max_body_size 100m;

  # 反代 HTTP
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # WebSocket 升级
  location /api/v1/ws/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;  # 长连接
  }
}
```

### 9.2 限制 admin 来源 IP

```nginx
# /etc/nginx/conf.d/opsgate-admin.conf
location /api/v1/auth/login {
  allow 10.0.0.0/8;        # 办公室网段
  allow 192.168.1.0/24;     # 跳板机
  deny all;
  proxy_pass http://127.0.0.1:3000;
}
```

---

## 10. 常见问题

### Q1: 启动报 `ENCRYPTION_KEY must be set`
`.env` 没填或 `docker compose` 没读到。
```bash
cat .env
docker compose config | grep ENCRYPTION_KEY
```

### Q2: healthcheck 一直 unhealthy
```bash
docker compose logs opsgate | tail -50
```
常见:
- 端口被占用 → 改 `PORT`
- 启动 10s 内还没监听 → `start_period` 调到 30s
- `wget` 命令找不到(不会,镜像里 `apk add wget` 已装)

### Q3: 升级后老数据读不出来
`ENCRYPTION_KEY` 换了 → 所有加密的 SSH 凭证都解不开,但**不会报错**,只是 `getDecryptedCredentials()` 抛解密异常。
**回滚** `ENCRYPTION_KEY` 到旧值即可。

### Q4: Web 终端打不开
- 浏览器控制台看 WS 连接 — 401 / 403 → token 失效,重新登录
- 反向代理要 upgrade WebSocket — nginx 加 `proxy_set_header Upgrade $http_upgrade;`

### Q5: 想换 SQLite 到 Postgres
v2.0 暂不支持,DB 层用 Drizzle ORM,理论上能换 driver,但需要重写 migrate。当前推荐 SQLite(WAL 模式),够撑中等规模(几千台 server 元数据 + 几十万条审计)。

### Q6: 怎么进容器调试
```bash
docker compose exec opsgate sh
# 在容器内:
opsgate-server --help
opsgate ping
ls -la /app/data/
sqlite3 /app/data/platform.db ".tables"
sqlite3 /app/data/platform.db "SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 10;"
```

### Q7: 多实例部署
opsgate 当前设计是**单实例**。要做 HA:
- DB 换 Postgres(共享)
- 用 sticky session 负载均衡
- `SSHConnectionPool` 内存态,无法跨实例共享 → shell 模式连接绑定到单实例
- 计划 v3.0 引入 Redis 共享 session state

### Q8: 性能调优
```yaml
# docker-compose.yml
environment:
  - NODE_OPTIONS=--max-old-space-size=2048
  - UV_THREADPOOL_SIZE=16   # Node IO 线程池
```

### Q9: opsgate CLI 怎么用?
容器内已装:
```bash
docker compose exec opsgate opsgate ping
docker compose exec opsgate opsgate batch "uptime" --tag web
```
本机装:
```bash
npm install -g @opsgate/cli
opsgate login    # 提示输入 sk-xxx
opsgate ping     # 验证连得通
```

### Q10: 怎么从 v1 升级
- v1 npm 包 `@fangjunjie/ssh-mcp-server` 仍可继续用
- v2 推荐起一个独立 opsgate 实例(共用同一批 SSH 服务器即可,不会冲突)
- SSH 服务器端不需要任何改动

---

## 更多信息

- [README.md](../README.md) — 项目总览
- [CHANGELOG.md](../CHANGELOG.md) — 版本变更
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 架构
- [docs/SECURITY.md](SECURITY.md) — 安全模型
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献指南
- `.trae/specs/ai-agent-devops-platform/` — 完整 spec / tasks / checklist
