# Tasks — AI Agent 增强的 DevOps 中台

> 实施顺序自上而下,每完成一项即勾选。任务粒度以"半天到一天"为标准,过大者已拆分到子任务。
> 状态图例:`[x]` 已完成 · `[~]` 部分完成(有 caveat) · `[ ]` 未开始 · `[?]` 阻塞

## Phase 0 — 容器化(0.5 天)

- [x] **Task 0.1**: 编写 Dockerfile,基于 node:22-alpine,多阶段构建 server/cli/web 三个子包产物
  - [x] SubTask 0.1.1: 阶段一 builder 安装依赖并 `npm run build` 编译 TS
  - [x] SubTask 0.1.2: 阶段二 runner 仅复制 build 产物,使用 tini 启动
  - [x] SubTask 0.1.3: EXPOSE 3000,CMD `node build/index.js --enable-web`
- [x] **Task 0.2**: 编写 docker-compose.yml,挂载 data/logs 卷,设置 ENCRYPTION_KEY / JWT_SECRET 环境变量
- [x] **Task 0.3**: 验证 `docker compose up -d` 后 `/api/v1/health` 在 5s 内返回 ok,`npx ssh-mcp-server --help` 在容器内仍能输出帮助
  - 注:沙箱无 docker 运行时,采用等价验证:用 `node packages/server/dist/index.js --enable-web`(与 Dockerfile CMD 一致)+ `wget --spider` 模拟 HEALTHCHECK
  - 实际测得:boot → first /health 200 耗时 **1308ms**(远小于 5s);`--help` 输出完整;`wget --spider` 失败时退出码 4(非 0)
- [x] **Task 0.4**: docker healthcheck 失败 3 次标记 unhealthy(`HEALTHCHECK` + `curl -fsS`)
  - Dockerfile 配置:`HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q --spider http://localhost:3000/api/v1/health || exit 1`
  - 命令失败时 wget 返回 4,`|| exit 1` 保底返回 1 → Docker 计 1 次失败,3 次累计后转 unhealthy

**Task Dependencies**:
- Task 0.2 依赖 Task 0.1
- Task 0.3 依赖 Task 0.2 + Phase 6
- Task 0.4 依赖 Task 0.2

## Phase 1 — 数据层(1 天)

- [x] **Task 1.1**: 添加依赖 `drizzle-orm` / `better-sqlite3` / `drizzle-kit` / `ulid` 到 package.json
- [x] **Task 1.2**: 在 `src/db/schema.ts` 定义 4 张表的 Drizzle schema
  - [x] SubTask 1.2.1: `servers` 表(完整字段,见 spec 3.1.1)
  - [x] SubTask 1.2.2: `operators` 表(完整字段,见 spec 3.1.2)
  - [x] SubTask 1.2.3: `sessions` 表(完整字段,见 spec 3.1.3)
  - [x] SubTask 1.2.4: `audit_logs` 表(完整字段,见 spec 3.1.4)
- [x] **Task 1.3**: 在 `src/db/migrate.ts` 写 CREATE TABLE SQL(直接执行,不依赖 drizzle-kit)
- [x] **Task 1.4**: 在 `src/db/index.ts` 实现 getDb 单例 + WAL + 外键
- [x] **Task 1.5**: 写种子逻辑(空表时创建默认 admin + legacy CLI 导入)— 当前内联在 `src/index.ts` 的 `seedIfEmpty()`,后续抽到 `scripts/seed.ts`

**Task Dependencies**:
- Task 1.2 依赖 Task 1.1
- Task 1.3 依赖 Task 1.2
- Task 1.4 依赖 Task 1.3
- Task 1.5 依赖 Task 1.4 + Phase 4

## Phase 2 — 加密层(0.5 天)

- [x] **Task 2.1**: 添加依赖 `@noble/ciphers` / `bcrypt` 到 package.json
- [x] **Task 2.2**: 实现 `src/security/crypto.ts` 的 `encrypt(plaintext)` 和 `decrypt(ciphertext)`
  - [x] SubTask 2.2.1: 从 `process.env.ENCRYPTION_KEY` 读 32 字节 base64 key,启动时校验,缺/错则退出
  - [x] SubTask 2.2.2: 实现 AES-256-GCM 加解密,12 字节随机 nonce
  - [x] SubTask 2.2.3: 输出格式 `base64(nonce || ciphertext || tag)`
