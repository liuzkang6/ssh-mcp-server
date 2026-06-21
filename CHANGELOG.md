# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-06-21

### 🔁 Project Rebrand — `ssh-mcp-server` → **`opsgate`**

> 本项目从原 fork 的 `ssh-mcp-server` 升级为自有产品 **`opsgate`**,以反映 v2 已从单 NPX 工具蜕变为完整 DevOps 中台。
>
> - 包名:`@platform/*` → `@opsgate/*`(@opsgate/server / @opsgate/cli / @opsgate/web)
> - CLI bin:`ssh-mcp-cli` → `opsgate`
> - 配置文件:`~/.config/ssh-mcp-cli/` → `~/.config/opsgate/`
> - 环境变量:`SSH_MCP_*` → `OPSGATE_*`(保留旧名作 deprecation 兼容,3 个大版本后移除)
> - Docker 镜像:`ai-devops-platform:2.0.0` → `opsgate:2.0.0`
> - GitHub 仓库:`https://github.com/liuzkang6/opsgate`
>
> v1 包名 `@fangjunjie/ssh-mcp-server` 仍可继续使用(NPX 安装 / MCP 集成不破坏)。

### 🆕 Added — v2.0: AI Agent 增强的 DevOps 中台

> v1 是一个 NPX 即跑的 SSH MCP 工具;v2 在保留 v1 所有能力的同时,把它升级成了一个带 Web UI / REST API / RBAC / 审计 / Docker 一键部署的 **DevOps 中台**,让 AI Agent 和人类管理员都能在受控的环境下操作成百上千台服务器。

#### 核心架构变化
- **monorepo 改造**:仓库改为 npm workspaces,3 个子包 `packages/server` (HTTP + MCP) / `packages/cli` (22+ 子命令) / `packages/web` (Vite + React + Ant Design)
- **持久化层**:SQLite (better-sqlite3 + WAL + 外键约束) + Drizzle ORM,4 张表 `servers` / `operators` / `sessions` / `audit_logs`
- **加密层**:AES-256-GCM,32 字节 base64 key,12 字节随机 nonce,凭证 `password` / `privateKey` / `passphrase` 全部加密落库
- **鉴权**:HMAC-SHA256 JWT(无第三方 JWT 库,1h 过期) + bcrypt 12 rounds hash,统一 `verifyBearer` 自动判 JWT / API Key
- **RBAC**:Operator 三类 scope(`admin` / `read` / `write`)+ `serverPermissions` 列表,空 = 全部,非空 = 白名单;Agent 通过 API Key 鉴权
- **审计**:全量审计 — 8 个 MCP tool + 5 个 HTTP 路由 + WebSocket 终端,`output > 10KB` 自动截断,`password=xxx` / `BEGIN PRIVATE KEY` 自动脱敏

#### MCP 工具扩展(原 4 个 → 8 个)
- `execute-command` / `upload` / `download` / `list-servers`(v1 沿用,接 ServerManager)
- 🆕 `get-server-status` — 单机 CPU / 内存 / 磁盘 / 负载 / uptime
- 🆕 `batch-execute-command` — 跨多机并行执行(parallel N),带 `summary` 汇总
- 🆕 `search-files` — `find` / `grep` / `locate` 三种模式
- 🆕 `query-audit-logs` — 按时间 / server / operator / status 过滤

#### HTTP REST API(13 个端点)
- `POST /api/v1/auth/login` — 用户名密码登录拿 JWT
- `GET/POST/PUT/DELETE /api/v1/servers[/:id]` — CRUD + `nameLike` / `group` / `tag` 过滤
- `POST /api/v1/servers/:id/exec` — 单机执行命令
- `POST /api/v1/servers/:id/upload` / `/download` — SFTP 传输
- `GET /api/v1/servers/:id/active-sessions` — 当前活跃连接(每 5s 轮询)
- `GET /api/v1/audit-logs` — 审计查询
- `GET /api/v1/health` — 健康检查(含 `activeSessions`)
- `GET /ws/terminal/:serverId?token=<jwt>` — **WebSocket 终端**(`@fastify/websocket`)

#### Web UI(Vite + React 18 + Ant Design 5)
- `/login` — 登录页,JWT 存 localStorage
- `/` Dashboard — 4 张 Statistic(机器总数 / 24h 操作 / 在线 session / 审计来源) + 最近操作 Table
- `/servers` — 列表(支持 name 搜索 / group / tag 过滤 / 新建 / 编辑 / 删除)
- `/servers/:id` — 6 Tab(信息 / 状态(active-sessions 轮询) / 命令(exec) / 终端(xterm.js) / 文件(upload+download) / 审计)
- **Web 终端** — xterm.js + FitAddon + WebLinksAddon,`/ws/terminal/:id?token=...` 桥接 SSH shell
  - 双向数据透传 + resize 帧
  - 指数退避自动重连(1s → 2s → 4s → 8s → 16s → 30s 封顶)
  - server 侧 shell session 30s 宽限期(`SSHConnectionPool.releaseWithGrace` + `draining` Map + `tryReuseDraining`)

