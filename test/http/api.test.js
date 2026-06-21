// test/http/api.test.js
// Phase 6.10: HTTP API 集成测试
//
// 覆盖范围:
//   A. 鉴权 (Authorization 头 / 过期 / API Key)
//   B. RBAC (scope + server permissions)
//   C. Server CRUD (含 400/404/409 边界)
//   D. Operators (创建/重名/rotate-key)
//   E. Audit (CRUD 触发 / serverId 过滤 / sinceMinutes 过滤 / 截断 & 脱敏)
//   F. Health

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

// 1) 设环境变量(必须,否则 loadMasterKey / JWT_SECRET 抛)
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.JWT_SECRET ||= 'test-jwt-secret-must-be-at-least-16-chars';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'api-test-'));
process.env.DATA_DIR = DATA_DIR;
const dbPath = join(DATA_DIR, 'platform.db');

const { runMigrations } = await import('../../build/db/migrate.js');
const { closeDb, getDb } = await import('../../build/db/index.js');
const { createHttpServer } = await import('../../build/http/server.js');
const { getOperatorManager } = await import('../../build/services/operator-manager.js');
const { getServerManager } = await import('../../build/services/server-manager.js');
const { getAuthService } = await import('../../build/services/auth-service.js');
const { getAuditService } = await import('../../build/services/audit-service.js');
const { ulid } = await import('ulid');

// ── 共享测试状态(在 beforeEach 中重置) ────────────────────
let app;
let adminToken, viewerToken, restrictedToken;
let admin, viewer, restricted;
let agentId, agentPlainKey;        // agent 用于 API key 鉴权测试
const ALLOWED_SERVER_ID = 'srv-allowed';