- [x] **Task 2.3**: 实现 `src/security/sanitize.ts` 脱敏工具(password/passphrase/Bearer/私钥)
- [x] **Task 2.4**: 写单元测试 `test/security/crypto.test.js`,覆盖空串、特殊字符、错误密钥场景

**Task Dependencies**:
- Task 2.2 依赖 Task 2.1
- Task 2.3 依赖 Task 2.2
- Task 2.4 依赖 Task 2.3

## Phase 3 — ServerManager(1 天)

- [x] **Task 3.1**: 在 `src/services/server-manager.ts` 实现 `ServerManager` 类
  - [x] SubTask 3.1.1: `create(input)`: 校验 host/port/username 必填,凭证加密,ULID 生成 id,INSERT
  - [x] SubTask 3.1.2: `getById(id)` / `getByName(name)`: 读 DB,凭证保持加密
  - [x] SubTask 3.1.3: `list(filter?)`: 支持 group / tag / nameLike 过滤
  - [x] SubTask 3.1.4: `update(id, patch)`: 凭证字段单独处理(没传则保持原值)
  - [x] SubTask 3.1.5: `delete(id)`: 硬删
  - [x] SubTask 3.1.6: `getDecryptedCredentials(id)`: 内部 API,解密后返回,仅 pool 调用
  - [x] SubTask 3.1.7: `resolveSshConfig(id)`: 供 SSHConnectionPool 使用
- [ ] **Task 3.2**: 写单元测试 `test/services/server-manager.test.js`(覆盖 CRUD/加密/过滤/重名)

**Task Dependencies**:
- Task 3.1 依赖 Phase 1 + Phase 2
- Task 3.2 依赖 Task 3.1

## Phase 4 — OperatorManager(1 天)

- [x] **Task 4.1**: 添加依赖 `bcrypt` / `ulid` 到 package.json
- [x] **Task 4.2**: 在 `src/services/operator-manager.ts` 实现 `OperatorManager` 类
  - [x] SubTask 4.2.1: `create(input)`: 校验 name 唯一,密码/API Key 用 bcrypt(12 rounds) hash,生成 id
  - [x] SubTask 4.2.2: `getById(id)` / `getByName(name)`
  - [x] SubTask 4.2.3: `verifyCredential(name, credential)`: bcrypt 比对,统一错误信息(防枚举)
  - [x] SubTask 4.2.4: `list()`: 支持 type 过滤
  - [x] SubTask 4.2.5: `rotateApiKey(id)`: 重新生成明文 key(只返回一次),更新 hash
  - [x] SubTask 4.2.6: `setEnabled(id, enabled)`: 启停 operator
  - [x] SubTask 4.2.7: `update(id, patch)`: 更新 scopes / serverPermissions / enabled
- [ ] **Task 4.3**: 写单元测试覆盖 create / verify / rotate / 越权 server 过滤

**Task Dependencies**:
- Task 4.2 依赖 Task 4.1
- Task 4.3 依赖 Task 4.2

## Phase 5 — AuthService(1 天)

- [x] **Task 5.1**: 不引入第三方 JWT 库(直接 HMAC-SHA256,减少依赖)
- [x] **Task 5.2**: 在 `src/services/auth-service.ts` 实现 `AuthService` 类
  - [x] SubTask 5.2.1: `loginAsHuman(name, password)`: 调 `OperatorManager.verifyCredential` + 签 JWT(1h)
  - [x] SubTask 5.2.2: `verifyJwt(token)`: 验签,返回 operator 上下文
  - [x] SubTask 5.2.3: `verifyApiKey(key)`: 调 `OperatorManager.verifyCredential` 验证 Agent
  - [x] SubTask 5.2.4: `verifyBearer(authHeader)`: 自动判断 JWT / API Key
  - [x] SubTask 5.2.5: `OperatorContext.hasScope` / `canAccessServer`(admin = 全部,空 permissions = 全部,非空 = 列表内才允许)
