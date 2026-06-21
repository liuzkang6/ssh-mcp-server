// test/http/api-exec.test.js
//
// Phase 7.5: HTTP API 端点测试 — 覆盖 Phase 7-8 新增的 4 个端点
//
//   G. GET  /api/v1/servers/:id/active-sessions
//   H. POST /api/v1/servers/:id/exec
//   I. POST /api/v1/servers/:id/upload
//   J. POST /api/v1/servers/:id/download
//   K. /api/v1/health.activeSessions 实时 COUNT
//
// 设计原则(沿用 test/http/api.test.js + test/tools/mcp-tools.test.js):
//   - 复用 mcp-tools.test.js 的 mock SSH server(exec/sftp 都行)
//   - 复用 api.test.js 的 Fastify inject + zod 校验 pattern
//   - 每个 beforeEach 重置 DB + 重建 operators / servers + reset SSH pool
//   - audit 走 DB 直查,验证 success/denied/failed 三种状态
//   - 不验证 1-line 旧 src 缺陷(AuthService.lookupNameByApiKeyPrefix 已在 src 修好)
//
// 与现有测试套件的关系:
//   - A-F 鉴权/RBAC/CRUD/Audit/Health 由 test/http/api.test.js 覆盖
//   - 本文件只补 G-K 4 个新端点

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';

const { Server } = ssh2;

// ── 1) 环境变量 ────────────────────────────────────────────────
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.JWT_SECRET ||= 'test-jwt-secret-must-be-at-least-16-chars';
process.env.SSH_MCP_CONNECT_TIMEOUT_MS ||= '1500';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'api-exec-test-'));
process.env.DATA_DIR = DATA_DIR;
const dbPath = join(DATA_DIR, 'platform.db');

const LOCAL_TMP_DIR = resolvePath('.api-exec-test-tmp');
process.env.LOCAL_TEST_TMP_DIR = LOCAL_TMP_DIR;

// ── 2) 导入 ───────────────────────────────────────────────────
const { runMigrations } = await import('../../packages/server/dist/db/migrate.js');
const { closeDb, getDb } = await import('../../packages/server/dist/db/index.js');
const { auditLogs } = await import('../../packages/server/dist/db/schema.js');
const { getServerManager } = await import('../../packages/server/dist/services/server-manager.js');
const { getOperatorManager } = await import('../../packages/server/dist/services/operator-manager.js');
const { getAuthService } = await import('../../packages/server/dist/services/auth-service.js');
const { getPool, _resetPoolForTesting } = await import(
  '../../packages/server/dist/services/ssh-connection-pool.js'
);
const { _resetSSHSessionServiceForTesting } = await import(
  '../../packages/server/dist/services/ssh-session-service.js'
);
const { createHttpServer } = await import('../../packages/server/dist/http/server.js');

// ── 3) Mock SSH server(同 mcp-tools.test.js) ──────────────
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

let sshServer = null;
let sshPort = 0;

// ── 4) 测试状态 ──────────────────────────────────────────
let app;
let admin, viewer, restricted;
let adminToken, viewerToken, restrictedToken;
let mockSrv, unreachableSrv; // server rows
const ALLOWED_SRV_ID = 'srv-allowed-by-perm';

// ── 5) 工具函数 ──────────────────────────────────────────
function dump(res) {
  return `status=${res.statusCode} body=${res.payload ?? res.body}`;
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function freshState() {
  rmSync(LOCAL_TMP_DIR, { recursive: true, force: true });
  mkdirSync(LOCAL_TMP_DIR, { recursive: true });

  const opMgr = getOperatorManager();
  const srvMgr = getServerManager();

  // mock-srv:连得上的 SSH,黑名单 ^sudo\\s
  mockSrv = srvMgr.create({
    name: 'mock-srv',
    host: '127.0.0.1',
    port: sshPort,
    username: 'tester',
    password: 'any',
    transportMode: 'exec',
    commandWhitelist: [],
    commandBlacklist: ['^sudo\\s'],
  });
  // unreachable-srv:连不上(端口 1)
  unreachableSrv = srvMgr.create({
    name: 'unreachable-srv',
    host: '127.0.0.1',
    port: 1,
    username: 'tester',
    password: 'any',
    transportMode: 'exec',
  });

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
    serverPermissions: [ALLOWED_SRV_ID],
  }).operator;

  const auth = getAuthService();
  adminToken = auth.loginAsHuman('admin', 'admin123').token;
  viewerToken = auth.loginAsHuman('viewer', 'viewer123').token;
  restrictedToken = auth.loginAsHuman('restricted', 'r123456').token;
}

