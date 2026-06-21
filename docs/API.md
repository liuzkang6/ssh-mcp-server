# API Reference

> opsgate REST API — 13 端点,Base URL `/api/v1/`。
> 鉴权:Bearer `<jwt>`(人)或 `<sk-...>`(AI Agent)。
> 响应统一:`{ code, message, data }`(200 时 `data` 存在;错误时 `code` 是应用错误码)。

## 通用约定

### Base URL
- 本地:`http://localhost:3000/api/v1`
- Docker:`http://<host>:3000/api/v1`
- 反代:`https://opsgate.example.com/api/v1`

### 鉴权
```http
Authorization: Bearer <jwt-or-api-key>
```
自动判别 — JWT 走 HMAC-SHA256 验签,API Key 走 `operators.api_key_hash` bcrypt 比对。

### Content-Type
- 请求:`application/json`
- 响应:`application/json; charset=utf-8`

### 错误响应结构
```json
{
  "code": "INVALID_CREDENTIALS",
  "message": "Invalid username or password",
  "retriable": false
}
```

常见 `code`:
- `UNAUTHORIZED` (401)— token 缺失/无效/过期
- `FORBIDDEN` (403)— scope 不足或 server 不在白名单
- `NOT_FOUND` (404)
- `CONFLICT` (409) — 例如 name 重复
- `VALIDATION_ERROR` (400)
- `SSH_CONNECT_FAILED` (502) — `retriable: true`
- `INTERNAL` (500)

### 分页
GET 列表端点统一支持:
- `limit`(默认 50,最大 200)
- `offset`(默认 0)
- 返回 `{ items: [...], total, limit, offset }`

### 时间
- 所有时间字段:ISO 8601(`2026-06-21T10:30:00.000Z`)
- 内部存储:epoch ms

---

## 1. 认证