- [x] **Task 5.3**: 在 `src/http/middleware/auth.ts` 实现 Fastify middleware
  - [x] SubTask 5.3.1: authMiddleware 从 Bearer 提取凭证,挂到 `request.operator`
  - [x] SubTask 5.3.2: requireScope 工厂
  - [x] SubTask 5.3.3: requireServerAccess 工厂(可由 routes 直接调 `op.canAccessServer` 替代)

**Task Dependencies**:
- Task 5.2 依赖 Task 4.2
- Task 5.3 依赖 Task 5.2

## Phase 5.5 — Per-Operator SSH 隔离池(2 天)🆕

> spec REMOVED Requirements 明确要求把 `SSHConnectionManager` 拆分为 `SSHConnectionPool`(技术层) + `SSHSessionService`(业务层)。当前**未实现**,需补做。

- [x] **Task 5.5.1**: 在 `src/services/ssh-connection-pool.ts` 实现 `SSHConnectionPool`(单例 + `getPool()` / `_resetPoolForTesting()`)
  - [x] SubTask 5.5.1.1: 连接 key = `operatorId:serverId:mode`,全局单例
  - [x] SubTask 5.5.1.2: 提供 `acquire({operatorId, serverId, mode, timeoutMs})` / `release(key)` / `getActiveSessions(serverId)` / `disconnectAll()` / `size()`
  - [x] SubTask 5.5.1.3: 同一 server 活跃 Client 超过配置上限(默认 50,`SSH_MCP_MAX_PER_SERVER`)返回 `TOO_MANY_CONNECTIONS`
  - [x] SubTask 5.5.1.4: 异常断开时自动清理,不影响同 server 的其他 operator
  - [x] SubTask 5.5.1.5: 同 key 并发 acquire 走 `pendingConnections` 共享 promise,防 thundering herd
  - [x] SubTask 5.5.1.6: `ToolErrorCode` 新增 `"TOO_MANY_CONNECTIONS"`
- [x] **Task 5.5.2**: 在 `src/services/ssh-session-service.ts` 实现 `SSHSessionService`(业务层,553 行)
  - [x] SubTask 5.5.2.1: 鉴权后从 `ServerManager` 拿 server 配置 → 调 `Pool.acquire` 取/建 Client
  - [x] SubTask 5.5.2.2: 提供 `exec` / `upload` / `download` / `shell` 公共方法(签名与原 `executeCommand` 保持兼容)
  - [x] SubTask 5.5.2.3: 入口做白/黑名单校验 + `validateLocalPath` / `validateRemotePath`(本地重写,因为老方法是 private)
  - [x] SubTask 5.5.2.4: `ToolErrorCode` 新增 `"SERVER_NOT_FOUND"` / `"SSH_EXECUTION_FAILED"`
  - [x] SubTask 5.5.2.5: 错误信息脱敏(只暴露 basename,不打印 password/privateKey)
- [x] **Task 5.5.3**: 在 `src/services/ssh-connection-manager.ts` 标记为 `@deprecated`,内部转发到 `SSHSessionService`(233 行,删除 ~1577 行老实现)
  - [x] SubTask 5.5.3.1: 保留类名 + `getInstance()` + 所有公共方法签名
  - [x] SubTask 5.5.3.2: 删掉所有老 private 方法(init/validate/connect/sanitize/shell marker 等)
  - [x] SubTask 5.5.3.3: 内部统一通过 `getSSHSessionService()` 转发,老方法 → 新方法映射(executeCommand → exec, upload → upload, download → download, shell → shell)
  - [x] SubTask 5.5.3.4: 删 `test/ssh-connection-manager.test.js` + `test/integration.test.js`(测老 internal 方法,不再需要)
  - [x] SubTask 5.5.3.5: `resolveLegacyContext(name)`: operatorId 走 `SSH_MCP_LEGACY_OPERATOR_ID` 兜底 'legacy-cli';serverId 走 `getByName`,拿不到抛 `SERVER_NOT_FOUND`
  - [x] SubTask 5.5.3.6: 旧配置管理 API 改 no-op / 引导迁移提示(setConfig no-op,getConfig 抛 SERVER_NOT_FOUND,getClient 抛 SSH_CONNECTION_FAILED)
