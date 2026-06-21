# AI Agent 增强的 DevOps 中台 — 规格说明书

## Why

现有 `ssh-mcp-server`(v1)是个纯 MCP 工具,只支持 AI Agent 通过 stdio 调用,缺乏:Web UI、CLI、多用户隔离、审计、凭证加密、批量操作。要把它升级(并重命名为 **opsgate**)为一个**支持人和 AI Agent 并行操作**的 SSH 机器管理中台,使 DevOps 团队既能直接用 Web 管控机器,又能让 AI Agent 安全高效地代为执行。

## What Changes

- **新增** Fastify HTTP API,封装现有 SSH 操作(同进程内,与 MCP 共享连接池)
- **新增** SQLite + Drizzle ORM 持久化层(4 张表: `servers` / `operators` / `sessions` / `audit_logs`)
- **新增** 凭证 AES-256-GCM 加密存取(`SecureStore`)
- **新增** 鉴权层:人类 JWT(1h) + Agent API Key(长期)
- **新增** RBAC:scope 三级(`read` / `write` / `admin`)+ server 级权限
- **新增** Per-Operator 隔离的 `SSHConnectionPool`(原 `SSHConnectionManager` 拆分)
- **新增** Web UI(React + Vite + Ant Design),6 个核心页面
- **新增** Web 终端(xterm.js + WebSocket,基于现有 shell 模式)
- **新增** CLI 工具 monorepo 子包(`@opsgate/cli`,22+ 子命令,Commander.js;CLI bin 为 `opsgate`)
- **新增** 4 个 MCP 工具: `get_server_status` / `batch_execute_command` / `search_files` / `query_audit_logs`
- **改造** 现有 4 个 MCP 工具对接新数据源和审计
- **改造** 项目结构为 monorepo:`packages/server` / `packages/cli` / `packages/web`
- **新增** Docker + docker-compose 一键启动
- **保留** 现有 SSHConnectionManager 核心逻辑(只拆分,不重写)
- **保留** 现有 stdio MCP 传输(继续给 Claude/Cursor 用)
- **保留** 现有白/黑名单、路径校验、SOCKS、2FA、exec/shell 双模式能力

## Impact

- **Affected specs(能力)**:
  - 机器管理(CRUD + 凭证加密)
  - 操作者管理(人 + Agent 统一)
  - 鉴权与权限(JWT + API Key + RBAC)
  - SSH 连接池(per-operator 隔离)
  - 命令执行(单 + 批量 + 终端)
  - 文件传输(SFTP)
  - 审计与回放
  - MCP 工具集(8 个)
  - CLI 命令集(22+)
  - Web UI(6 页面)
  - 部署(Docker)

- **Affected code(关键文件/系统)**:
  - `src/services/ssh-connection-manager.ts` — 拆分为 Pool + Session
  - `src/tools/*.ts` — 8 个工具,新增 4 个
  - `src/cli/command-line-parser.ts` — 弱化为启动兜底
  - `src/core/mcp-server.ts` — 加 HTTP 路由,支持双协议
  - `src/index.ts` — 启动 HTTP + MCP 双服务
  - 新增 `src/db/`(Drizzle schema + 迁移)
  - 新增 `src/security/`(加密 + 鉴权)
  - 新增 `src/http/`(REST API 路由)
  - 新增 `src/web/`(Web UI 静态托管)
  - 新增 `packages/cli/`(CLI 子包)
  - 新增 `packages/web/`(Web UI 子包)
  - 新增 `Dockerfile` + `docker-compose.yml`

## ADDED Requirements

### Requirement: 数据库与迁移

系统 SHALL 使用 SQLite + Drizzle ORM 持久化 4 张表:`servers` / `operators` / `sessions` / `audit_logs`。所有表使用 ULID 主键,时间戳字段统一存 Unix epoch 整数。

#### Scenario: 首次启动自动建表
- **WHEN** server 进程启动且数据库文件不存在
- **THEN** 自动运行 migration,创建 4 张表和必要索引