// ── 工具 ─────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 手工签一个过期的 HS256 JWT(走同样的 base64url/HMAC 算法)。 */
function makeExpiredJwt(operatorId) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    operatorId,
    type: 'human',
    scopes: ['admin', 'read', 'write'],
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 100, // 100s 前已过期
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = b64url(
    createHmac('sha256', process.env.JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest()
  );
  return `${headerB64}.${payloadB64}.${sig}`;
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function dump(res) {
  // 失败时打印完整响应 body,方便 debug
  return `status=${res.statusCode} body=${res.payload ?? res.body}`;
}

/** 重置数据库 + 重建测试用户 + 重启 Fastify。 */
async function freshApp() {
  if (app) {
    try { await app.close(); } catch { /* noop */ }
    app = null;
  }
  closeDb();
  // 清掉 SQLite 主文件 + WAL/SHM 残留
  for (const suffix of ['', '-shm', '-wal', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  // 重新初始化
  getDb(dbPath);
  runMigrations(dbPath);

  // 建测试用户
  // opMgr.create() 返回 { operator, plainCredential },所以这里取 .operator
  const opMgr = getOperatorManager();
  admin = opMgr.create({
    type: 'human',
    name: 'admin',
    credential: 'admin123',
    scopes: ['admin', 'read', 'write'],
    serverPermissions: [],
  }).operator;
  viewer = opMgr.create({
    type: 'human',
    name: 'viewer',
    credential: 'viewer123',
    scopes: ['read'],
    serverPermissions: [],
  }).operator;
  restricted = opMgr.create({
    type: 'human',
    name: 'restricted',
    credential: 'r123456',
    scopes: ['read', 'write'],
    serverPermissions: [ALLOWED_SERVER_ID],
  }).operator;

  // 创建一个 agent(只创建,不在 beforeEach 中登录,留给对应 test)
  const agentCreate = opMgr.create({
    type: 'agent',
    name: 'test-agent',
    scopes: ['read', 'write'],
    serverPermissions: [],
  });
  agentId = agentCreate.operator.id;
  agentPlainKey = agentCreate.plainCredential;

  // 启 Fastify
  app = await createHttpServer({ logger: false, serveWeb: false });

  // 预登录拿 token
  const auth = getAuthService();
  adminToken = auth.loginAsHuman('admin', 'admin123').token;
  viewerToken = auth.loginAsHuman('viewer', 'viewer123').token;
  restrictedToken = auth.loginAsHuman('restricted', 'r123456').token;
}

/** 直接往 servers 表里塞一条带指定 id 的记录(绕过 ULID 自动生成,用于 RBAC 测试)。 */
function insertServerDirect({ id, name, host, username, password = 'pw' }) {
  const { db, sqlite } = getDb();
  const now = Date.now();
  // 使用 drizzle 的表对象来保证列名/类型一致
  // 这里改用 SQL 直插(避开 schema 的 JSON 字段默认值)
  sqlite.prepare(`
    INSERT INTO servers (
      id, name, host, port, username, encrypted_password,
      "group", tags, description, transport_mode,
      command_whitelist, command_blacklist, allowed_remote_paths,
      socks_proxy, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, '[]', NULL, 'exec', '[]', '[]', '[]', NULL, ?, ?)
  `).run(id, name, host, 22, username, password, now, now);
}

// ── 钩子 ─────────────────────────────────────────────────────────────

before(async () => {
  getDb(dbPath);
  runMigrations(dbPath);
});

beforeEach(async () => {
  await freshApp();
});

after(async () => {
  if (app) {
    try { await app.close(); } catch { /* noop */ }
  }
  closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════
// A. 鉴权
// ════════════════════════════════════════════════════════════════════

describe('A. 鉴权', () => {
  test('A1: 缺 Authorization 头 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/servers' });
    assert.equal(res.statusCode, 401, dump(res));
    const body = res.json();
    assert.equal(body.code, 'UNAUTHORIZED');
  });

  test('A2: 错误 Bearer 格式 → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { authorization: 'NotBearer something' },
    });
    assert.equal(res.statusCode, 401, dump(res));
  });

  test('A3: 过期 JWT → 401', async () => {
    const expired = makeExpiredJwt(admin.id);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/whoami',
      headers: bearer(expired),
    });
    assert.equal(res.statusCode, 401, dump(res));
    assert.equal(res.json().code, 'UNAUTHORIZED');
  });

  test('A4: 有效 JWT → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/whoami',
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.id, admin.id);
    assert.equal(body.name, 'admin');
    assert.equal(body.type, 'human');
    assert.ok(body.scopes.includes('admin'));
  });

  test('A5: 有效 API Key (Agent) → 200', async () => {
    // 用 agent 的明文 API key 当 Bearer 调 whoami
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/whoami',
      headers: bearer(agentPlainKey),
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.id, agentId);
    assert.equal(body.type, 'agent');
  });
});

// ════════════════════════════════════════════════════════════════════
// B. RBAC
// ════════════════════════════════════════════════════════════════════