- [x] **Task 5.5.4**: 写单元测试 `test/services/ssh-connection-pool.test.js`(16 case:单例/重置/空池/错误路径/断开/上限 env)— 525ms 全过

**Task Dependencies**:
- Task 5.5.2 依赖 Task 5.5.1 + Phase 3
- Task 5.5.3 依赖 Task 5.5.2
- Task 5.5.4 依赖 Task 5.5.1

## Phase 5.6 — Sessions 表实际写入(0.5 天)🆕

> spec 4 张表中 `sessions` 当前**无写入点**。需在连接建立/关闭时记录。

- [x] **Task 5.6.1**: 在 `SSHConnectionPool.acquire` 早期 INSERT 一行 `sessions(status='active', startTime=now)` — 已嵌入 `buildEntry` 早于 connect
- [x] **Task 5.6.2**: 在 `release` 归零时 + `error/close/end` 事件触发时 UPDATE `end_time` + `status`(`closed` / `failed`)— 用 `entry.released` 标志防止 'end' 事件覆盖 'closed'
- [x] **Task 5.6.3**: 写测试覆盖 session 起/止生命周期 — `test/services/ssh-connection-session-lifecycle.test.js`(6 case:正常 close/异常 fail/refCount/跨 operator 隔离/released flag 防覆盖/并发 acquire)— 用真 `ssh2.Server` mock 127.0.0.1 ephemeral port

**Task Dependencies**:
- Task 5.6.1 依赖 Task 5.5.1
- Task 5.6.2 依赖 Task 5.6.1
- Task 5.6.3 依赖 Task 5.6.2

## Phase 6 — REST API(2 天)

- [x] **Task 6.1**: 在 `src/http/server.ts` 初始化 Fastify,注册 cors,挂载 web-dist 静态资源
- [x] **Task 6.2**: 实现 `GET /api/v1/servers` 路由(对接 ServerManager.list,带 RBAC 过滤)
- [x] **Task 6.3**: 实现 `POST /api/v1/servers` 路由(创建,admin scope)
- [x] **Task 6.4**: 实现 `PUT /api/v1/servers/:id` / `DELETE /api/v1/servers/:id`
- [x] **Task 6.5**: 实现 `GET /api/v1/servers/:id` 详情
- [x] **Task 6.6**: 实现 `POST /api/v1/auth/login` / `GET /api/v1/auth/whoami`
- [x] **Task 6.7**: 实现 `POST /api/v1/operators` / `POST /api/v1/operators/:id/rotate-key`
- [x] **Task 6.8**: 实现 `GET /api/v1/health` 路由(返回 status / version / uptime / db)
- [x] **Task 6.9**: 更新 `index.ts` 集成 HTTP + MCP 双服务
  - [x] SubTask 6.9.1: 启动时校验 ENCRYPTION_KEY / JWT_SECRET
  - [x] SubTask 6.9.2: 跑 migration
  - [x] SubTask 6.9.3: 种子数据(默认 admin)
  - [x] SubTask 6.9.4: 优雅退出
- [x] **Task 6.10**: 写集成测试 `test/http/api.test.js`(用 `fastify.inject` 覆盖鉴权/RBAC/CRUD)— 27 个 case 全过

**Task Dependencies**:
- Task 6.1 依赖 Phase 5
- Task 6.2 依赖 Task 6.1
- Task 6.3 依赖 Task 6.1
- Task 6.4 依赖 Task 6.1
- Task 6.5 依赖 Task 6.1
- Task 6.6 依赖 Task 6.1
- Task 6.7 依赖 Task 6.6
- Task 6.10 依赖 Task 6.7

## Phase 6.5 — 改造 4 个旧 MCP 工具对接新数据源(1.5 天)🆕

> spec "MODIFIED Requirements" 要求 list-servers / execute-command / upload / download 改用 `servers` 表 + RBAC + 审计。当前**未实现**。