#### Scenario: 已有数据库时跳过建表
- **WHEN** server 启动且表已存在
- **THEN** 跳过 migration,不报错

### Requirement: 凭证加密存储

系统 SHALL 使用 AES-256-GCM 加密以下字段: `servers.encrypted_password` / `servers.encrypted_private_key` / `servers.encrypted_passphrase`。主密钥 SHALL 来自环境变量 `ENCRYPTION_KEY`(base64 编码的 32 字节)。

#### Scenario: 写入密码
- **WHEN** 管理员创建/更新服务器并提供 password
- **THEN** 密码被加密后存到 `encrypted_password` 字段,日志和审计记录不出现明文

#### Scenario: 启动时缺少主密钥
- **WHEN** `ENCRYPTION_KEY` 环境变量未设置或长度不对
- **THEN** 进程立即退出并报清晰错误,不进入半加密状态

### Requirement: 双操作者鉴权

系统 SHALL 支持两类操作者统一鉴权:
- **人类**:`POST /api/v1/auth/login` 用用户名+密码换 JWT(1 小时过期)
- **Agent**:`Authorization: Bearer sk-xxx` 用 API Key 直接调 API

`operators` 表 SHALL 统一存储两者,字段 `type` 区分。

#### Scenario: 人类登录
- **WHEN** 正确用户名+密码提交到 login 端点
- **THEN** 返回 JWT,载荷含 `operatorId` / `type: 'human'` / `scopes` / `exp`

#### Scenario: Agent 调用 API
- **WHEN** 携带有效 API Key 的请求访问任意受保护端点
- **THEN** 鉴权通过,审计记录 `type: 'agent'`,操作者名为 Agent 自己的 `name`(如 `claude-laptop-01`)

#### Scenario: 错误凭证
- **WHEN** 用户名不存在或密码错误
- **THEN** 返回 401,且**不区分**两种错误(防止用户名枚举)

### Requirement: RBAC 权限模型

系统 SHALL 实现两级权限:
- **Scope**:`read` / `write` / `admin`,定义在 `operators.scopes`
- **Server 级**:`operators.server_permissions` 指定可访问 server ID 列表,空数组表示全部

#### Scenario: 越权访问 server
- **WHEN** 一个 operator 的 `server_permissions` 不含目标 server ID,试图调该 server 的工具/API
- **THEN** 返回 `403 Forbidden`,错误码 `SERVER_ACCESS_DENIED`,审计记录 `status: 'denied'`

#### Scenario: scope 不足
- **WHEN** 一个只有 `read` scope 的 operator 试图执行写操作
- **THEN** 返回 `403 Forbidden`,错误码 `INSUFFICIENT_SCOPE`

### Requirement: Per-Operator SSH 隔离池

系统 SHALL 将原 `SSHConnectionManager` 拆分为 `SSHConnectionPool`,连接 key 从 `name` 改为 `operatorId:serverId:mode`。同一台机器的 SSH Client SHALL 按 operator 隔离。

#### Scenario: 人类 A 和 Agent B 同时操作 prod-01
- **WHEN** 人类 A 开 shell、Agent B 同时跑 exec,目标都是 prod-01
- **THEN** 两者拥有独立的 `ssh2.Client`,互不干扰,A 断线不影响 B

#### Scenario: 超过单机器连接上限
- **WHEN** 同一台机器的活跃 Client 超过配置上限(默认 50)
- **THEN** 新连接请求返回 `TOO_MANY_CONNECTIONS` 错误

### Requirement: 8 个 MCP 工具

系统 SHALL 提供以下 8 个 MCP 工具(4 旧 + 4 新):

**已有(对接新数据源)**:
- `list_servers` — 从 `servers` 表读取
- `execute_command` — 增加会话管理、审计
- `upload` / `download` — 同上