function getAllAudit() {
  return getDb().db.select().from(auditLogs).all();
}

function findAudit({ action, status, serverId, operatorId } = {}) {
  return getAllAudit().filter((row) => {
    if (action !== undefined && row.action !== action) return false;
    if (status !== undefined && row.status !== status) return false;
    if (serverId !== undefined && row.serverId !== serverId) return false;
    if (operatorId !== undefined && row.operatorId !== operatorId) return false;
    return true;
  });
}

// ── 6) 钩子 ────────────────────────────────────────────────
before(async () => {
  // 启 mock SSH server
  sshServer = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.once('pty', (acceptPty) => acceptPty && acceptPty());
        session.once('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.end();
        });
        session.once('exec', (acceptExec) => {
          const stream = acceptExec();
          stream.write('mock exec output\n');
          stream.exit(0);
          stream.end();
        });
        session.once('sftp', (acceptSftp) => {
          // 简化 SFTP:fastPut/fastGet 都用空内容(只验证路径走通,不计真实字节)
          const sftp = acceptSftp();
          sftp.on('OPEN', (reqid, filename, flags) => {
            sftp.handle(reqid, Buffer.from('handle'));
          });
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            sftp.status(reqid, 0 /* STATUS_CODE.OK */);
          });
          sftp.on('READ', (reqid, handle, offset, length) => {
            // 返回 0 字节(EOF) — fastGet 会拿到 0 字节但不会报错
            sftp.status(reqid, 1 /* STATUS_CODE.EOF */);
          });
          // fastGet 在 OPEN 之前会先 STAT/LSTAT 取文件信息
          sftp.on('STAT', (reqid, path) => {
            sftp.attrs(reqid, {
              mode: 0o100644, // S_IFREG
              size: 0,
              uid: 0,
              gid: 0,
              mtime: Math.floor(Date.now() / 1000),
              atime: Math.floor(Date.now() / 1000),
            });
          });
          sftp.on('LSTAT', (reqid, path) => {
            sftp.attrs(reqid, {
              mode: 0o100644,
              size: 0,
              uid: 0,
              gid: 0,
              mtime: Math.floor(Date.now() / 1000),
              atime: Math.floor(Date.now() / 1000),
            });
          });
          sftp.on('FSTAT', (reqid, handle) => {
            sftp.attrs(reqid, {
              mode: 0o100644,
              size: 0,
              uid: 0,
              gid: 0,
              mtime: Math.floor(Date.now() / 1000),
              atime: Math.floor(Date.now() / 1000),
            });
          });
          sftp.on('CLOSE', (reqid, handle) => {
            sftp.status(reqid, 0);
          });
          sftp.on('SETSTAT', (reqid, path, attrs) => {
            sftp.status(reqid, 0);
          });
        });
      });
    });
  });
  await new Promise((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
  sshPort = sshServer.address().port;

  getDb(dbPath);
  runMigrations(dbPath);
});

