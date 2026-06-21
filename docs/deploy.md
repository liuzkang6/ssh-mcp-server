# Docker 部署指南

> 把 **AI Agent 增强的 DevOps 中台**(v2.0)用 Docker Compose 一键起跑的完整说明。

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

## 1. 前置要求

- **Docker Engine** ≥ 20.10
- **Docker Compose** v2(`docker compose`,不是老版的 `docker-compose`)
- 至少 **1 GB** 可用内存(monorepo build 期间需要 ~500 MB)
- 至少 **2 GB** 可用磁盘

验证:

```bash
docker --version        # Docker version 20.10+
docker compose version  # Docker Compose version v2.x+
```

## 2. 快速开始

### 2.1 克隆仓库

```bash
git clone https://github.com/classfang/ssh-mcp-server.git
cd ssh-mcp-server
git checkout refactor/monorepo   # v2.0 在这个分支
```

### 2.2 生成密钥

两个必填环境变量:

```bash
# 32 字节 base64 编码 — 用于 AES-256-GCM 加密 SSH 凭证
openssl rand -base64 32

# 任意长字符串 — 用于 JWT 签名
openssl rand -hex 32
```

> ⚠️ **不要使用示例值**。这两个密钥决定了整个平台的安全性,丢一个就要全员改密 + 重新签 JWT。

### 2.3 准备 `.env`

```bash
cp .env.example .env
vi .env
```

填入:

```env
# 把上面 openssl rand -base64 32 的输出粘进来
ENCRYPTION_KEY=AbCdEf...==

# 把上面 openssl rand -hex 32 的输出粘进来
JWT_SECRET=0123abc...==

# HTTP 端口(默认 3000)
PORT=3000
```

### 2.4 启动

```bash
docker compose up -d
```

首次会触发多阶段构建(~2-3 分钟),之后秒起。

### 2.5 验证

```bash
# 1) 看容器状态
docker compose ps

# 2) 看 healthcheck
docker inspect --format='{{json .State.Health}}' ai-devops-platform | jq

# 3) 直接打 health 端点
curl http://localhost:3000/api/v1/health
# 预期: {"status":"ok","activeSessions":0,...}
```

## 3. 镜像构建

### 3.1 多阶段构建说明

`Dockerfile` 用了两阶段:

| 阶段 | 基础镜像 | 作用 |
|------|----------|------|
| `builder` | `node:22-alpine` | 安装依赖 + `npm run build` 编译 server/cli/web 三个子包 |
| `runner` | `node:22-alpine` | 只复制 `dist/` `web-dist/` `node_modules/`,非 root 用户运行 |

体积:builder 阶段 ~600 MB(rnpm install + devDeps),runner 阶段最终镜像 **~200 MB**。

### 3.2 自定义构建

```bash
# 加构建参数 / 换 tag
docker build -t my-registry.example.com/ai-devops:2.0.0 .

# 推私有 registry
docker push my-registry.example.com/ai-devops:2.0.0
```

如果改了 `docker-compose.yml` 的 `image:` 字段指向私有仓库,启动时直接拉现成镜像,跳过构建。

### 3.3 镜像内布局

```
/app/
├── packages/
│   ├── server/dist/   # HTTP + MCP 入口
│   └── cli/dist/      # ssh-mcp-cli(可选,Web UI 用不到)
├── web-dist/          # 静态前端(Vite build 产物)
├── node_modules/      # 运行时依赖(共享 workspaces)
├── data/              # SQLite DB + 上传/下载缓存(挂载卷)
└── logs/              # 日志(挂载卷)
```

## 4. 访问与登录

### 4.1 Web UI

浏览器打开 `http://<host>:3000/`,默认登录:

```
用户名: admin
密码:   admin123
```

> ⚠️ 首次登录后 **立刻改密**!admin 凭据启动时会打印警告到 stdout。

### 4.2 创建其他 Operator

通过 Web UI 的"用户管理"页面,或调 API:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"name":"admin","password":"admin123"}' | jq -r .token)

curl -X POST http://localhost:3000/api/v1/operators \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "name": "deploy-bot",
    "type": "agent",
    "scopes": ["read","write"],
    "serverPermissions": ["dev-server","staging-server"]
  }'
```

返回的 `apiKey`(`sk-...`)**只显示一次**,立即存到 secret manager。

### 4.3 API Key 给 AI Agent 用

```bash
# Agent 用 API Key 调 API
curl -X POST http://localhost:3000/api/v1/servers/dev-server/exec \
  -H "authorization: Bearer sk-xxx" \
  -H "content-type: application/json" \
  -d '{"command":"uptime"}'