**新增**:
- `get_server_status(serverName, timeout?)` — 返回 CPU/内存/磁盘/网络等系统状态
- `batch_execute_command(servers?, group?, tag?, cmdString, parallel=5, timeout?, failFast=false)` — 在多台机器并行执行,返回聚合结果
- `search_files(servers[], pattern, path?, type?, maxDepth?)` — 跨机器文件搜索
- `query_audit_logs(serverId?, operatorId?, action?, status?, sinceMinutes=60, limit=100, offset=0)` — 审计日志查询,自动按 `server_permissions` 过滤

#### Scenario: batch_execute_command 成功
- **WHEN** 调用时指定 `--group production --cmd "uptime" --parallel 5`
- **THEN** 5 台机器同时执行 `uptime`,返回结构化结果数组 + summary,且每台机器各写一行 audit_log

#### Scenario: batch_execute_command failFast
- **WHEN** `failFast=true` 且第一台执行失败
- **THEN** 立即取消其他进行中的调用,已完成的写入审计,未完成的标记 `cancelled`

#### Scenario: query_audit_logs 越权
- **WHEN** operator 查自己无权访问的 server 的审计
- **THEN** 自动过滤掉这些 server 的记录,即使 ID 被显式传入

### Requirement: Web UI

系统 SHALL 提供 Web UI(React + Vite + Ant Design),6 个核心页面:
- `/login` — 登录
- `/` — 仪表盘
- `/servers` — 服务器列表
- `/servers/:id` — 服务器详情(5 Tab:终端/命令/文件/状态/审计)
- `/operators` — 操作者管理
- `/audit` — 审计中心

#### Scenario: 服务器详情页终端 Tab
- **WHEN** 用户打开 `/servers/prod-01` 并切到"终端" Tab
- **THEN** 看到 xterm.js 渲染的实时终端,可通过 WebSocket 与 server 的 shell session 桥接,输入字符立刻传到 prod-01

#### Scenario: 显示当前并发连接
- **WHEN** 服务器详情页加载
- **THEN** 显示"当前连接"列表,人类/Agent 各一行,显示 operator 名、type、开始时间

### Requirement: Web 终端

系统 SHALL 在 server 进程内实现 WebSocket 端点 `/ws/terminal/:serverId`,桥接到 `SSHConnectionPool` 的 shell session。

#### Scenario: 终端断线重连
- **WHEN** 浏览器到 server 的 WebSocket 断开
- **THEN** 浏览器自动重连(退避策略),server 侧的 shell session 不自动关,等待 30s 宽限期

#### Scenario: 窗口大小同步
- **WHEN** 浏览器调整终端大小
- **THEN** 通过 `{ type: 'resize', rows, cols }` 帧同步到 server,server 调 `stream.setWindow()` 通知 SSH

### Requirement: CLI 工具

系统 SHALL 在 monorepo 子包 `packages/cli` 提供 `opsgate` 命令,基于 Commander.js,支持 22+ 子命令(server / exec / batch / scp / terminal / status / agent / audit / whoami / login / config / version / ping / completion),三种输出格式(`table` / `json` / `text`)。

#### Scenario: CLI 调用与 MCP tool 1:1 对应
- **WHEN** 调用 `opsgate batch <cmd> --tag web --format json`
- **THEN** 等价于 MCP 调 `batch_execute_command(servers=[...从tag=web过滤], cmdString="uptime", parallel=5)`,返回 JSON 输出

#### Scenario: Agent 通过环境变量鉴权
- **WHEN** 设置 `OPSGATE_API_KEY=sk-xxx` 后调用 `opsgate server list`
- **THEN** CLI 自动用该 key 鉴权,不读 config 文件

### Requirement: 审计与脱敏

系统 SHALL 对所有 SSH 调用和状态变更写 `audit_logs`。`output` 字段 SHALL 自动截断到 10KB。`error_message` SHALL 过滤任何包含 `BEGIN PRIVATE KEY` / `password=` / `passphrase=` 的子串。

#### Scenario: 写入 audit_log
- **WHEN** 任意 MCP tool / API 端点 / WebSocket 调用执行完成
- **THEN** 在 `audit_logs` 表新增一行,字段含:operator / server / action / input / output(截断) / exitCode / status / durationMs / createdAt

