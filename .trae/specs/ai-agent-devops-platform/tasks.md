# Tasks — AI Agent 增强的 DevOps 中台

> 实施顺序自上而下,每完成一项即勾选。任务粒度以"半天到一天"为标准,过大者已拆分到子任务。

## Phase 0 — 容器化(0.5 天)

- [x] **Task 0.1**: 编写 Dockerfile,基于 node:22-alpine,多阶段构建 server/cli/web 三个子包产物
  - [x] SubTask 0.1.1: 阶段一 builder 安装依赖并 `npm run build -w @platform/server` 等
  - [x] SubTask 0.1.2: 阶段二 runner 仅复制 build 产物,使用 tini 启动
  - [x] SubTask 0.1.3: EXPOSE 3000,CMD `node build/index.js --enable-web`
- [x] **Task 0.2**: 编写 docker-compose.yml,挂载 data/logs 卷,设置 ENCRYPTION_KEY / JWT_SECRET 环境变量
- [ ] **Task 0.3**: 验证 `docker compose up -d` 后 `npx ssh-mcp-server --help` 在容器内仍能输出帮助(待 Phase 1-6 完成后端点后验证)

**Task Dependencies**:
- Task 0.2 依赖 Task 0.1
- Task 0.3 依赖 Task 0.2

## Phase 1 — 数据层(1 天)

- [x] **Task 1.1**: 添加依赖 `drizzle-orm` / `better-sqlite3` / `drizzle-kit` / `ulid` 到 package.json
- [x] **Task 1.2**: 在 `src/db/schema.ts` 定义 4 张表的 Drizzle schema
  - [x] SubTask 1.2.1: `servers` 表(完整字段,见 spec 3.1.1)
  - [x] SubTask 1.2.2: `operators` 表(完整字段,见 spec 3.1.2)
  - [x] SubTask 1.2.3: `sessions` 表(完整字段,见 spec 3.1.3)
  - [x] SubTask 1.2.4: `audit_logs` 表(完整字段,见 spec 3.1.4)
- [x] **Task 1.3**: 在 `src/db/migrate.ts` 写 CREATE TABLE SQL(直接执行,不依赖 drizzle-kit)
- [x] **Task 1.4**: 在 `src/db/index.ts` 实现 getDb 单例 + WAL + 外键
- [ ] **Task 1.5**: 写 seed 脚本(待 Phase 4 后,因为需要 OperatorManager)

**Task Dependencies**:
- Task 1.2 依赖 Task 1.1
- Task 1.3 依赖 Task 1.2
- Task 1.4 依赖 Task 1.3
- Task 1.5 依赖 Task 1.4

## Phase 2 — 加密层(0.5 天)

- [x] **Task 2.1**: 添加依赖 `@noble/ciphers` / `bcrypt` 到 package.json
- [x] **Task 2.2**: 实现 `src/security/crypto.ts` 的 `encrypt(plaintext)` 和 `decrypt(ciphertext)`
  - [x] SubTask 2.2.1: 从 `process.env.ENCRYPTION_KEY` 读 32 字节 base64 key,启动时校验,缺/错则退出
  - [x] SubTask 2.2.2: 实现 AES-256-GCM 加解密,12 字节随机 nonce
  - [x] SubTask 2.2.3: 输出格式 `base64(nonce || ciphertext)`
- [x] **Task 2.3**: 实现 `src/security/sanitize.ts` 脱敏工具(password/passphrase/Bearer/私钥)
- [x] **Task 2.4**: 写单元测试 `test/security/crypto.test.js`,覆盖空串、特殊字符、错误密钥场景

**Task Dependencies**:
- Task 2.2 依赖 Task 2.1
- Task 2.3 依赖 Task 2.2

## Phase 3 — ServerManager(1 天)

- [x] **Task 3.1**: 在 `src/services/server-manager.ts` 实现 `ServerManager` 类
  - [x] SubTask 3.1.1: `create(input)`: 校验 host/port/username 必填,凭证加密,ULID 生成 id,INSERT
  - [x] SubTask 3.1.2: `getById(id)` / `getByName(name)`: 读 DB,凭证保持加密
  - [x] SubTask 3.1.3: `list(filter?)`: 支持 group / tag / nameLike 过滤
  - [x] SubTask 3.1.4: `update(id, patch)`: 凭证字段单独处理(没传则保持原值)
  - [x] SubTask 3.1.5: `delete(id)`: 硬删
  - [x] SubTask 3.1.6: `getDecryptedCredentials(id)`: 内部 API,解密后返回,仅 pool 调用
  - [x] SubTask 3.1.7: `resolveSshConfig(id)`: 供 SSHConnectionPool 使用
- [ ] **Task 3.2**: 写单元测试 `test/services/server-manager.test.js`(待 Phase 验证阶段补)

