# Security Model

> opsgate 的安全设计 — 威胁模型、加密、鉴权、RBAC、审计、最佳实践。
> 适合安全工程师 / 架构师审查。

## 1. 威胁模型

### 我们防什么

| 威胁 | 描述 | 缓解措施 |
|------|------|---------|
| **凭证泄露** | SSH 密码 / 私钥从 DB 文件泄漏 | AES-256-GCM 落库 + 强校验 master key |
| **越权执行** | 某个 user/Agent 执行了不该执行的命令 | RBAC(`scopes` × `serverPermissions`) + `commandWhitelist/Blacklist` |
| **审计缺失** | 出事后无法追溯 | 100% 写 `audit_logs`,脱敏 + 截断 |
| **重放攻击** | JWT 被截获重放 | 1h 过期 + HTTPS(反代层) |
| **横向移动** | Agent 拿到某台机器后用它攻击别的 | `commandBlacklist` + 限定的 `serverPermissions` |
| **注入** | 命令注入 | SSH exec 走 `shell` + 参数化,不拼接 |
| **暴力破解** | admin 密码被猜 | bcrypt 12 rounds + 未来加 rate limit(2.1) |
| **备份泄漏** | DB 备份被拿走 | 备份是**加密**的(随 ENCRYPTION_KEY 加密),独立加密备份可加 |

### 我们**不**防什么(说明)

| 威胁 | 范围 | 备注 |
|------|------|------|
| **0day RCE** | 服务器 OS / SSH server / OpenSSL | 在 opsgate 之外,及时打补丁 |
| **内部恶意 admin** | 已有 admin 主动泄露 | opsgate 没有 anti-insider,这是任何 SaaS 的固有限制 |
| **物理访问 server** | 拿到物理机器 | 跟 SSH 协议本身有关 |
| **DDoS** | 大量请求打挂 opsgate | 部署在反代后,加 fail2ban;计划 2.1 加 rate limit |

---

## 2. 加密

### 2.1 凭证加密(AES-256-GCM)

**算法**:`AES-256-GCM`(Authenticated Encryption with Associated Data)

**Key 派生**:
```
KEY = base64Decode(process.env.ENCRYPTION_KEY)
```
- 解码后必须 ≥ 32 字节(启动时强校验)
- 启动失败如果 key 不合规

**IV 生成**:
- 每条数据加密用 **12 字节随机 IV**
- 来自 `crypto.randomBytes(12)`
- 永不重用

**密文格式**:
```
base64(IV) + "::" + base64(CIPHERTEXT) + "::" + base64(AUTH_TAG)
```
存到 DB 的 `password_encrypted` / `private_key_encrypted` / `passphrase_encrypted` 列。

**为什么 GCM?**
- 12 字节 IV 是 GCM 的最优大小
- Auth Tag 16 字节,防 ciphertext 被篡改
- 每次独立 IV → 即使同一明文加密两次,密文也不同
- 性能:node `crypto` 模块原生,无第三方依赖

**Key 轮换**:
- v2.0 **不支持热轮换**(改 ENCRYPTION_KEY 后需重加密全 DB)
- 计划 v2.1 引入版本化密文格式(`v2:base64(iv)::...`)

### 2.2 密码 hash(bcrypt)

**算法**:`bcrypt` cost 12

**用途**:operator 登录密码

**存储**:`operators.password_hash`

**为什么不存明文?**
- 即使 opsgate 内部被入侵,DB 泄漏也拿不到原始密码

### 2.3 API Key

**生成**:`crypto.randomBytes(32).toString('base64url')` = 43 字符,前缀 `sk-`

**存储**:`bcrypt(apiKey)`(跟密码同等强度)

**为什么 hash?**
- 创建/轮换时只明文返回一次
- 即使 DB 泄漏,API Key 仍需暴力破解

### 2.4 JWT

**算法**:HS256(对称 HMAC)

**Secret**:`process.env.JWT_SECRET`(任意长字符串)

**Payload**:
```json
{
  "sub": "op-1",
  "name": "admin",
  "scopes": ["admin"],
  "type": "human",
  "iat": 1719000000,
  "exp": 1719003600
}
```

**过期**:1 小时(无 refresh token,需要重登录)

**安全考虑**:
- HS256 而不是 RS256 — 单服务自签,简化部署;若要多服务验证切 RS256
- 建议反代层强制 HTTPS,避免 token 在网络层泄漏
- 不存敏感信息在 payload(只放 ID + scope)

---

## 3. 鉴权

### 3.1 两种身份