#### Scenario: 凭证泄露防护
- **WHEN** 错误信息中包含 `password=secret123`
- **THEN** 入库前替换为 `password=***`,原始值不落 DB

### Requirement: 容器化部署

系统 SHALL 提供 `Dockerfile` + `docker-compose.yml`,单个容器跑完整平台,数据卷挂载 `/app/data`(SQLite)和 `/app/logs`。MCP 仍通过 stdio 在客户端本地启动,容器只暴露 Web UI 3000 端口。

#### Scenario: 一键启动
- **WHEN** 在仓库根目录运行 `docker compose up -d`
- **THEN** 容器启动,~5s 内 `/api/v1/health` 返回 `ok`,Web UI 在 `http://localhost:3000` 可访问

#### Scenario: 健康检查
- **WHEN** docker healthcheck 每 30s 调 `/api/v1/health`
- **THEN** 返回 `{ status, version, uptime, db, activeSessions }`,失败 3 次标记 unhealthy

## MODIFIED Requirements

### Requirement: 现有 MCP 工具对接持久化

原 MCP 工具 `list_servers` / `execute_command` / `upload` / `download` SHALL 改造为从 `servers` 表读连接信息,而不是从 CLI 启动参数一次性 parse。每次调用都需通过 RBAC 校验,通过后写 `audit_logs`。原有 `validateCommand` / `validateLocalPath` / `validateRemotePath` 逻辑 SHALL 保留并接入新数据源。

#### Scenario: execute_command 走 DB 配置
- **WHEN** 调 `execute_command` 时 `connectionName='prod-01'`
- **THEN** 从 `servers` 表读 prod-01 配置(含加密凭证),运行时解密,连接复用 `SSHConnectionPool`

#### Scenario: 命令未在白名单
- **WHEN** 命令不在 `servers.command_whitelist` 中
- **THEN** 拒绝执行,返回 `COMMAND_VALIDATION_FAILED`,审计 `status='denied'`

### Requirement: 启动方式

`index.ts` SHALL 启动双服务:HTTP server(含 REST API + Web UI 静态托管) + stdio MCP transport。CLI 参数 `--enable-web` 显式开启 HTTP(默认开启),`--api-key` 注入 Agent 身份。

#### Scenario: 默认启动
- **WHEN** `node build/index.js` 无参数启动
- **THEN** MCP stdio 启动 + HTTP 监听 3000 端口,Web UI 可访问

#### Scenario: 只跑 MCP
- **WHEN** 传 `--mcp-only` 参数
- **THEN** HTTP 不启动,只 stdio MCP

## REMOVED Requirements

### Requirement: 旧 CLI 参数一次性配置

**Reason**: 现 `CommandLineParser` 启动时一次性解析所有 SSH 配置到内存的设计,无法支持多用户、热更新、动态 CRUD。改造后,server 配置 SHALL 全部来自 `servers` 表,启动参数只保留:API key(Agent 鉴权)、HTTP 端口、DB 路径、加密密钥、是否启用 web 等**运行级**配置。

**Migration**: 启动时若 `servers` 表为空,提示"首次启动请通过 Web UI 或 CLI 创建服务器";若提供 `--import-config <legacy-cli-args-file>`,将旧 CLI 配置导入 `servers` 表后启动。

### Requirement: 单例 SSHConnectionManager

**Reason**: 原 `SSHConnectionManager` 是单例,所有 operator 共享连接池,无法实现人和 Agent 的并发隔离,也无法做 server 级权限校验。

**Migration**: 拆分为 `SSHConnectionPool`(技术层,纯 Client 管理)+ `SSHSessionService`(业务层,映射 operator+server 到 pool 中的 Client)。原 `executeCommand` / `upload` / `download` 公共方法的签名 SHALL 保持不变(传 `connectionName`),内部从单例访问改为通过 `SSHSessionService` 获取连接。