**Task Dependencies**:
- Task 3.1 依赖 Phase 1 + Phase 2

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
- [ ] **Task 4.3**: 写单元测试覆盖 create / verify / rotate(待 Phase 验证阶段补)

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
  - [x] SubTask 5.2.5: `OperatorContext.hasScope` / `canAccessServer`
- [x] **Task 5.3**: 在 `src/http/middleware/auth.ts` 实现 Fastify middleware
  - [x] SubTask 5.3.1: authMiddleware 从 Bearer 提取凭证,挂到 `request.operator`
  - [x] SubTask 5.3.2: requireScope 工厂
  - [x] SubTask 5.3.3: requireServerAccess 工厂
- [x] **Task 5.4**: `requireScope` / `requireServerAccess` RBAC middleware 已在 auth.ts 内实现

**Task Dependencies**:
- Task 5.2 依赖 Task 4.2
- Task 5.3 依赖 Task 5.2
- Task 5.4 依赖 Task 5.3

## Phase 6 — REST API(2 天)

- [x] **Task 6.1**: 在 `src/http/server.ts` 初始化 Fastify,注册 cors
- [x] **Task 6.2**: 实现 `GET /api/v1/servers` 路由(对接 ServerManager.list,带 RBAC 过滤)
- [x] **Task 6.3**: 实现 `POST /api/v1/servers` 路由(创建,admin scope)
- [x] **Task 6.4**: 实现 `PUT /api/v1/servers/:id` / `DELETE /api/v1/servers/:id`
- [x] **Task 6.5**: 实现 `GET /api/v1/servers/:id` 详情
- [x] **Task 6.6**: 实现 `POST /api/v1/auth/login` / `GET /api/v1/auth/whoami`
- [x] **Task 6.7**: 实现 `POST /api/v1/operators` / `POST /api/v1/operators/:id/rotate-key`
- [x] **Task 6.8**: 实现 `GET /api/v1/health` 路由(返回 status / version / uptime / db)
- [x] **Task 6.9**: 更新 `index.ts` 集成 HTTP + MCP 双服务
  - 启动时校验 ENCRYPTION_KEY / JWT_SECRET
  - 跑 migration
  - 种子数据(默认 admin)
  - 优雅退出
- [ ] **Task 6.10**: 写集成测试 `test/http/api.test.js`(待 Phase 验证阶段补)

**Task Dependencies**:
- Task 6.1 依赖 Phase 5
- Task 6.2 依赖 Task 6.1
- Task 6.3 依赖 Task 6.1
- Task 6.4 依赖 Task 6.1
- Task 6.5 依赖 Task 6.1
- Task 6.6 依赖 Task 6.1
- Task 6.7 依赖 Task 6.6

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

## Phase 9 — Web UI 骨架(2 天)

- [ ] **Task 9.1**: 在 `packages/web/` 初始化 Vite + React 18 + TypeScript + Ant Design
- [ ] **Task 9.2**: 配置路由(react-router-dom),实现布局组件(Sider + Header + Content)
- [ ] **Task 9.3**: 实现登录页 `/login`,调 `POST /api/v1/auth/login`,JWT 存 localStorage
- [ ] **Task 9.4**: 实现 API 客户端(`packages/web/src/api/client.ts`),自动带 Authorization header
- [ ] **Task 9.5**: 实现仪表盘 `/`(统计卡片 + 最近操作列表)
- [ ] **Task 9.6**: 实现服务器列表 `/servers`(AntD Table + 过滤 + 新建/编辑/删除按钮)
- [ ] **Task 9.7**: 实现服务器详情 `/servers/:id` 的"命令" Tab(简单命令面板)
- [ ] **Task 9.8**: 实现 401 拦截器(自动跳登录)

**Task Dependencies**:
- Task 9.2 依赖 Task 9.1
- Task 9.3 依赖 Task 9.2
- Task 9.4 依赖 Task 9.1
- Task 9.5-9.7 依赖 Task 9.3 + 9.4
- Task 9.8 依赖 Task 9.3

## Phase 10 — Web 终端(2 天)

- [ ] **Task 10.1**: 添加 `xterm` / `@xterm/addon-fit` 到 web 子包
- [ ] **Task 10.2**: 在 server 子包实现 `GET /ws/terminal/:serverId` WebSocket 端点(用 `@fastify/websocket`)
  - [ ] SubTask 10.2.1: 握手时鉴权(JWT/cookie),校验 server 权限
  - [ ] SubTask 10.2.2: 通过 `SSHConnectionPool` 拿/建 shell session
  - [ ] SubTask 10.2.3: 双向桥接 stream ↔ ws
  - [ ] SubTask 10.2.4: 处理 resize 帧,调 `stream.setWindow()`
  - [ ] SubTask 10.2.5: 写 audit(开始/结束 session)
- [ ] **Task 10.3**: 在 web 子包实现 `<Terminal>` 组件(xterm.js + FitAddon + WebSocket client)
- [ ] **Task 10.4**: 把 `<Terminal>` 接到服务器详情页"终端" Tab
- [ ] **Task 10.5**: 实现断线重连(指数退避,最大 30s)
- [ ] **Task 10.6**: 实现"当前连接"列表(从 `GET /api/v1/servers/:id/active-sessions` 拉)