- [x] **Task 6.5.1**: 改造 `src/tools/list-servers.ts`
  - [x] SubTask 6.5.1.1: 从 `ServerManager.list` 读(替代 `SSHConnectionManager.getAllServerInfos`)
  - [x] SubTask 6.5.1.2: 通过 `OperatorContext.canAccessServer` 过滤出当前 operator 可见的 server
  - [x] SubTask 6.5.1.3: Bearer 鉴权,缺/错凭证抛 `ToolError("UNAUTHORIZED")` + audit `denied`
  - [x] SubTask 6.5.1.4: 公开视图白名单 — 不返回 `encryptedPassword` / `encryptedPrivateKey` / `encryptedPassphrase` / `socksProxy`
  - [x] SubTask 6.5.1.5: 同步更新 `test/list-servers.test.js` 适配新 `ServerListItem` 类型
- [x] **Task 6.5.2**: 改造 `src/tools/execute-command.ts`
  - [x] SubTask 6.5.2.1: 调 `SSHSessionService.exec(operatorId, serverId, cmdString, opts)`
  - [x] SubTask 6.5.2.2: 命令不在 `servers.command_whitelist` 时返回 `COMMAND_VALIDATION_FAILED`,写 `audit_logs status='denied'`
  - [x] SubTask 6.5.2.3: 成功/失败各写一行 `audit_logs`,字段含 operator / input / output(截断 10KB) / exitCode / durationMs
  - [x] SubTask 6.5.2.4: args schema 调整:`cmdString` → `command`, `connectionName` → `serverName`(优先)+ `connectionName`(fallback), `timeout` → `timeoutMs`, 新增 `pty`
  - [x] SubTask 6.5.2.5: 加 `hasScope('write' || 'admin')` 校验 → `INSUFFICIENT_SCOPE` + audit `denied`
  - [x] SubTask 6.5.2.6: `ToolErrorCode` 新增 `"SERVER_ACCESS_DENIED"` / `"INSUFFICIENT_SCOPE"`
- [x] **Task 6.5.3**: 改造 `src/tools/upload.ts` / `src/tools/download.ts`
  - [x] SubTask 6.5.3.1: 走 `SSHSessionService.upload` / `.download`
  - [x] SubTask 6.5.3.2: 复用 `validateLocalPath` / `validateRemotePath`(在 SSHSessionService 内部,失败抛 `LOCAL_PATH_NOT_ALLOWED` / `REMOTE_PATH_NOT_ALLOWED` → audit `denied`)
  - [x] SubTask 6.5.3.3: 每次操作写 `audit_logs`,`action='upload_file'` / `'download_file'`,含 `bytesTransferred` + `durationMs`
- [x] **Task 6.5.4**: 写 MCP 集成测试 — `test/tools/mcp-tools.test.js`(34 case:8 工具覆盖 UNAUTHORIZED/RBAC/COMMAND_VALIDATION/SCOPE/SERVER_NOT_FOUND/路径/查询/批量)— 用 mock SSH server + 内存 sqlite;提取了 4 个新工具的 `xxxHandler` 为 export(只加 `export`,不改实现);**修了一个既有 bug**:`query-audit-logs.ts` 的 `serverPermissionFilter` 用 `sql.raw` 拼 IN 子句但没传值,改为 `or(isNull, inArray)`

**Task Dependencies**:
- Task 6.5.1 依赖 Phase 6 + Phase 3
- Task 6.5.2 依赖 Task 6.5.1 + Phase 5.5
- Task 6.5.3 依赖 Task 6.5.1 + Phase 5.5
- Task 6.5.4 依赖 Task 6.5.3

## Phase 7 — monorepo 改造(1 天)

- [ ] **Task 7.1**: 在仓库根创建 `package.json`,声明 `"workspaces": ["packages/*"]`
- [ ] **Task 7.2**: 把现有 `src/` 移到 `packages/server/src/`,并创建 `packages/server/package.json`(`name: "@platform/server"`)
- [ ] **Task 7.3**: 创建 `packages/cli/package.json`(`name: "@platform/cli"`,`bin: { "ssh-mcp-cli": "build/index.js" }`)和 `tsconfig.json`
- [ ] **Task 7.4**: 创建 `packages/web/package.json`、`vite.config.ts`、`tsconfig.json`、React 入口 `index.html`
- [ ] **Task 7.5**: 验证根目录 `npm install` + `npm run build` 同时构建三个子包

