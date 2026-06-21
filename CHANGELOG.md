# Changelog

All notable changes to **opsgate** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] - 2026-06-21 — "DevOps 中台"

> 本版本是项目从 v1 SSH MCP 工具升级为 **完整 DevOps 中台** 的里程碑发布,
> 同时把项目从 fork 的 `ssh-mcp-server` 重命名为自有产品 **`opsgate`**。

### 🔁 Project Rebrand

| 项 | v1 | v2 (本次) |
|----|----|-----|
| 项目名 | `ssh-mcp-server` | **`opsgate`** |
| 包 | `@fangjunjie/ssh-mcp-server` | `@opsgate/server` / `@opsgate/cli` / `@opsgate/web` |
| CLI | `npx @fangjunjie/ssh-mcp-server` | `opsgate` |
| 配置文件 | 无 | `~/.config/opsgate/config.json` |
| Docker 镜像 | 无 | `opsgate:2.0.0` |
| GitHub | 老的 fork | `https://github.com/liuzkang6/opsgate` |
| 兼容策略 | - | 老的 `@fangjunjie/ssh-mcp-server` 仍可继续用(NPX 安装 / MCP 集成不破坏) |

### 🆕 新增

#### Web UI(Vite + React 18 + Ant Design 5)
- 登录页 + JWT 存 localStorage
- 仪表盘:`Statistic` 卡片(机器总数 / 24h 操作 / 在线 session / 审计来源)+ 最近操作 Table
- 服务器列表:AntD Table + name/group/tag 过滤 + CRUD
- 服务器详情:6 个 Tab(信息 / 状态 / 命令 / 终端 / 文件 / 审计)
- **Web 终端**:xterm.js + FitAddon + WebLinksAddon,`/ws/terminal/:id?token=...` 桥接 SSH shell
  - 双向数据透传 + resize 帧
  - 指数退避自动重连(1s → 2s → 4s → 8s → 16s → 30s 封顶)
  - server 侧 shell session 30s 宽限期

#### REST API(13 个端点)
- `POST /api/v1/auth/login` — 登录拿 JWT
- `GET /api/v1/auth/whoami` — 当前操作者
- `GET /api/v1/health` — 健康检查(含 `activeSessions` 计数)
- `GET/POST /api/v1/servers` — 列表(支持 `nameLike` / `group` / `tag` 过滤) / 创建
- `GET/PATCH/DELETE /api/v1/servers/:id` — 详情 / 更新 / 删除
- `POST /api/v1/servers/:id/exec` — 单机执行命令
- `POST /api/v1/servers/:id/upload` / `/download` — SFTP 传输
- `GET /api/v1/servers/:id/active-sessions` — 当前活跃连接
- `GET/POST /api/v1/operators` — 列出 / 创建 operator
- `GET/POST/PATCH/DELETE /api/v1/operators/:name` — 单个 operator
- `POST /api/v1/operators/:name/rotate-key` — 轮换 API Key
- `GET /api/v1/audit-logs` — 审计查询(支持 serverId/operatorId/action/status/sinceMinutes/limit)
- `GET /ws/terminal/:serverId?token=<jwt>` — **WebSocket 终端**

#### MCP 工具(8 个)
- 4 个沿用:`execute_command` / `upload` / `download` / `list_servers`
- 4 个新增:
  - `get_server_status` — CPU / 内存 / 磁盘 / 负载 / uptime
  - `batch_execute_command` — 跨多机并行,带 `summary` 汇总
  - `search_files` — `find` / `grep` / `locate` 三种模式
  - `query_audit_logs` — 按时间 / server / operator / status 过滤

#### CLI 工具(25+ 子命令,统一 `opsgate` 命令)
- 核心:`opsgate login / logout / whoami / version / config / ping`
- 业务:`opsgate server (list|get|create|update|delete)` + `agent (list|get|create|rotate-key|delete)`
- 操作:`opsgate exec <server> <cmd>` / `batch <cmd> --group --tag --parallel --fail-fast --dry-run` / `scp upload|download <local> <server>:<remote>`
- 导航:`opsgate terminal <server>`(`ssh` 是 alias) / `status <server>` / `search <servers...> --pattern <p>`
- 审计:`opsgate audit list --serverId --operatorId --action --status --sinceMinutes --limit`
- 加分:`opsgate completion bash|zsh|fish` 输出 shell completion 脚本
- 三种输出格式:`--format table|json|text`(默认 text 带颜色),亦可 `opsgate config set output json` 全局默认
- API Key 存 `~/.config/opsgate/config.json`,文件权限 600
- 环境变量覆盖:`OPSGATE_API_KEY` / `OPSGATE_API_BASE`(优先级最高)

#### 持久化 & 加密
- **SQLite (better-sqlite3 + WAL + 外键约束)**,4 张表 `servers` / `operators` / `sessions` / `audit_logs`
- **AES-256-GCM 加密**所有 SSH 凭证(password / privateKey / passphrase),32 字节 base64 key,12 字节随机 nonce
- 启动时强校验 `ENCRYPTION_KEY` 长度(32 字节 base64 解码后 ≥ 32 字节)
- **Drizzle ORM** + 自动 migrate(首次启动建表,后续幂等)