**Task Dependencies**:
- Task 10.2 依赖 Phase 6
- Task 10.3 依赖 Task 10.1
- Task 10.4 依赖 Task 10.3 + 10.2
- Task 10.5 依赖 Task 10.3
- Task 10.6 依赖 Phase 6

## Phase 11 — 新增 4 个 MCP 工具(2 天)

- [ ] **Task 11.1**: 实现 `packages/server/src/tools/get-server-status.ts`(复用 utils/status-collector.ts)
- [ ] **Task 11.2**: 实现 `packages/server/src/tools/batch-execute-command.ts`
  - [ ] SubTask 11.2.1: 解析 servers / group / tag 三个互斥过滤源
  - [ ] SubTask 11.2.2: 实现 Semaphore 控制并发
  - [ ] SubTask 11.2.3: `Promise.allSettled` 收集结果,`failFast` 支持
  - [ ] SubTask 11.2.4: 每条结果写 audit_log
- [ ] **Task 11.3**: 实现 `packages/server/src/tools/search-files.ts`(包装 find 命令)
- [ ] **Task 11.4**: 实现 `packages/server/src/tools/query-audit-logs.ts`(读 audit_logs,按 server_permissions 过滤)
- [ ] **Task 11.5**: 在 `tools/index.ts` 注册 4 个新工具
- [ ] **Task 11.6**: 写 MCP 集成测试(用真实 sqlite + mock ssh server)

**Task Dependencies**:
- Task 11.1-11.4 依赖 Phase 6
- Task 11.5 依赖 Task 11.1-11.4
- Task 11.6 依赖 Task 11.5

## Phase 12 — 审计中心 + 操作者管理(2 天)

- [ ] **Task 12.1**: 实现 `GET /api/v1/audit-logs` API(对接 query-audit-logs tool 的逻辑)
- [ ] **Task 12.2**: 实现 `POST /api/v1/operators` API(创建,返回明文 key 一次)
- [ ] **Task 12.3**: 实现 `POST /api/v1/operators/:id/rotate-key` API
- [ ] **Task 12.4**: 实现 Web UI 审计中心页面 `/audit`(AntD Table + 过滤)
- [ ] **Task 12.5**: 实现 Web UI 操作者管理页面 `/operators`(列表 + 创建对话框 + 复制 key 提示)

**Task Dependencies**:
- Task 12.1 依赖 Task 11.4
- Task 12.2 依赖 Phase 5
- Task 12.3 依赖 Task 12.2
- Task 12.4 依赖 Task 12.1
- Task 12.5 依赖 Task 12.2

## Phase 13 — 端到端测试 + 文档(2 天)

- [ ] **Task 13.1**: 添加 Playwright,写 E2E 测试:登录 → 创建服务器 → 列表 → 执行命令
- [ ] **Task 13.2**: 写 E2E 测试:Agent API Key 调 `/api/v1/servers/:name/exec` 成功
- [ ] **Task 13.3**: 写 E2E 测试:RBAC 拒绝越权访问
- [ ] **Task 13.4**: 更新根 README,把"使用说明"替换为"DevOps 中台使用说明"
- [ ] **Task 13.5**: 写 CHANGELOG.md 记录 v2.0 大改
- [ ] **Task 13.6**: 写 Docker 部署文档(README 或 docs/deploy.md)

**Task Dependencies**:
- Task 13.1-13.3 依赖 Phase 9-12
- Task 13.4-13.6 依赖 Task 13.1

## Phase 14 — A2A 协议(可选,3 天)

> 未来扩展,不在 MVP 范围。MVP 截止 Phase 6 + 部分 Phase 8(CLI 基础命令)。

- [ ] **Task 14.1**: 实现 `GET /.well-known/agent.json` 端点(Agent Card)
- [ ] **Task 14.2**: 实现 `POST /a2a/v1/tasks/send` 端点(接收 A2A 任务)
- [ ] **Task 14.3**: 写 A2A 客户端 SDK 文档

---

## 里程碑

| 里程碑 | 完成条件 | 累计工作量 |
|---|---|---|
| **M0 - 容器化** | Phase 0 全部完成 | 0.5 天 |
| **M1 - MVP** | Phase 0-6 全部完成(基础 HTTP API + 鉴权 + 数据) | 约 7-8 天 |
| **M2 - 双通道** | Phase 7-8 全部完成(monorepo + CLI) | 约 11-12 天 |
| **M3 - Web 化** | Phase 9-10 全部完成(Web UI + 终端) | 约 15-16 天 |
| **M4 - 完整** | Phase 11-13 全部完成(新工具 + 审计 + E2E) | 约 19-21 天 |
| **M5 - 协议扩展** | Phase 14 完成(A2A) | 约 22-24 天 |