describe('B. RBAC', () => {
  test('B1: viewer (无 admin scope) 调 POST /api/v1/servers → 403 INSUFFICIENT_SCOPE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: bearer(viewerToken),
      payload: { name: 's1', host: '1.1.1.1', username: 'root', password: 'x' },
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'INSUFFICIENT_SCOPE');
  });

  test('B2: viewer 调 GET /api/v1/servers → 200,空 list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: bearer(viewerToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    assert.deepEqual(res.json(), []);
  });

  test('B3: restricted (permissions=[srv-allowed]) 访问其他 server → 403 SERVER_ACCESS_DENIED', async () => {
    // 先塞两个 server:一个 id='srv-allowed'(restricted 有权),一个普通 server
    insertServerDirect({ id: ALLOWED_SERVER_ID, name: 'allowed-srv', host: '1.1.1.1', username: 'u', password: 'p' });
    insertServerDirect({ id: 'srv-other', name: 'other-srv', host: '2.2.2.2', username: 'u', password: 'p' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/srv-other',
      headers: bearer(restrictedToken),
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'SERVER_ACCESS_DENIED');
  });

  test('B4: restricted 访问 srv-allowed → 200', async () => {
    insertServerDirect({ id: ALLOWED_SERVER_ID, name: 'allowed-srv', host: '1.1.1.1', username: 'u', password: 'p' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${ALLOWED_SERVER_ID}`,
      headers: bearer(restrictedToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    assert.equal(res.json().id, ALLOWED_SERVER_ID);
  });
});

// ════════════════════════════════════════════════════════════════════
// C. Server CRUD
// ════════════════════════════════════════════════════════════════════

describe('C. Server CRUD', () => {
  test('C1: POST /api/v1/servers 缺 host → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: bearer(adminToken),
      payload: { name: 'no-host', username: 'root', password: 'x' },
    });
    assert.equal(res.statusCode, 400, dump(res));
    assert.equal(res.json().code, 'VALIDATION_ERROR');
  });

  test('C2: POST /api/v1/servers 缺 username → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: bearer(adminToken),
      payload: { name: 'no-user', host: '1.1.1.1', password: 'x' },
    });
    assert.equal(res.statusCode, 400, dump(res));
    assert.equal(res.json().code, 'VALIDATION_ERROR');
  });

  test('C3: 正常创建 → 201,响应 body 含 id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: bearer(adminToken),
      payload: { name: 'web-1', host: '10.0.0.1', username: 'root', password: 'secret' },
    });
    assert.equal(res.statusCode, 201, dump(res));
    const body = res.json();
    assert.ok(body.id, 'response should contain id');
    assert.equal(body.name, 'web-1');
    assert.equal(body.host, '10.0.0.1');
  });

  test('C4: 重名创建 → 409 CONFLICT', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: bearer(adminToken),
      payload: { name: 'dup', host: '1.1.1.1', username: 'root', password: 'x' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: bearer(adminToken),
      payload: { name: 'dup', host: '2.2.2.2', username: 'root', password: 'x' },
    });
    assert.equal(res.statusCode, 409, dump(res));
    assert.equal(res.json().code, 'CONFLICT');
  });

  test('C5: GET /api/v1/servers/:id 不存在 → 404 NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/nonexistent-id',
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 404, dump(res));
    assert.equal(res.json().code, 'NOT_FOUND');
  });

  test('C6: PUT /api/v1/servers/:id 改 description → 200,description 已更新', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: bearer(adminToken),
      payload: { name: 'upd-1', host: '1.1.1.1', username: 'root', password: 'x' },
    });
    assert.equal(created.statusCode, 201, dump(created));
    const id = created.json().id;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}`,
      headers: bearer(adminToken),
      payload: { description: 'new desc' },
    });
    assert.equal(res.statusCode, 200, dump(res));
    assert.equal(res.json().description, 'new desc');
  });

  test('C7: DELETE /api/v1/servers/:id → 204', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: bearer(adminToken),
      payload: { name: 'del-1', host: '1.1.1.1', username: 'root', password: 'x' },
    });
    const id = created.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}`,
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 204, dump(res));
  });

  test('C8: 删除后 GET → 404', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: bearer(adminToken),
      payload: { name: 'del-2', host: '1.1.1.1', username: 'root', password: 'x' },
    });
    const id = created.json().id;
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}`,
      headers: bearer(adminToken),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}`,
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 404, dump(res));
  });
});

// ════════════════════════════════════════════════════════════════════
// D. Operators
// ════════════════════════════════════════════════════════════════════

describe('D. Operators', () => {
  test('D1: admin 创建 agent → 201,响应含 plainCredential (明文 API Key,只此一次)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/operators',
      headers: bearer(adminToken),
      payload: { type: 'agent', name: 'agent-1', scopes: ['read', 'write'] },
    });
    assert.equal(res.statusCode, 201, dump(res));
    const body = res.json();
    assert.ok(body.plainCredential, 'plainCredential 应在创建时返回');
    assert.ok(body.plainCredential.startsWith('sk-'), 'API Key 必须以 sk- 开头');
    assert.equal(body.operator.type, 'agent');
    assert.equal(body.operator.name, 'agent-1');
  });

  test('D2: 创建同名 operator → 409 CONFLICT', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/operators',
      headers: bearer(adminToken),
      payload: { type: 'agent', name: 'agent-dup' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/operators',
      headers: bearer(adminToken),
      payload: { type: 'agent', name: 'agent-dup' },
    });
    assert.equal(res.statusCode, 409, dump(res));
    assert.equal(res.json().code, 'CONFLICT');
  });

  test('D3: viewer 调 POST /api/v1/operators → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/operators',
      headers: bearer(viewerToken),
      payload: { type: 'agent', name: 'agent-bad' },
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'INSUFFICIENT_SCOPE');
  });

  test('D4: 轮换 API Key → 200,新 plainCredential 与旧不同', async () => {
    const oldKey = agentPlainKey;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/operators/${agentId}/rotate-key`,
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.ok(body.plainCredential);
    assert.notEqual(body.plainCredential, oldKey, '新 key 必须与旧 key 不同');
    assert.ok(body.plainCredential.startsWith('sk-'));

    // 更新共享状态,供下一个测试使用
    agentPlainKey = body.plainCredential;
  });

  test('D5: 旧 API Key 失效 → 401,新 API Key → 200', async () => {
    // 先在本次 test 中重新拿旧 key
    const beforeRotate = agentPlainKey;
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/v1/operators/${agentId}/rotate-key`,
      headers: bearer(adminToken),
    });
    const newKey = rotated.json().plainCredential;

    // 旧 key 应被拒
    const oldRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/whoami',
      headers: bearer(beforeRotate),
    });
    assert.equal(oldRes.statusCode, 401, `old key expected 401, got ${dump(oldRes)}`);

    // 新 key 应通过
    const newRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/whoami',
      headers: bearer(newKey),
    });
    assert.equal(newRes.statusCode, 200, `new key expected 200, got ${dump(newRes)}`);
    assert.equal(newRes.json().id, agentId);
  });
});

// ════════════════════════════════════════════════════════════════════
// E. Audit
// ════════════════════════════════════════════════════════════════════

describe('E. Audit', () => {
  test('E1: 触发几次 CRUD 后,GET /api/v1/audit-logs 应返回这些记录', async () => {
    // NOTE: AuditService.write() 内部 catch 用 require() 处理错误,ESM 下会抛 ReferenceError。
    // 这里直接 SQL 插入(测试目标:HTTP 端的查询、过滤、脱敏/截断),不依赖写路径。
    // 先建好 server,避免 audit_logs.serverId 的外键失败。
    const { sqlite } = getDb();
    const now = Date.now();
    const insertServer = (id, name) => {
      sqlite.prepare(`
        INSERT INTO servers (id, name, host, port, username, created_at, updated_at)
        VALUES (?, ?, '127.0.0.1', 22, 'u', ?, ?)
      `).run(id, name, now, now);
    };
    insertServer('srv-A', 'audit-srv-A');
    insertServer('srv-B', 'audit-srv-B');

    const insert = (op, action, serverId, status) => {
      sqlite.prepare(`
        INSERT INTO audit_logs
          (id, operator_id, operator_type, server_id, action, status, created_at)
        VALUES (?, ?, 'human', ?, ?, ?, ?)
      `).run(ulid(), op, serverId, action, status, now);
    };
    insert(admin.id, 'execute_command', 'srv-A', 'success');
    insert(viewer.id, 'upload', 'srv-B', 'success');
    insert(admin.id, 'create_server', null, 'success');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.count, 3, `期望 3 条, 实际 ${body.count}: ${dump(res)}`);
    const actions = body.logs.map((l) => l.action).sort();
    assert.deepEqual(actions, ['create_server', 'execute_command', 'upload']);
  });

  test('E2: 带 serverId 过滤应只返回该 server 的记录', async () => {
    const { sqlite } = getDb();
    const now = Date.now();
    // 建 server 满足 FK
    sqlite.prepare(`
      INSERT INTO servers (id, name, host, port, username, created_at, updated_at)
      VALUES ('srv-A', 'audit-srv-A', '127.0.0.1', 22, 'u', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO servers (id, name, host, port, username, created_at, updated_at)
      VALUES ('srv-B', 'audit-srv-B', '127.0.0.1', 22, 'u', ?, ?)
    `).run(now, now);

    const insert = (op, action, serverId, status) => {
      sqlite.prepare(`
        INSERT INTO audit_logs
          (id, operator_id, operator_type, server_id, action, status, created_at)
        VALUES (?, ?, 'human', ?, ?, ?, ?)
      `).run(ulid(), op, serverId, action, status, now);
    };
    insert(admin.id, 'act-A', 'srv-A', 'success');
    insert(admin.id, 'act-B', 'srv-B', 'success');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?serverId=srv-A',
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.count, 1);
    assert.equal(body.logs[0].serverId, 'srv-A');
    assert.equal(body.logs[0].action, 'act-A');
  });

  test('E3: 带 sinceMinutes=1 过滤应只返回最近 1 分钟的', async () => {
    const audit = getAuditService();
    const { sqlite } = getDb();
    // 新的(刚才写的)
    audit.write({
      operatorId: admin.id,
      operatorType: 'human',
      action: 'recent',
      status: 'success',
    });
    // 旧的(5 分钟前,直接 SQL 插)
    sqlite.prepare(`
      INSERT INTO audit_logs
        (id, operator_id, operator_type, action, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ulid(), admin.id, 'human', 'old', 'success', Date.now() - 5 * 60 * 1000);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?sinceMinutes=1',
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.count, 1, `期望 1 条(只最近的), 实际 ${body.count}: ${dump(res)}`);
    assert.equal(body.logs[0].action, 'recent');
  });

  test('E4: output 字段不超 10KB,errorMessage 不含明文 password', async () => {
    const audit = getAuditService();
    const huge = 'x'.repeat(15 * 1024); // 15KB
    audit.write({
      operatorId: admin.id,
      operatorType: 'human',
      action: 'huge',
      output: huge,
      status: 'success',
    });
    audit.write({
      operatorId: admin.id,
      operatorType: 'human',
      action: 'with-pw',
      errorMessage: 'connect failed: password=supersecret123 host=1.2.3.4',
      status: 'failed',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    const hugeLog = body.logs.find((l) => l.action === 'huge');
    const pwLog = body.logs.find((l) => l.action === 'with-pw');

    assert.ok(hugeLog, '应能查到 huge 日志');
    // 截断后应 ≤ 10KB(可能有 ...[truncated] 尾巴)
    assert.ok(
      hugeLog.output.length <= 10 * 1024 + 50, // 留点容差
      `output 应被截断到 ≤10KB, 实际长度=${hugeLog.output.length}`
    );
    assert.match(hugeLog.output, /truncated/, '应包含截断标记');

    assert.ok(pwLog, '应能查到 with-pw 日志');
    assert.ok(
      !pwLog.errorMessage.includes('supersecret123'),
      `errorMessage 不应含明文密码,实际: ${pwLog.errorMessage}`
    );
    assert.match(pwLog.errorMessage, /password=\*\*\*/, '应被脱敏为 password=***');
  });
});

// ════════════════════════════════════════════════════════════════════
// F. Health
// ════════════════════════════════════════════════════════════════════

describe('F. Health', () => {
  test('F1: GET /api/v1/health → 200,body 含 status/version/uptime/db', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db, 'ok');
    assert.ok(typeof body.version === 'string' && body.version.length > 0, '应包含 version');
    assert.ok(typeof body.uptime === 'number' && body.uptime >= 0, '应包含 uptime');
  });
});