### `POST /auth/login`
**请求**:
```json
{ "name": "admin", "password": "admin123" }
```
**响应 200**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresAt": "2026-06-21T11:30:00.000Z",
  "operator": { "id": "...", "name": "admin", "scopes": ["admin"] }
}
```
**错误**:401 `INVALID_CREDENTIALS`

### `GET /auth/whoami`
**响应 200**:
```json
{
  "id": "op-1",
  "name": "admin",
  "type": "human",
  "scopes": ["admin"],
  "serverPermissions": []
}
```

---

## 2. 健康

### `GET /health`
**响应 200**:
```json
{
  "status": "ok",
  "uptime": 3600,
  "activeSessions": 3,
  "version": "2.0.0"
}
```

---

## 3. 服务器 CRUD

### `GET /servers`
**Query**:
- `nameLike`(string)— name 模糊匹配
- `group`(string)
- `tag`(string)

**响应 200**:
```json
{
  "items": [
    {
      "id": "srv-1",
      "name": "web-1",
      "host": "192.168.1.10",
      "port": 22,
      "username": "ubuntu",
      "group": "production",
      "tags": ["web", "nginx"],
      "description": "frontend web tier",
      "createdAt": "2026-06-01T...",
      "updatedAt": "2026-06-15T..."
    }
  ],
  "total": 1
}
```
> ⚠️ **响应不包含凭证**(password / privateKey / passphrase)——这些永不出 server。

### `POST /servers`
**请求**:
```json
{
  "name": "web-1",
  "host": "192.168.1.10",
  "port": 22,
  "username": "ubuntu",
  "password": "********",
  "group": "production",
  "tags": ["web", "nginx"],
  "description": "frontend web tier",
  "commandWhitelist": "^(ls|cat|grep|systemctl)\\s.*$",
  "commandBlacklist": "^rm\\s+-rf\\s+/$",
  "commandTemplate": "sudo -n <quotedCommand>",
  "allowedLocalPaths": ["/tmp", "/home/admin"],
  "allowedRemotePaths": ["/var/log", "/tmp"]
}
```
**响应 201**:返回 server 对象(无凭证)。

### `GET /servers/:id`

### `PATCH /servers/:id`
部分更新(只传要改的字段)。

### `DELETE /servers/:id`
**响应 204**

### `POST /servers/:id/exec`
**请求**:
```json
{
  "command": "uptime",
  "directory": "/tmp",
  "timeoutMs": 30000
}
```
**响应 200**:
```json
{
  "exitCode": 0,
  "stdout": " 10:30:00 up 100 days, ...",
  "stderr": "",
  "durationMs": 234
}
```

### `POST /servers/:id/upload`
**请求**:
```json
{
  "localPath": "/tmp/dist.tar.gz",
  "remotePath": "/tmp/dist.tar.gz",
  "mode": 0o644
}
```
**响应 200**:`{ "success": true, "bytesTransferred": 12345, "durationMs": 123 }`

### `POST /servers/:id/download`
**请求**:
```json
{
  "remotePath": "/var/log/nginx/access.log",
  "localPath": "/tmp/access.log"
}
```

### `GET /servers/:id/active-sessions`
**响应 200**:
```json
{
  "count": 2,
  "sessions": [
    {
      "id": "sess-1",
      "operatorId": "op-1",
      "operatorName": "admin",
      "mode": "shell",
      "startedAt": "...",
      "lastActiveAt": "...",
      "status": "active"
    }
  ]
}
```

---

## 4. Operator 管理

### `GET /operators`
返回所有 operator 列表(`apiKey` 不返回,只能创建/轮换时拿一次)。

### `POST /operators`
**请求**:
```json
{
  "name": "deploy-bot",
  "type": "agent",
  "scopes": ["read", "write"],
  "serverPermissions": ["web-1", "web-2"]
}
```
**响应 201**:`{ ..., "apiKey": "sk-xxxx" }` ← **只此一次返回**

### `GET /operators/:name`

### `PATCH /operators/:name`
**请求**(部分更新):
```json
{ "scopes": ["read"], "serverPermissions": ["db-1"] }
```

### `DELETE /operators/:name`
**响应 204**

### `POST /operators/:name/rotate-key`
**响应 200**:`{ "apiKey": "sk-yyyy" }` ← **旧 key 立即失效,新 key 只此一次返回**

---

## 5. 审计

### `GET /audit-logs`
**Query**:
- `serverId`(string)
- `operatorId`(string)
- `action`(string)— `execute-command` / `terminal.open` / ...
- `status`(string)— `success` / `failed` / `denied` / `cancelled`
- `sinceMinutes`(integer)— 最近 N 分钟
- `limit`(integer, 1-200, 默认 50)
- `offset`(integer, 默认 0)

**响应 200**:
```json
{
  "items": [
    {
      "id": "audit-1",
      "timestamp": 1719000000000,
      "operatorId": "op-1",
      "operatorName": "admin",
      "operatorType": "human",
      "serverId": "srv-1",
      "serverName": "web-1",
      "action": "execute-command",
      "params": "{\"command\":\"uptime\"}",
      "status": "success",
      "errorCode": null,
      "errorMessage": null,
      "output": " 10:30:00 up ...",
      "outputBytes": 1024,
      "durationMs": 234
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

---

## 6. WebSocket 终端

### `GET /ws/terminal/:serverId?token=<jwt>`
升级为 WebSocket 协议。

**协议**:JSON 控制帧 + 二进制/文本流

**客户端 → server**:
| 帧类型 | 格式 | 说明 |
|--------|------|------|
| `data` | `{ "type":"data", "data":"<text>" }` | 输入字符(直接给 shell) |
| `resize` | `{ "type":"resize", "cols":80, "rows":24 }` | 窗口调整 |

**server → 客户端**:
| 帧类型 | 格式 | 说明 |
|--------|------|------|
| `ready` | `{ "type":"ready" }` | shell 已就绪,开始 echo 模式 |
| `data` | `{ "type":"data", "data":"<text>" }` | 远端输出 |
| `error` | `{ "type":"error", "message":"..." }` | SSH 连接失败 / 鉴权失败 |
| `close` | `{ "type":"close", "code":1000, "reason":"..." }` | 关闭 |

**示例客户端(浏览器)**:
```ts
const ws = new WebSocket(`ws://host:3000/ws/terminal/srv-1?token=${jwt}`);
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "data") terminal.write(msg.data);
  if (msg.type === "ready") terminal.write("\x1b[32mconnected\r\n\x1b[0m");
};
terminal.onData((d) => ws.send(JSON.stringify({ type: "data", data: d })));
```

---

## 7. 错误码完整列表

| HTTP | code | 含义 | retriable |
|------|------|------|-----------|
| 400 | `VALIDATION_ERROR` | 参数校验失败 | false |
| 401 | `UNAUTHORIZED` | token 缺失/无效/过期 | false |
| 403 | `FORBIDDEN` | scope 不足 / server 不在白名单 | false |
| 404 | `NOT_FOUND` | 资源不存在 | false |
| 409 | `CONFLICT` | name 重复等唯一约束冲突 | false |
| 429 | `RATE_LIMITED` | 速率限制(后续版本) | true |
| 500 | `INTERNAL` | 内部错误 | false |
| 502 | `SSH_CONNECT_FAILED` | SSH 连接失败 | true |
| 504 | `SSH_TIMEOUT` | SSH 命令超时 | true |

---

## 8. 调用示例(cURL)

### 登录
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"name":"admin","password":"admin123"}' | jq -r .token)
```

### 创建 server
```bash
curl -X POST http://localhost:3000/api/v1/servers \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "name":"web-1",
    "host":"192.168.1.10",
    "username":"ubuntu",
    "password":"****",
    "group":"production",
    "tags":["web","nginx"]
  }'
```

### 跑命令
```bash
curl -X POST http://localhost:3000/api/v1/servers/web-1/exec \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"command":"uptime","timeoutMs":10000}'
```

### 查审计
```bash
curl -G "http://localhost:3000/api/v1/audit-logs" \
  --data-urlencode "sinceMinutes=60" \
  --data-urlencode "status=failed" \
  --data-urlencode "limit=20" \
  -H "authorization: Bearer $TOKEN"
```

---

## 9. 速率限制

v2.0 暂未启用,计划 v2.1:
- 全局:600 req / min / IP
- 鉴权端点:60 req / min / IP
- 单 server 写操作:120 req / min

---

## 下一步

- [docs/CLI.md](CLI.md) — CLI 25+ 子命令
- [docs/MCP.md](MCP.md) — MCP 8 工具
- [docs/SECURITY.md](SECURITY.md) — 安全模型
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 架构