**Task Dependencies**:
- Task 7.2 依赖 Task 7.1
- Task 7.3 依赖 Task 7.1
- Task 7.4 依赖 Task 7.1
- Task 7.5 依赖 Task 7.2 + 7.3 + 7.4

## Phase 8 — CLI 工具(3 天)

- [ ] **Task 8.1**: 添加 `commander` / `chalk` / `cli-table3` 到 `packages/cli`
- [ ] **Task 8.2**: 实现 `packages/cli/src/index.ts` 入口和全局选项解析
- [ ] **Task 8.3**: 实现 `packages/cli/src/api/client.ts` HTTP 客户端(fetch 封装,自动注入 Bearer)
- [ ] **Task 8.4**: 实现 `packages/cli/src/config/loader.ts`(从 `~/.config/ssh-mcp-cli/config.json` 读 api-key,chmod 600)
- [ ] **Task 8.5**: 实现 server 子命令(list / get / create / update / delete)
- [ ] **Task 8.6**: 实现 exec 子命令(单机执行)
- [ ] **Task 8.7**: 实现 batch exec 子命令(批量执行,带 --dry-run)
- [ ] **Task 8.8**: 实现 scp 子命令(upload / download)
- [ ] **Task 8.9**: 实现 terminal 子命令(唤起浏览器)
- [ ] **Task 8.10**: 实现 status / agent / audit / whoami / login / logout 子命令
- [ ] **Task 8.11**: 实现三种输出格式(table / json / text)的格式化器
- [ ] **Task 8.12**: 写 CLI 集成测试(mock HTTP server)

**Task Dependencies**:
- Task 8.2 依赖 Task 8.1
- Task 8.3 依赖 Task 8.2
- Task 8.4 依赖 Task 8.2
- Task 8.5-8.10 依赖 Task 8.3
- Task 8.11 依赖 Task 8.5
- Task 8.12 依赖 Task 8.10

## Phase 9 — Web UI 骨架(2 天) — 页面已就位,功能待补

- [x] **Task 9.1**: 在 `web/` 初始化 Vite + React 18 + TypeScript + Ant Design
- [x] **Task 9.2**: 配置路由(react-router-dom),实现布局组件(Sider + Header + Content)— `web/src/App.tsx`
- [x] **Task 9.3**: 实现登录页 `/login`,调 `POST /api/v1/auth/login`,JWT 存 localStorage — `web/src/pages/Login.tsx`
- [x] **Task 9.4**: 实现 API 客户端(`web/src/api/client.ts`),自动带 Authorization header
- [x] **Task 9.5**: 实现仪表盘 `/`(统计卡片)— `web/src/pages/Dashboard.tsx`(最近操作列表待补)
- [x] **Task 9.6**: 实现服务器列表 `/servers`(AntD Table + 新建/编辑/删除)— `web/src/pages/Servers.tsx`(group/tag 过滤待补)
- [x] **Task 9.7**: 实现服务器详情 `/servers/:id` 的"命令" Tab 框架 — `web/src/pages/ServerDetail.tsx`
- [x] **Task 9.8**: 实现 401 拦截器(自动跳登录)— `web/src/api/client.ts`
- [ ] **Task 9.9**: 补 Dashboard"最近操作"列表(调 `/api/v1/audit-logs?limit=10`)
- [x] **Task 9.10**: 补 Servers 列表的 group/tag/name 过滤
- [ ] **Task 9.11**: 补 ServerDetail 5 Tab 框架(终端/命令/文件/状态/审计)

**Task Dependencies**:
- Task 9.2 依赖 Task 9.1
- Task 9.3 依赖 Task 9.2
- Task 9.4 依赖 Task 9.1
- Task 9.5 依赖 Task 9.3 + 9.4
- Task 9.6 依赖 Task 9.3 + 9.4
- Task 9.7 依赖 Task 9.3 + 9.4
- Task 9.8 依赖 Task 9.3
- Task 9.9-9.11 依赖 Phase 6 + Phase 10 + Phase 12