#### 鉴权 & RBAC
- **HMAC-SHA256 JWT**(1h 过期,无第三方库)
- **bcrypt 12 rounds** 密码 hash
- 三类 scope:`admin` / `read` / `write`
- per-operator `serverPermissions[]` 白名单(空 = 全部)
- 统一 `verifyBearer` 自动判 JWT / API Key

#### 审计
- 全量审计:8 MCP 工具 + 13 REST 端点 + WebSocket 终端
- `output > 10KB` 自动截断 + 末尾 `...(truncated)`
- `password=xxx` / `BEGIN PRIVATE KEY` / `Bearer sk-xxx` 自动脱敏
- API 查询支持 serverId / operatorId / action / status / sinceMinutes / limit 过滤

#### SSH 引擎加固
- **SSH 连接池**:`SSHConnectionPool` 按 `(operatorId, serverId, mode)` 缓存,`refCount` 引用计数
- `releaseWithGrace` + `draining` Map:shell 模式断开后 30s 宽限,过期才真释放
- `tryReuseDraining`:复用期内新请求直接接管,避免反复 SSH 握手
- shell / exec 双传输:exec 走短连接,shell 走持久连接
- 命令白/黑名单、路径白名单、命令模板、2FA / MFA、SOCKS 代理、SSH config 复用、Keepalive
- `socks://user:pass@host:port` 透传到 ssh2 Client

#### Docker
- **多阶段构建**:builder 阶段 `npm install + npm run build`;runner 阶段只复制 dist + web-dist + node_modules
- 基础镜像 `node:22-alpine` + `tini` PID 1
- 最终镜像 **~200MB**
- docker-compose 单服务,挂载 `data` / `logs` named volume
- 健康检查 `wget --spider /api/v1/health`,30s 一次,失败 3 次转 unhealthy
- json-file 日志驱动,单文件最大 10MB,保留 3 个

### 🔒 安全
- 凭证落库前全走 AES-256-GCM,启动时强校验 key 长度
- 错误响应统一结构 `{ code, message, retriable }`,防信息泄露
- `errorMessage` 入库前脱敏(password / token / 私钥)
- admin 默认密码 `admin123` 启动时打印警告,首次登录强制改密
- 401 自动跳登录页,token 失效时统一处理
- Web 终端 token 走 query string(`?token=<jwt>`),避免浏览器自定义 header 限制

### 🧪 测试
- **180 个测试** 全部通过(46 个 suite)
- 覆盖:CLI 解析 / crypto / SSH 连接池 / session 生命周期 / 7 个 MCP tool / HTTP API / 审计查询
- 端到端:`test-p10-ws.mjs` 验证 WebSocket 鉴权 + 错误帧 + 重连流程
- 等价验证:docker 沙箱无,改用 `node packages/server/dist/index.js` + `wget --spider` 模拟

### 📚 文档
- 🆕 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构详解(mermaid 图)
- 🆕 [docs/CLI.md](docs/CLI.md) — CLI 25+ 子命令完整参考
- 🆕 [docs/API.md](docs/API.md) — REST 13 端点参考
- 🆕 [docs/MCP.md](docs/MCP.md) — 8 个 MCP 工具 schema
- 🆕 [docs/DEPLOY.md](docs/DEPLOY.md) — Docker 部署指南
- 🆕 [docs/SECURITY.md](docs/SECURITY.md) — 安全模型
- 🆕 [CONTRIBUTING.md](CONTRIBUTING.md) — 贡献者指南
- 重写 [README.md](README.md) / [README_CN.md](README_CN.md) — 产品风格
- 完整 spec / tasks / checklist 在 `.trae/specs/ai-agent-devops-platform/`

### ⚠️ Breaking Changes(相对 v1)
- **CLI 命令**:`ssh-mcp-cli` → `opsgate`,**老命令不可用**;可通过 `opsgate` 内置帮助平滑过渡
- **配置文件**:`~/.config/ssh-mcp-cli/config.json` → `~/.config/opsgate/config.json`(老 config 不会被自动迁移)
- **环境变量**:`SSH_MCP_API_KEY` / `SSH_MCP_API_BASE` → `OPSGATE_API_KEY` / `OPSGATE_API_BASE`(旧名仍兼容)
- **包名**:`@platform/cli` → `@opsgate/cli`;`@platform/server` → `@opsgate/server`
- **Docker 镜像**:`ai-devops-platform:*` → `opsgate:*`
- npm 旧入口 `@fangjunjie/ssh-mcp-server` 仍可继续使用(NPX 安装 / MCP 集成不破坏)

### 🔄 从 v1 迁移
v1 用户无需任何改动,`npx -y @fangjunjie/ssh-mcp-server` 仍然按原方式工作。
新功能(Web UI / API / Docker / CLI 25 子命令 / 审计)都是叠加的,不会破坏现有 MCP 集成。

如果想用 v2 的 CLI,把 `ssh-mcp-cli` 替换成 `opsgate`,把 `~/.config/ssh-mcp-cli/` 改名成 `~/.config/opsgate/` 即可。

---

## [1.8.x] - Earlier

详见 git tag 历史。v1 主要是 NPX 即跑的 SSH MCP 工具,4 个 tool:`execute_command` / `upload` / `download` / `list_servers`。