```

## 5. 数据持久化

### 5.1 挂载点

`docker-compose.yml` 定义了两个 named volume:

| Volume | 容器内路径 | 存什么 |
|--------|------------|--------|
| `ai-devops-platform-data` | `/app/data` | SQLite DB + 上传/下载缓存 |
| `ai-devops-platform-logs` | `/app/logs` | 应用日志 |

容器删了数据还在。要彻底清,`docker volume rm ai-devops-platform-data`。

### 5.2 改 host bind mount

如果想把数据放在特定目录而不是 named volume,改 compose:

```yaml
volumes:
  - /srv/ai-devops/data:/app/data
  - /srv/ai-devops/logs:/app/logs
```

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

## 7. 备份与恢复

### 7.1 备份

```bash
# 用临时容器挂同一个 volume,跑 sqlite3 备份
docker run --rm \
  -v ai-devops-platform-data:/data:ro \
  -v $(pwd):/backup \
  alpine:3.20 sh -c "
    apk add --no-cache sqlite
    sqlite3 /data/platform.db \".backup '/backup/platform-$(date +%Y%m%d).db'\"
  "
```

### 7.2 恢复

```bash
docker compose stop platform
docker run --rm \
  -v ai-devops-platform-data:/data \
  -v $(pwd):/backup \
  alpine:3.20 sh -c "
    apk add --no-cache sqlite
    cp /backup/platform-20260621.db /data/platform.db
  "
docker compose start platform
```

> 💡 DB 备份包含 **加密后的** SSH 凭证,只要 `ENCRYPTION_KEY` 没丢,恢复到新环境时密钥不丢就能解。

## 8. 监控与日志

### 8.1 健康检查

`docker-compose.yml` 里配了:

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
docker inspect --format='{{.State.Health.Status}}' ai-devops-platform
```

### 8.2 日志

```bash
# 实时
docker compose logs -f platform

# 最近 100 行
docker compose logs --tail=100 platform

# 应用日志(在 host)
ls -lah /var/lib/docker/volumes/ai-devops-platform-logs/_data/
```

`docker-compose.yml` 配了 json-file 驱动,单文件最大 10 MB,保留 3 个。

## 9. 生产加固

按需勾选:

- [ ] **改 admin 默认密码**
- [ ] **跑在反向代理后面**(nginx / Caddy / Traefik),加 HTTPS + IP 白名单
- [ ] **防火墙只暴露 443**,3000 端口只对内网或反代开
- [ ] **定期备份** SQLite DB(crontab 每天跑 7.1)
- [ ] **`ENCRYPTION_KEY` / `JWT_SECRET` 用 secret manager**(不要 commit 到 git)
- [ ] **禁用 admin 操作员** 给 Agent 用 — 单独建 `type: agent` 的 operator,只给必要的 server permission
- [ ] **加 audit log 导出到外部 SIEM** — 后续可在 Web UI 里加定时任务
- [ ] **资源限制** 在 `docker-compose.yml` 加:
  ```yaml
  deploy:
    resources:
      limits:
        cpus: '2'
        memory: 1G
  ```

## 10. 常见问题

### Q1: 启动报 `ENCRYPTION_KEY must be set`
`.env` 文件没填或 `docker compose` 没读到。检查:
```bash
cat .env
docker compose config | grep ENCRYPTION_KEY
```

### Q2: healthcheck 一直 unhealthy
```bash
docker compose logs platform | tail -50
```
常见原因:
- 端口被占用 → 改 `PORT`
- 启动 10s 内还没监听 → `start_period` 调到 30s
- `wget` 命令找不到(不会,镜像里 `apk add wget` 已装)

### Q3: 怎么进容器调试
```bash
docker compose exec platform sh
# 在容器内:
node packages/server/dist/index.js --help
ls -la /app/data/
sqlite3 /app/data/platform.db ".tables"
```

### Q4: 升级后老数据读不出来
`ENCRYPTION_KEY` 换了 → 所有加密的 SSH 凭证都解不开,但**不会报错**,只是 `getDecryptedCredentials()` 抛解密异常。
**回滚** `ENCRYPTION_KEY` 到旧值即可。

### Q5: Web 终端打不开
- 浏览器控制台看 WS 连接 — 401 / 403 → token 失效,重新登录
- 反向代理要 upgrade WebSocket — nginx 加 `proxy_set_header Upgrade $http_upgrade;`

### Q6: 想换 SQLite 到 Postgres
v2.0 暂不支持,DB 层用了 Drizzle ORM,理论上能换 driver,但需要重写 migrate。当前推荐用 SQLite,WAL 模式够支撑中等规模(几千台 server 元数据)。

---

**更多信息**:
- [README.md](../README.md) — 项目总览 + v1 MCP 用法
- [CHANGELOG.md](../CHANGELOG.md) — 版本变更
- `.trae/specs/ai-agent-devops-platform/` — 完整 spec / tasks / checklist