beforeEach(async () => {
  if (app) {
    try { await app.close(); } catch { /* noop */ }
    app = null;
  }
  try {
    await getPool().disconnectAll();
  } catch {
    // noop
  }
  _resetPoolForTesting();
  _resetSSHSessionServiceForTesting();

  closeDb();
  for (const suffix of ['', '-shm', '-wal', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  getDb(dbPath);
  runMigrations(dbPath);

  await freshState();

  app = await createHttpServer({ logger: false, serveWeb: false });
});

after(async () => {
  try {
    await getPool().disconnectAll();
  } catch {
    // noop
  }
  _resetPoolForTesting();

  if (app) {
    try { await app.close(); } catch { /* noop */ }
  }
  if (sshServer) {
    await new Promise((resolve) => {
      try {
        sshServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
    sshServer = null;
  }
  closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(LOCAL_TMP_DIR, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// G. /api/v1/servers/:id/active-sessions
// ════════════════════════════════════════════════════════════

describe('G. GET /api/v1/servers/:id/active-sessions', () => {
  test('G1: 缺 auth → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${mockSrv.id}/active-sessions`,
    });
    assert.equal(res.statusCode, 401, dump(res));
    assert.equal(res.json().code, 'UNAUTHORIZED');
  });

  test('G2: 不存在的 server → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/servers/does-not-exist/active-sessions',
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 404, dump(res));
    assert.equal(res.json().code, 'NOT_FOUND');
  });

  test('G3: viewer 看可访问 server → 200 + 空 list(无活跃 session)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${mockSrv.id}/active-sessions`,
      headers: bearer(viewerToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.count, 0);
    assert.deepEqual(body.sessions, []);
  });

  test('G4: restricted 访问无权限的 server → 403 SERVER_ACCESS_DENIED', async () => {
    // mockSrv.id 不在 restricted.serverPermissions 中
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${mockSrv.id}/active-sessions`,
      headers: bearer(restrictedToken),
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'SERVER_ACCESS_DENIED');
  });

  test('G5: by name(非 id)也能查到', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/mock-srv/active-sessions`,
      headers: bearer(adminToken),
    });
    assert.equal(res.statusCode, 200, dump(res));
    assert.equal(res.json().count, 0);
  });
});

// ════════════════════════════════════════════════════════════
// H. POST /api/v1/servers/:id/exec
// ════════════════════════════════════════════════════════════

describe('H. POST /api/v1/servers/:id/exec', () => {
  test('H1: 缺 auth → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/exec`,
      payload: { command: 'ls' },
    });
    assert.equal(res.statusCode, 401, dump(res));
  });

  test('H2: viewer (read-only, 无 write) → 403 INSUFFICIENT_SCOPE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/exec`,
      headers: bearer(viewerToken),
      payload: { command: 'ls' },
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'INSUFFICIENT_SCOPE');
    // 鉴权失败的 exec 不应写 audit(serverId 也未确定,跳过审计)
    const audits = findAudit({ action: 'execute_command' });
    assert.equal(audits.length, 0);
  });

  test('H3: 缺 command 字段 → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/exec`,
      headers: bearer(adminToken),
      payload: {},
    });
    assert.equal(res.statusCode, 400, dump(res));
    assert.equal(res.json().code, 'VALIDATION_ERROR');
  });

  test('H4: 不存在的 server → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/servers/does-not-exist/exec',
      headers: bearer(adminToken),
      payload: { command: 'ls' },
    });
    assert.equal(res.statusCode, 404, dump(res));
  });

  test('H5: 命中黑名单 ^sudo\\s → 403 COMMAND_VALIDATION_FAILED + denied audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/exec`,
      headers: bearer(adminToken),
      payload: { command: 'sudo reboot' },
    });
    assert.equal(res.statusCode, 403, dump(res));
    const body = res.json();
    assert.equal(body.code, 'COMMAND_VALIDATION_FAILED');
    assert.match(body.message, /blacklist/i);

    const audits = findAudit({ action: 'execute_command', status: 'denied' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, admin.id);
    assert.equal(audits[0].serverId, mockSrv.id);
    // 审计 input.command 不应被脱敏/截断(这里就是 'sudo reboot')
    assert.match(JSON.stringify(audits[0].input), /sudo reboot/);
  });

  test('H6: 合法命令 → 200,body 含 exitCode/stdout/durationMs + success audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/exec`,
      headers: bearer(adminToken),
      payload: { command: 'ls -la', timeoutMs: 10000 },
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.exitCode, 0);
    assert.match(body.stdout, /mock exec output/);
    assert.ok(typeof body.durationMs === 'number' && body.durationMs >= 0);

    const audits = findAudit({ action: 'execute_command', status: 'success' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, admin.id);
    assert.equal(audits[0].serverId, mockSrv.id);
    assert.equal(audits[0].exitCode, 0);
    // output 不应含明文 password/credentials(只透传 stdout/stderr)
    assert.doesNotMatch(JSON.stringify(audits[0].output), /password/i);
  });

  test('H7: 不可达 server(端口 1)→ 500 + failed audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${unreachableSrv.id}/exec`,
      headers: bearer(adminToken),
      payload: { command: 'ls' },
    });
    assert.equal(res.statusCode, 500, dump(res));
    const body = res.json();
    assert.notEqual(body.code, 'COMMAND_VALIDATION_FAILED');

    const audits = findAudit({ action: 'execute_command', status: 'failed' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].serverId, unreachableSrv.id);
    assert.ok(audits[0].errorMessage);
  });

  test('H8: restricted 访问无权限 server → 403 SERVER_ACCESS_DENIED,无 audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/exec`,
      headers: bearer(restrictedToken),
      payload: { command: 'ls' },
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'SERVER_ACCESS_DENIED');
    const audits = findAudit({ action: 'execute_command' });
    assert.equal(audits.length, 0);
  });

  test('H9: 极长 command(>1024)→ 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/exec`,
      headers: bearer(adminToken),
      payload: { command: 'a'.repeat(1025) },
    });
    assert.equal(res.statusCode, 400, dump(res));
    assert.equal(res.json().code, 'VALIDATION_ERROR');
  });
});

