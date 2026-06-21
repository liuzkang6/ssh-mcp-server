# Contributing to opsgate

> 欢迎贡献 — 提 PR、报 Issue、写文档、做翻译都行。
> 本指南涵盖 dev setup、目录结构、代码风格、提交规范、提 PR 流程。

## 📋 目录

- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [代码风格](#代码风格)
- [提交规范](#提交规范)
- [Pull Request 流程](#pull-request-流程)
- [测试](#测试)
- [文档](#文档)
- [国际化](#国际化)
- [社区](#社区)

---

## 🚀 快速开始

### 前置要求

- **Node.js** ≥ 22
- **npm** ≥ 10(workspaces 需要)
- **Git** ≥ 2.30
- 推荐:**VS Code** + 官方 TS 插件

### Fork & Clone

```bash
# 1. 在 GitHub 上 fork https://github.com/liuzkang6/opsgate
# 2. 克隆你的 fork
git clone https://github.com/<you>/opsgate.git
cd opsgate
# 3. 加 upstream
git remote add upstream https://github.com/liuzkang6/opsgate.git
```

### 安装依赖

```bash
npm install
```

monorepo 模式,依赖会 hoist 到根 `node_modules`。

### Build

```bash
npm run build
# 顺序:server → cli → web
# 产物:packages/{server,cli}/dist/ + web-dist/
```

### Dev Mode(推荐)

```bash
# 启 server(支持热重载)
npm run dev:server

# 启 web(支持 HMR)
npm run dev:web
```

> 注意:CLI 不需要 dev 模式,改完直接 `node packages/cli/dist/index.js ...` 测。

### 跑测试

```bash
npm test                  # 全部
npm run test:watch        # watch 一个文件
```

---

## 🗂️ 目录结构

```
opsgate/
├── packages/                      # monorepo 子包
│   ├── server/                    # @opsgate/server — HTTP + MCP
│   │   ├── src/
│   │   │   ├── config/            # 启动配置
│   │   │   ├── crypto/            # AES-256-GCM
│   │   │   ├── db/                # Drizzle schema + migrate
│   │   │   ├── http/              # Fastify routes + middleware
│   │   │   ├── mcp/               # MCP tools
│   │   │   ├── services/          # 业务逻辑(无 HTTP 依赖)
│   │   │   ├── utils/             # 通用工具
│   │   │   └── index.ts           # 入口
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── cli/                       # @opsgate/cli
│   │   ├── src/
│   │   │   └── index.ts           # 25+ 子命令
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                       # @opsgate/web
│       ├── src/
│       │   ├── api/               # HTTP client
│       │   ├── components/
│       │   ├── pages/
│       │   ├── router.tsx
│       │   └── main.tsx
│       ├── vite.config.ts
│       └── package.json
├── scripts/                       # 构建/测试脚本
│   ├── build.js
│   └── run-tests.js
├── docs/                          # 文档(markdown)
│   ├── ARCHITECTURE.md
│   ├── CLI.md
│   ├── API.md
│   ├── MCP.md
│   ├── DEPLOY.md
│   └── SECURITY.md
├── test/                          # 单元 + 集成测试
│   └── *.test.js
├── skills/                        # Claude/Cursor skills
│   └── opsgate-helper/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json                   # root + workspaces
└── README.md / README_CN.md
```

### 模块边界原则

| 层 | 职责 | 不能依赖 |
|----|------|---------|
| `http/routes/*` | 解析 HTTP / 调 service | `mcp/` |
| `mcp/tools/*` | 解析 MCP / 调 service | `http/` |
| `services/*` | 业务逻辑 | `http/` `mcp/` |
| `db/*` | 数据访问 | `services/` `http/` `mcp/` |
| `crypto/*` | 加密工具 | 其他 |

> 简单说:`routes/mcp → services → db/crypto`,不能反向。

---

## 🎨 代码风格

### TypeScript

- **strict mode**(`"strict": true`)
- 不用 `any`,**严禁**用 `any` 绕过类型
- 公共 API 必须有返回类型
- 优先 `interface` 而非 `type alias`(可扩展)
- 文件名:`kebab-case.ts`
- 类名:`PascalCase`
- 函数/变量:`camelCase`
- 常量:`UPPER_SNAKE_CASE`

**例子**:
```ts
// ✅ 好
export interface ServerManager {
  create(input: CreateServerInput): Promise<Server>;
}

// ❌ 差
export function createServer(input: any) { ... }
```

### ESLint / Prettier

项目根有 `.eslintrc` / `.prettierrc`(如有),用 `npm run lint` / `npm run format`。

### 注释

- **公共 API**:JSDoc(`/** ... */`)
- **复杂逻辑**:行内注释解释 *为什么*,不是 *做什么*
- **不要**解释显而易见的代码
- 注释用**中文**或**英文**(统一即可,别混用)

### 错误处理

```ts
// ✅ 好
throw new HttpError(401, "UNAUTHORIZED", "Invalid credentials");

// ❌ 差
throw new Error("auth failed");
```

应用错误用统一 `HttpError`(带 `code` + `retriable`),让前端能识别。

### 日志

- 用 `console.log` / `console.error` + 结构化字段
- 不用第三方日志库(简单)
- 敏感信息(password / token)绝不打印

---

## 📝 提交规范

### Conventional Commits

```
<type>(<scope>): <subject>

<body>

<footer>
```

**type**:
- `feat`:新功能
- `fix`:Bug 修复
- `docs`:文档
- `style`:格式(无代码变更)
- `refactor`:重构
- `test`:测试
- `chore`:构建/工具/依赖

**scope**:
- `server` / `cli` / `web` / `docs` / `mcp` / `db` 等
- 或者具体子模块 `cli:login` `web:terminal`

**subject**:
- 中文或英文(项目主要中文,英文也行)
- ≤ 50 字符
- 不大写句号结尾

**body**(可选):
- 解释 *为什么*,不是 *做什么*
- 多行用 ` ` 续行

**footer**:
- `BREAKING CHANGE: <description>`(破坏性变更)
- `Ref: #123`(关联 issue)
- `🤖 Generated with [Claude Code]`
- `Co-Authored-By: <name> <email>`

### 例子

```
feat(cli): 加 opsgate agent get <name> 子命令

获取单个 operator 详情,补完 agent 子命令组。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
Co-Authored-By: Claude <noreply@anthropic.com>
```

```
fix(server): 修复 Web 终端 resize 后远端 stty 没更新

ResizeObserver 触发时没及时调 setWindow,
导致浏览器窗口改大后,远端实际还是旧 cols/rows。
```

```
docs(arch): 补 SSH 连接池状态图

用 mermaid 画 4 态转换图,加 30s 宽限期说明。
```

---

## 🔁 Pull Request 流程

### 1. 创建分支

```bash
git checkout -b feat/<short-desc>
# 或
git checkout -b fix/<short-desc>
```

### 2. 改代码 + 加测试

- 改完跑 `npm test`,确保 180+ 全过
- 新功能必须有测试覆盖
- 跑 `npm run lint`(如有)
- 跑 `npm run build`,确保产物能跑

### 3. 更新 spec(如适用)

如果改了 API/MCP 行为:
- 更新 `docs/API.md` / `docs/MCP.md`
- 更新 `.trae/specs/ai-agent-devops-platform/tasks.md`(勾掉对应 task)
- 如果是破坏性变更,加 `CHANGELOG.md` "Unreleased" 段

### 4. Commit

```bash
git add -p  # 仔细看 diff
git commit  # 走 Conventional Commits
```

### 5. Push & 开 PR

```bash
git push origin feat/<short-desc>
# 在 GitHub 上开 PR,关联 issue
```

**PR 描述**模板(可参考):
```markdown
## 改了什么
- 1.
- 2.

## 为什么
[解释背景、动机、相关 issue]

## 测试
- [x] 单元测试
- [x] 集成测试
- [x] 手动验证

## 截图 / 输出
[如有 UI 变更,贴截图;如 CLI 输出,贴 log]

## Checklist
- [x] `npm test` 通过
- [x] `npm run build` 通过
- [x] docs 同步更新
- [x] changelog 同步(若是 breaking)
```

### 6. Review & Merge

- 维护者会 review,可能要改几轮
- 改完 `git push`,PR 自动更新
- 合到 main 后,branch 可删

---

## 🧪 测试

### 测试文件位置

```
test/
├── api-*.test.js      # HTTP API 测试
├── mcp-*.test.js      # MCP 工具测试
├── cli-*.test.js      # CLI 解析测试
├── service-*.test.js  # 业务逻辑
└── utils-*.test.js
```

### 写测试

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("ServerManager.create encrypts password", async () => {
  const sm = new ServerManager({ ... });
  const server = await sm.create({ name: "x", host: "1.2.3.4", password: "secret" });
  
  // 断言:存到 DB 的不是明文
  const row = db.prepare("SELECT password_encrypted FROM servers WHERE id=?").get(server.id);
  assert.notEqual(row.password_encrypted, "secret");
  assert.match(row.password_encrypted, /::/);  // 加密格式
});
```

### Mock 原则

- **不要 mock 太多** — 走真实 SQLite,真实 ssh2(用本地 mock SSH server)
- **HTTP 测试**:起一个真 server(:随机端口),用 fetch 调
- **MCP 测试**:不通过 stdio,直接 import tool 函数调

### 等价验证

无 Docker 沙箱的 CI 跑:
- `node packages/server/dist/index.js --enable-web` 启 server
- `wget --spider` 模拟 healthcheck
- 起 1.3s 内 boot → 5s 阈值内通过

---

## 📚 文档

### 改什么要改文档

| 改 | 改哪 |
|----|------|
| 新增/改 HTTP 端点 | `docs/API.md` |
| 新增/改 MCP 工具 | `docs/MCP.md` |
| 新增/改 CLI 子命令 | `docs/CLI.md` |
| 改架构/数据流 | `docs/ARCHITECTURE.md` |
| 改环境变量/部署 | `docs/DEPLOY.md` |
| 改安全机制 | `docs/SECURITY.md` |
| 改快速开始 | `README.md` / `README_CN.md` |
| 改版本 | `CHANGELOG.md` |

### 文档风格

- 用 mermaid 画图(架构图、时序图、ER 图)
- 例多写,别空讲
- 中文和英文 README 同步更新
- 链接用相对路径(`[CLI](docs/CLI.md)`)

---

## 🌍 国际化

- 文档:中英双语维护
- Web UI:暂只支持中文(用 AntD 默认组件)
- CLI 消息:英文(跨平台)

### 翻译流程

1. 改 `README.md`(英文)
2. 同步改 `README_CN.md`(中文)
3. PR 里 @ reviewer 双语检查

---

## 💬 社区

- **GitHub Issues**:Bug 报告、功能请求
- **GitHub Discussions**:问答、想法、show & tell
- **PR**:代码贡献

### 行为准则

- 友善、包容、专业
- 对事不对人
- 接受建设性批评
- 关注社区最大利益

违反 → 维护者有权删除评论 / 关闭 PR。

---

## 🙏 致谢

感谢所有贡献者!你的名字会在 release notes 里出现。

---

## 下一步

- [README.md](README.md) — 项目总览
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构
- [docs/DEPLOY.md](docs/DEPLOY.md) — 部署
- [CHANGELOG.md](CHANGELOG.md) — 版本变更