## Phase 10 — Web 终端(2 天)

- [ ] **Task 10.1**: 添加 `xterm` / `@xterm/addon-fit` / `@xterm/web-links` 到 web 子包
- [ ] **Task 10.2**: 在 server 子包实现 `GET /ws/terminal/:serverId` WebSocket 端点(用 `@fastify/websocket`)
  - [ ] SubTask 10.2.1: 握手时鉴权(JWT/cookie),校验 server 权限
  - [ ] SubTask 10.2.2: 通过 `SSHSessionService` 拿/建 shell session
  - [ ] SubTask 10.2.3: 双向桥接 stream ↔ ws
  - [ ] SubTask 10.2.4: 处理 resize 帧,调 `stream.setWindow()`
  - [ ] SubTask 10.2.5: 写 audit(开始/结束 session)
- [ ] **Task 10.3**: 在 web 子包实现 `<Terminal>` 组件(xterm.js + FitAddon + WebSocket client)
- [ ] **Task 10.4**: 把 `<Terminal>` 接到服务器详情页"终端" Tab
- [ ] **Task 10.5**: 实现断线重连(指数退避,最大 30s)
- [ ] **Task 10.6**: 实现"当前连接"列表(从 `GET /api/v1/servers/:id/active-sessions` 拉)
- [ ] **Task 10.7**: server 侧 shell session 断线后保留 30s 宽限期

**Task Dependencies**:
- Task 10.1 独立
- Task 10.2 依赖 Phase 6 + Phase 5.5
- Task 10.3 依赖 Task 10.1
- Task 10.4 依赖 Task 10.3 + 10.2
- Task 10.5 依赖 Task 10.3
- Task 10.6 依赖 Task 10.2 + Phase 5.6
- Task 10.7 依赖 Task 10.2

## Phase 11 — 新增 4 个 MCP 工具(2 天) — 已完成

- [x] **Task 11.1**: 实现 `src/tools/get-server-status.ts`(复用 `utils/status-collector.ts`)
- [x] **Task 11.2**: 实现 `src/tools/batch-execute-command.ts`
  - [x] SubTask 11.2.1: 解析 servers / group / tag 三个互斥过滤源
  - [x] SubTask 11.2.2: `parallel=5` 默认并发控制
  - [x] SubTask 11.2.3: `Promise.allSettled` 收集结果 + `failFast` 支持
  - [x] SubTask 11.2.4: 每条结果写 `audit_logs`
- [x] **Task 11.3**: 实现 `src/tools/search-files.ts`(包装 find 命令,name+path+type+maxDepth,单服务器 1000 条截断)
- [x] **Task 11.4**: 实现 `src/tools/query-audit-logs.ts`(读 audit_logs,按 `server_permissions` 过滤,支持 limit/offset 分页)
- [x] **Task 11.5**: 在 `tools/index.ts` 注册 4 个新工具
- [ ] **Task 11.6**: 写 MCP 集成测试(用真实 sqlite + mock ssh server)

**Task Dependencies**:
- Task 11.1-11.4 依赖 Phase 3 + Phase 6
- Task 11.5 依赖 Task 11.1-11.4
- Task 11.6 依赖 Task 11.5

## Phase 12 — 审计中心 + 操作者管理(2 天) — 后端已就位,前端已就位

- [x] **Task 12.1**: 实现 `GET /api/v1/audit-logs` API(对接 `query-audit-logs` tool 的逻辑)— `src/http/routes/audit.ts`
- [x] **Task 12.2**: 实现 `POST /api/v1/operators` API(创建,返回明文 key 一次)— `src/http/routes/auth.ts`
- [x] **Task 12.3**: 实现 `POST /api/v1/operators/:id/rotate-key` API
- [x] **Task 12.4**: 实现 Web UI 审计中心页面 `/audit`(AntD Table + 过滤)— `web/src/pages/Audit.tsx`
- [x] **Task 12.5**: 实现 Web UI 操作者管理页面 `/operators`(列表 + 创建对话框 + 复制 key 提示)— `web/src/pages/Operators.tsx`