| 身份 | 凭证 | 用途 | 存储 |
|------|------|------|------|
| **人** | JWT | Web UI / CLI 登录 | 无状态(每次验签) |
| **AI Agent** | API Key (`sk-...`) | MCP / 自动化 | bcrypt 哈希 |

### 3.2 `verifyBearer` 统一中间件

```ts
async function verifyBearer(req, reply) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    throw httpError(401, "UNAUTHORIZED");
  }
  const token = auth.slice(7);
  if (token.startsWith("sk-")) {
    // API Key
    const op = await operatorManager.findByApiKey(token);
    if (!op) throw httpError(401, "UNAUTHORIZED");
    req.operator = op;
  } else {
    // JWT
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const op = await operatorManager.getById(payload.sub);
    if (!op || op.disabled) throw httpError(401, "UNAUTHORIZED");
    req.operator = { ...op, scopes: payload.scopes };
  }
}
```

### 3.3 401 处理

- **Web UI**:客户端拦截器收 401 → 清 localStorage + 跳 `/login`
- **CLI**:返回非零退出码 + 友好消息
- **MCP**:返回 JSON-RPC error

---

## 4. RBAC(Role-Based Access Control)

### 4.1 Scope 模型

| Scope | 能力 |
|-------|------|
| `admin` | 全部 — 包括管理 operator、改 server、查 audit |
| `write` | 执行命令、上传下载、创建 server |
| `read` | 只读 — 看 server 列表、看 audit |

`scopes` 是数组,operator 可同时拥有多个(例: `["read", "write"]`)。

### 4.2 serverPermissions 白名单

```json
{
  "name": "deploy-bot",
  "scopes": ["read", "write"],
  "serverPermissions": ["web-1", "web-2", "db-1"]
}
```

- **空数组 `[]`**:能访问所有 server(`admin` 才有意义)
- **非空**:只能访问列出的 server(by name 或 id)

`canAccessServer(operator, serverId)` 逻辑:
```ts
if (operator.scopes.includes("admin")) return true;
if (operator.serverPermissions.length === 0) return true;  // 显式给全权
return operator.serverPermissions.includes(serverName) ||
       operator.serverPermissions.includes(serverId);
```

### 4.3 双重检查

每个端点都做:
1. **Scope 检查**:`requireScope("write")` 中间件
2. **server 权限检查**:`canAccessServer(operator, serverId)`

即使 scope 过了,specific server 没在白名单也 403。

### 4.4 命令级控制(可选)

在 server 端可加:
- `commandWhitelist` — 正则白名单,只允许某些命令
- `commandBlacklist` — 正则黑名单,显式拒绝
- `commandTemplate` — 整条命令套模板(例: `sudo -n <quotedCommand>`)

**评估顺序**:whitelist 优先(若不匹配 → 拒) → blacklist(若匹配 → 拒) → template 套壳 → 真正执行

**Agent 必加**,防止 AI 越权:
```json
{
  "commandWhitelist": "^(systemctl|journalctl|ls|cat|grep|ps)\\s.*$",
  "commandBlacklist": "^rm\\s+-rf\\s+/$"
}
```

---

## 5. 审计

### 5.1 100% 覆盖

| 来源 | 写 audit |
|------|----------|
| 8 个 MCP 工具 | ✅ 全部 |
| 13 个 REST 端点 | ✅ 全部 |
| WebSocket 终端(`terminal.open` / `terminal.close`) | ✅ |
| CLI 25 子命令(走 HTTP) | ✅ 走 server 写 |
| 登录(`auth.login`) | ✅ |
| 健康检查 | ❌(噪声太大) |

### 5.2 记录字段