// ════════════════════════════════════════════════════════════
// I. POST /api/v1/servers/:id/upload
// ════════════════════════════════════════════════════════════

describe('I. POST /api/v1/servers/:id/upload', () => {
  test('I1: 缺 auth → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/upload`,
      payload: { localPath: '/tmp/x', remotePath: '/tmp/y' },
    });
    assert.equal(res.statusCode, 401, dump(res));
  });

  test('I2: viewer (read-only) → 403 INSUFFICIENT_SCOPE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/upload`,
      headers: bearer(viewerToken),
      payload: { localPath: '/tmp/x', remotePath: '/tmp/y' },
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'INSUFFICIENT_SCOPE');
  });

  test('I3: 缺 localPath → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/upload`,
      headers: bearer(adminToken),
      payload: { remotePath: '/tmp/y' },
    });
    assert.equal(res.statusCode, 400, dump(res));
    assert.equal(res.json().code, 'VALIDATION_ERROR');
  });

  test('I4: 不存在的 server → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/servers/does-not-exist/upload',
      headers: bearer(adminToken),
      payload: { localPath: '/tmp/x', remotePath: '/tmp/y' },
    });
    assert.equal(res.statusCode, 404, dump(res));
  });

  test('I5: cwd 外的 localPath → 403 LOCAL_PATH_NOT_ALLOWED + denied audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/upload`,
      headers: bearer(adminToken),
      payload: {
        localPath: '/etc/passwd',
        remotePath: '/tmp/dest.txt',
      },
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'LOCAL_PATH_NOT_ALLOWED');

    const audits = findAudit({ action: 'upload_file', status: 'denied' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].serverId, mockSrv.id);
    // 审计 input 不应包含明文 password(本 case 无 password,但兜底断言)
    assert.doesNotMatch(JSON.stringify(audits[0].input), /password/i);
  });

  test('I6: 合法上传 → 200,body 含 bytesTransferred + success audit', async () => {
    // 在 cwd 下的 LOCAL_TMP_DIR 写一个文件
    const local = join(LOCAL_TMP_DIR, 'upload-src.txt');
    writeFileSync(local, 'hello world from api-exec test\n');
    assert.ok(existsSync(local));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/upload`,
      headers: bearer(adminToken),
      payload: {
        localPath: local,
        remotePath: '/tmp/upload-dest.txt',
      },
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.success, true);
    assert.ok(typeof body.bytesTransferred === 'number');
    assert.ok(typeof body.durationMs === 'number');

    const audits = findAudit({ action: 'upload_file', status: 'success' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, admin.id);
    assert.equal(audits[0].serverId, mockSrv.id);
  });

  test('I7: 不可达 server → 500 + failed audit', async () => {
    const local = join(LOCAL_TMP_DIR, 'unreachable-src.txt');
    writeFileSync(local, 'x\n');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${unreachableSrv.id}/upload`,
      headers: bearer(adminToken),
      payload: { localPath: local, remotePath: '/tmp/dest' },
    });
    assert.equal(res.statusCode, 500, dump(res));

    const audits = findAudit({ action: 'upload_file', status: 'failed' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].serverId, unreachableSrv.id);
  });
});