#### CLI 工具(22+ 子命令,统一 `opsgate` 命令)
- `opsgate login / logout / whoami / version / config / ping`
- `opsgate server list/get/create/update/delete`
- `opsgate exec <server> <cmd>` — 单机执行(`opsgate ssh <server>` 是 `terminal` 的别名)
- `opsgate batch <cmd>` — 按 `--group` / `--tag` 批量执行,带 `--parallel` / `--fail-fast` / `--dry-run`
- `opsgate scp upload/download <local> <server>:<remote>` — 走 API SFTP
- `opsgate terminal <server>` — 唤起浏览器
- `opsgate status <server>` — 拼装 /active-sessions + /health
- `opsgate search <servers...> --pattern <p>` — 多机 grep
- `opsgate agent list/get/create/rotate-key/delete` — Operator 管理
- `opsgate audit list` — 审计查询(支持 serverId/operatorId/action/status/sinceMinutes/limit)
- `opsgate completion bash|zsh|fish` — shell completion 脚本
- 三种输出格式 `--format table|json|text`(默认 text,带颜色),亦可 `opsgate config set output json` 全局默认
- API Key 存 `~/.config/opsgate/config.json`,文件权限 600

#### 部署
- **Dockerfile** 多阶段构建:builder 阶段 `npm install + npm run build`;runner 阶段只复制 `dist/ + web-dist + node_modules`,基于 `node:22-alpine`,`tini` 启动
- **docker-compose.yml** 单服务,挂载 `data` / `logs` 卷,必填 `ENCRYPTION_KEY` / `JWT_SECRET`
- **健康检查** `wget --spider http://localhost:3000/api/v1/health`,30s 一次,3 次失败转 unhealthy
- **.env.example** 模板 + 注释生成命令
- 详见 [docs/deploy.md](docs/deploy.md)

#### SSH 引擎加固
- **SSH 连接池** — 按 `(operatorId, serverId, mode)` 缓存,`refCount` 引用计数,`releaseWithGrace` 让 shell 模式有 30s 复用窗口
- **shell / exec 双传输** — `exec` 支持 upload/download,`shell` 走持久 shell + 内部命令队列
- **命令白/黑名单** — 正则匹配,先 whitelist 后 blacklist,任一不通过就拒
- **路径白名单** — `allowedLocalPaths` / `allowedRemotePaths`,SFTP 仅接受绝对 POSIX 路径
- **命令模板** — `commandTemplate` 包裹整条命令,`<quotedCommand>` / `<command>` 两种占位符
- **2FA / MFA** — `tryKeyboard` + 环境变量 `SSH_MCP_2FA_CODE`
- **SOCKS 代理** — `socks://user:pass@host:port` 透传
- **SSH config 复用** — 读 `~/.ssh/config`,命令行参数覆盖
- **Keepalive** — `keepaliveIntervalMs: 10000, keepaliveCountMax: 3` 默认

### 🔒 Security
- 凭证(password / privateKey / passphrase)AES-256-GCM 加密落库
- 启动时校验 `ENCRYPTION_KEY` 长度(32 字节 base64 解码后必须 ≥ 32 字节)
- `errorMessage` 入库前脱敏(password / token / 私钥)
- 错误响应统一结构 `{ code, message, retriable }`,防信息泄露
- admin 默认密码 `admin123` 启动时打印警告,强制首次登录修改
- 401 自动跳登录页,token 失效时统一处理

### 🧪 Testing
- **180 个测试** 全部通过(46 个 suite)
- 覆盖:CLI 解析 / crypto / SSH 连接池 / session 生命周期 / 7 个 MCP tool / HTTP API / 审计查询
- 集成测试:`test-p10-ws.mjs` 验证 WS 鉴权 + ready/error 帧流程
- 等价验证:docker 沙箱无,改用 `node packages/server/dist/index.js` + `wget --spider` 模拟(boot 1.3s < 5s)

### 📚 Documentation
- 🆕 [docs/deploy.md](docs/deploy.md) — Docker 部署指南
- 🆕 [CHANGELOG.md](CHANGELOG.md) — 本文件
- [README.md](README.md) / [README_CN.md](README_CN.md) — 保留 v1 全部 MCP 使用文档,顶部加 v2.0 章节
- `.trae/specs/ai-agent-devops-platform/` — 完整 spec + tasks + checklist(32 个 Phase 0-14)

### ⚠️ Breaking Changes(相对 v1)
- **CLI 命令**:`ssh-mcp-cli` → `opsgate`,**老命令不可用**;可通过 `opsgate` 内置帮助平滑过渡
- **配置文件**:`~/.config/ssh-mcp-cli/config.json` → `~/.config/opsgate/config.json`;老 config 不会被自动迁移
- **环境变量**:`SSH_MCP_API_KEY` / `SSH_MCP_API_BASE` → `OPSGATE_API_KEY` / `OPSGATE_API_BASE`(旧名仍兼容)
- **包名**:`@platform/cli` → `@opsgate/cli`;`@platform/server` → `@opsgate/server`
- **Docker 镜像**:`ai-devops-platform:*` → `opsgate:*`
- npm 旧入口 `@fangjunjie/ssh-mcp-server` 仍可继续使用(NPX 安装 / MCP 集成不破坏)
- DB schema 是新增的,首次启动自动 migrate,**不会**读取 v1 的 `~/.ssh/config` 以外的数据

### 🔄 Migration from v1
v1 用户无需任何改动,`npx -y @fangjunjie/ssh-mcp-server` 仍然按原方式工作。新功能(Web UI / API / Docker / CLI 22 子命令 / 审计)都是叠加的,不会破坏现有 MCP 集成。

如果想用 v2 的 CLI,把 `ssh-mcp-cli` 替换成 `opsgate`,把 `~/.config/ssh-mcp-cli/` 改名成 `~/.config/opsgate/` 即可。

## [1.8.3] - Earlier

详见 git tag 历史。v1 主要是 NPX 即跑的 SSH MCP 工具,4 个 tool:`execute-command` / `upload` / `download` / `list-servers`。