参见 [docs/ARCHITECTURE.md](ARCHITECTURE.md#6-审计数据流) 完整字段表。

### 5.3 脱敏(redact)

入库前 `redactSensitive(output)`:
- `password=xxx` / `passphrase=xxx` → `password=<REDACTED>`
- `BEGIN PRIVATE KEY ... END PRIVATE KEY` → `<PRIVATE_KEY_REDACTED>`
- `Bearer sk-xxx` → `Bearer <REDACTED>`

**IPv4 / 域名不脱敏**(可能业务需要)。

### 5.4 截断

`output` 超过 **10KB** 自动截断:
- 保留前 10KB
- 末尾追加 `...(truncated, total <N> bytes)`
- `output_bytes` 字段存原始大小

防止大输出撑爆 DB(例:`cat /var/log/syslog`)。

---

## 6. 网络与传输

### 6.1 HTTPS(必需)

opsgate 自身只跑 HTTP(:3000),**生产必须**前接反代:
- nginx / Caddy / Traefik
- Let's Encrypt 自动证书
- 强制 HSTS
- 例:[docs/DEPLOY.md §9.1](DEPLOY.md#91-反代示例nginx)

**为什么自身不跑 HTTPS?**
- 简化代码(避免自签证书 / 证书管理)
- 反代层更适合做 TLS termination
- 容器化更清爽

### 6.2 SSH 连接

opsgate → 远端 SSH server 的连接:
- 推荐 SSH 协议 2
- 推荐远端 server 关闭密码登录,只允许公私钥
- 私钥存在 opsgate DB,加密(见 §2.1)
- keepalive 10s(防 NAT 超时)

### 6.3 WebSocket 鉴权

`/ws/terminal/:serverId?token=<jwt>`

- 浏览器无法设自定义 header → token 走 query string
- TLS 加密(query string 也加密)
- 短 token 过期(1h),连接中断需重连重拿

---

## 7. 密钥管理

### 7.1 启动时强校验

```ts
const rawKey = process.env.ENCRYPTION_KEY;
if (!rawKey) throw new Error("ENCRYPTION_KEY must be set");
const key = Buffer.from(rawKey, "base64");
if (key.length < 32) {
  throw new Error(`ENCRYPTION_KEY must decode to >= 32 bytes, got ${key.length}`);
}
```

启动失败如果 key 缺失或太短,**绝不**用默认值兜底。

### 7.2 推荐存储

| 场景 | 推荐 |
|------|------|
| 本地开发 | `.env` 写 gitignore |
| 生产 | Docker secret / K8s Secret / Vault |
| CI/CD | GitHub Actions Secret / GitLab CI Variable |
| 备份 | 离线存储(USB 加密盘 / 1Password) |

### 7.3 灾难恢复

**丢了** `ENCRYPTION_KEY`:
- 加密的 SSH 凭证全废
- 用户需要**重新输入**所有 server 的 password / privateKey
- admin 密码是 bcrypt 哈希 → 也要重置

**丢了** `JWT_SECRET`:
- 所有人 / 所有 Agent 都要重新登录
- 不影响加密数据

**丢了** DB 文件:
- 没备份就完蛋 → 强制定期备份(DEPLOY.md §7.3)

---

## 8. 最佳实践清单

### 部署前
- [ ] 改 admin 默认密码
- [ ] 设 `ENCRYPTION_KEY` / `JWT_SECRET` 从 secret manager 注入
- [ ] 反代 + HTTPS
- [ ] 防火墙只暴露 443
- [ ] admin 登录限制来源 IP(nginx `allow`/`deny`)

### 日常运维
- [ ] 定期备份 DB(DEPLOY.md §7)
- [ ] 定期 rotate API Key(90 天)
- [ ] 定期查 audit(`opsgate audit list --status failed`)
- [ ] opsgate 升级前看 CHANGELOG 的 breaking change

### 给 AI Agent
- [ ] 单独建 `type: "agent"` 的 operator
- [ ] 限定 `scopes: ["read", "write"]`,不给 `admin`
- [ ] 限定 `serverPermissions` 白名单
- [ ] server 端加 `commandWhitelist/Blacklist`
- [ ] 定期 `opsgate audit list --operatorId <agent>` 复核 Agent 行为

---

## 9. 已知限制

| 项 | 影响 | 计划 |
|-----|------|------|
| 无 rate limit | 密码爆破风险 | v2.1 |
| ENCRYPTION_KEY 改后不会自动重加密 | 换 key 要手动 | v2.1(版本化密文) |
| 无 2FA | 密码泄漏即入侵 | v2.1(TOTP) |
| 无 SSO/OIDC | 需自己搭 | v2.2 |
| 审计不支持 SIEM 导出 | 告警延迟 | v2.1 |
| 凭证编辑走 HTTP 明文 | 反代层加 TLS 兜底 | 当前推荐做法 |

---

## 10. 安全事件响应

如果怀疑被入侵:
1. **立即 rotate `ENCRYPTION_KEY`** → 现有 SSH 凭证失效,需重新输入
2. **立即 rotate 所有 API Key**(`opsgate agent rotate-key <name>`)
3. **改 admin 密码**
4. **查审计**:`SELECT * FROM audit_logs WHERE timestamp > <被入侵时间>`
5. **查 SSH 远端**:在每台被管 server 上看 `~/.bash_history` / `auth.log`
6. **保留现场**:先备份再重装(§7.1)
7. **报告 CVE** 给团队

---

## 下一步

- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 架构
- [docs/DEPLOY.md](DEPLOY.md) — 部署 + 备份
- [docs/API.md](API.md) — 鉴权细节
- [docs/MCP.md](MCP.md) — MCP 工具鉴权
- [README.md](../README.md) — 概述