// ════════════════════════════════════════════════════════════
// J. POST /api/v1/servers/:id/download
// ════════════════════════════════════════════════════════════

describe('J. POST /api/v1/servers/:id/download', () => {
  test('J1: 缺 auth → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/download`,
      payload: { remotePath: '/etc/hostname', localPath: '/tmp/x' },
    });
    assert.equal(res.statusCode, 401, dump(res));
  });

  test('J2: viewer (read-only) → 403 INSUFFICIENT_SCOPE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/download`,
      headers: bearer(viewerToken),
      payload: { remotePath: '/etc/hostname', localPath: '/tmp/x' },
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'INSUFFICIENT_SCOPE');
  });

  test('J3: 缺 remotePath → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/download`,
      headers: bearer(adminToken),
      payload: { localPath: '/tmp/x' },
    });
    assert.equal(res.statusCode, 400, dump(res));
    assert.equal(res.json().code, 'VALIDATION_ERROR');
  });

  test('J4: 不存在的 server → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/servers/does-not-exist/download',
      headers: bearer(adminToken),
      payload: { remotePath: '/etc/hostname', localPath: '/tmp/x' },
    });
    assert.equal(res.statusCode, 404, dump(res));
  });

  test('J5: cwd 外的 localPath → 403 LOCAL_PATH_NOT_ALLOWED + denied audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/download`,
      headers: bearer(adminToken),
      payload: {
        remotePath: '/etc/hostname',
        localPath: '/etc/should-not-write',
      },
    });
    assert.equal(res.statusCode, 403, dump(res));
    assert.equal(res.json().code, 'LOCAL_PATH_NOT_ALLOWED');

    const audits = findAudit({ action: 'download_file', status: 'denied' });
    assert.equal(audits.length, 1);
  });

  test('J6: 合法下载 → 200,body 含 bytesTransferred + success audit', async () => {
    const local = join(LOCAL_TMP_DIR, 'download-dest.txt');
    assert.ok(!existsSync(local), 'local file should not exist before download');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/download`,
      headers: bearer(adminToken),
      payload: {
        remotePath: '/etc/hostname',
        localPath: local,
      },
    });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.success, true);
    assert.ok(typeof body.bytesTransferred === 'number');

    const audits = findAudit({ action: 'download_file', status: 'success' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, admin.id);
    assert.equal(audits[0].serverId, mockSrv.id);
  });

  test('J7: 不可达 server → 500 + failed audit', async () => {
    const local = join(LOCAL_TMP_DIR, 'unreachable-dest.txt');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${unreachableSrv.id}/download`,
      headers: bearer(adminToken),
      payload: { remotePath: '/etc/hostname', localPath: local },
    });
    assert.equal(res.statusCode, 500, dump(res));

    const audits = findAudit({ action: 'download_file', status: 'failed' });
    assert.equal(audits.length, 1);
  });
});

// ════════════════════════════════════════════════════════════
// K. /api/v1/health.activeSessions 实时 COUNT
// ════════════════════════════════════════════════════════════

describe('K. /api/v1/health.activeSessions', () => {
  test('K1: 初始 activeSessions = 0(无活跃 SSH session)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(res.statusCode, 200, dump(res));
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.activeSessions, 0);
  });

  test('K2: 经过一次 exec 后,activeSessions 回到 0(连接已释放)', async () => {
    // 先做一次成功 exec(连接借出/归还)
    const execRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${mockSrv.id}/exec`,
      headers: bearer(adminToken),
      payload: { command: 'ls' },
    });
    assert.equal(execRes.statusCode, 200, dump(execRes));

    // 短暂等待,确保 release 异步完成
    await new Promise((r) => setTimeout(r, 50));

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(res.statusCode, 200, dump(res));
    // 短连接池模式下,exec 结束应该已归还
    assert.equal(res.json().activeSessions, 0);
  });
});