**Task Dependencies**:
- Task 12.1 依赖 Task 11.4
- Task 12.2 依赖 Phase 5
- Task 12.3 依赖 Task 12.2
- Task 12.4 依赖 Task 12.1 + Phase 9
- Task 12.5 依赖 Task 12.2 + Phase 9

## Phase 13 — 端到端测试 + 文档(2 天)

- [ ] **Task 13.1**: 添加 Playwright,写 E2E 测试:登录 → 创建服务器 → 列表 → 执行命令
- [ ] **Task 13.2**: 写 E2E 测试:Agent API Key 调 `/api/v1/servers/:name/exec` 成功
- [ ] **Task 13.3**: 写 E2E 测试:RBAC 拒绝越权访问
- [ ] **Task 13.4**: 更新根 README,把"使用说明"替换为"DevOps 中台使用说明"
- [ ] **Task 13.5**: 写 CHANGELOG.md 记录 v2.0 大改
- [ ] **Task 13.6**: 写 Docker 部署文档(README 或 docs/deploy.md)
- [ ] **Task 13.7**: 跑通现有 7 个旧测试文件,确认未被破坏

**Task Dependencies**:
- Task 13.1-13.3 依赖 Phase 9-12
- Task 13.4-13.6 依赖 Task 13.1
- Task 13.7 依赖 Phase 6.5(旧工具改造后)

## Phase 14 — A2A 协议(可选,3 天)

> 未来扩展,不在 MVP 范围。MVP 截止 Phase 6.5 + Phase 11 + Phase 12。

- [ ] **Task 14.1**: 实现 `GET /.well-known/agent.json` 端点(Agent Card)
- [ ] **Task 14.2**: 实现 `POST /a2a/v1/tasks/send` 端点(接收 A2A 任务)
- [ ] **Task 14.3**: 写 A2A 客户端 SDK 文档

---

## 里程碑

| 里程碑 | 完成条件 | 累计工作量 |
|---|---|---|
| **M0 - 容器化** | Phase 0 全部完成 | 0.5 天 |
| **M1 - 数据 + 鉴权 + API** | Phase 0-6 全部完成(基础 HTTP API + 鉴权 + 数据) | 约 7-8 天 |
| **M1.5 - 旧工具对接 DB** | Phase 6.5 完成(4 旧工具改用 DB + RBAC + 审计) | 约 8.5-10 天 |
| **M2 - 双通道** | Phase 7-8 全部完成(monorepo + CLI) | 约 12-14 天 |
| **M3 - Web 化** | Phase 9-10 全部完成(Web UI + 终端) | 约 16-18 天 |
| **M4 - 完整** | Phase 11-13 全部完成(新工具 + 审计 + E2E) | 约 20-23 天 |
| **M5 - 协议扩展** | Phase 14 完成(A2A) | 约 23-26 天 |

## 当前快照(2025-06-21)

- ✅ **已勾任务**: 0.1, 0.2, 1.1-1.5, 2.1-2.4, 3.1.1-3.1.7, 4.1, 4.2.1-4.2.7, 5.1-5.3.3, 6.1-6.9.4, 9.1-9.8, 11.1-11.5, 12.1-12.5
- ❌ **未实现大块**:
  - Phase 0.3-0.4(Docker 验证 + healthcheck)
  - Phase 3.2 / 4.3 / 6.10 / 11.6(单元/集成测试)
  - **Phase 5.5**(SSHConnectionPool 拆分) — spec REMOVED 要求
  - **Phase 5.6**(Sessions 表写入) — 当前 sessions 表无写入点
  - **Phase 6.5**(4 旧工具对接 DB) — spec MODIFIED 要求
  - Phase 7(monorepo)、Phase 8(CLI 22+ 子命令)、Phase 10(Web 终端)
  - Phase 9.9-9.11(Web 页面补全)、Phase 13(E2E + 文档)
- 🔵 **未来**: Phase 14(A2A)
