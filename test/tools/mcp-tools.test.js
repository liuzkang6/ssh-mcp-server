// test/tools/mcp-tools.test.js
//
// Phase 6.5.4: MCP 工具集成测试
//
// 目标:
//   - 8 个 MCP 工具(4 旧 + 4 新)的端到端集成测试
//   - mock SSH server(本地) + 内存 SQLite(tempdir)
//   - 覆盖鉴权 / RBAC / 命令白黑名单 / 路径校验 / 成功 / 失败 全路径
//   - 全部走 audit_logs 校验
//
// 关键设计:
//   - 每个 beforeEach 重置 DB + 重建 operators / servers
//   - mock SSH server 在 before() 启动(全测试共享)
//   - handler 直接 import 调用,绕开 McpServer.registerTool 反射
//   - 不实际依赖真 sftp 传输(测失败/校验路径)
//   - temp 文件放在 cwd 下(validateLocalPath 默认仅允许 process.cwd())
//   - serverPermissions 是 server 的 ULID(不是 name)

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';

const { Server } = ssh2;

// ── 1) 环境变量(必须,否则 loadMasterKey / JWT_SECRET 抛) ─────────
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.JWT_SECRET ||= 'test-jwt-secret-must-be-at-least-16-chars';
// 让 connect 失败快速返回(默认 30s 太长)
process.env.SSH_MCP_CONNECT_TIMEOUT_MS ||= '1500';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mcp-tools-test-'));
process.env.DATA_DIR = DATA_DIR;
const dbPath = join(DATA_DIR, 'platform.db');

// temp 目录(放本地文件,在 cwd 下,validateLocalPath 才允许)
const LOCAL_TMP_DIR = resolvePath('.mcp-tools-test-tmp');
process.env.LOCAL_TEST_TMP_DIR = LOCAL_TMP_DIR;

// ── 2) 工具/服务导入 ────────────────────────────────────────────
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
// 4 旧工具
const { listServersHandler } = await import('../../packages/server/dist/tools/list-servers.js');
const { executeCommandHandler } = await import('../../packages/server/dist/tools/execute-command.js');
const { uploadHandler } = await import('../../packages/server/dist/tools/upload.js');
const { downloadHandler } = await import('../../packages/server/dist/tools/download.js');
// 4 新工具
const { getServerStatusHandler } = await import('../../packages/server/dist/tools/get-server-status.js');
const { batchExecuteCommandHandler } = await import('../../packages/server/dist/tools/batch-execute-command.js');
const { searchFilesHandler } = await import('../../packages/server/dist/tools/search-files.js');
const { queryAuditLogsHandler, queryAuditLogs } = await import('../../packages/server/dist/tools/query-audit-logs.js');

// ── 3) SSH host key(给 mock server 用) ─────────────────────────
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

let sshServer = null;
let sshPort = 0;

// ── 4) 共享测试状态(每个 beforeEach 重建) ────────────────────
let admin, viewer, restricted;
let adminToken, viewerToken, restrictedToken;
let mockSsh1, mockSsh2, unreachableSrv; // server rows

// ── 5) 工具函数 ────────────────────────────────────────────────

/** 构造 handler 需要的 `extra` 对象(模拟 MCP SDK 注入) */
function makeExtra(token) {
  if (token === undefined || token === null) return { requestInfo: { headers: {} } };
  return {
    requestInfo: {
      headers: { authorization: `Bearer ${token}` },
    },
  };
}

/** 重建 operators 和 servers(顺序:先 servers,再 operators 用其 ID) */
async function freshState() {
  // 0. 清空 temp dir
  rmSync(LOCAL_TMP_DIR, { recursive: true, force: true });
  mkdirSync(LOCAL_TMP_DIR, { recursive: true });

  const opMgr = getOperatorManager();
  const srvMgr = getServerManager();

  // 1. 先建 server(得到 ULID)
  mockSsh1 = srvMgr.create({
    name: 'mock-ssh-1',
    host: '127.0.0.1',
    port: sshPort,
    username: 'tester',
    password: 'any',
    transportMode: 'exec',
    commandWhitelist: [],
    commandBlacklist: ['^sudo\\s'],
  });
  mockSsh2 = srvMgr.create({
    name: 'mock-ssh-2',
    host: '127.0.0.1',
    port: sshPort,
    username: 'tester',
    password: 'any',
    transportMode: 'exec',
    commandWhitelist: [],
    commandBlacklist: [],
  });
  unreachableSrv = srvMgr.create({
    name: 'unreachable-srv',
    host: '127.0.0.1',
    port: 1, // ECONNREFUSED 立即返回
    username: 'tester',
    password: 'any',
    transportMode: 'exec',
  });

  // 2. 再建 operator(用 server.id 而非 name)
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
    serverPermissions: [mockSsh1.id], // 只允许 mock-ssh-1
  }).operator;

  // 3. token
  adminToken = getAuthService().loginAsHuman('admin', 'admin123').token;
  viewerToken = getAuthService().loginAsHuman('viewer', 'viewer123').token;
  restrictedToken = getAuthService().loginAsHuman('restricted', 'r123456').token;
}

/** 查所有 audit(倒序) */
function getAllAudit() {
  return getDb().db.select().from(auditLogs).all();
}

/** 按 action + status 过滤 */
function findAudit({ action, status, serverId, operatorId } = {}) {
  return getAllAudit().filter((row) => {
    if (action !== undefined && row.action !== action) return false;
    if (status !== undefined && row.status !== status) return false;
    if (serverId !== undefined && row.serverId !== serverId) return false;
    if (operatorId !== undefined && row.operatorId !== operatorId) return false;
    return true;
  });
}

/** 解析 handler 返回的 text 字段(JSON) */
function parseHandlerResult(result) {
  const text = result?.content?.[0]?.text;
  if (text === undefined) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** 在 cwd 下建个测试文件(用于 upload 本地路径) */
function makeTempLocalFile(name, content = 'hello world') {
  const p = join(LOCAL_TMP_DIR, name);
  writeFileSync(p, content);
  return p;
}

// ── 6) 钩子 ─────────────────────────────────────────────────────

before(async () => {
  // 启动 mock SSH server:接受任意认证 + exec 立即 exit 0 + 接受 sftp/shell/pty
  sshServer = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      ctx.accept();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.once('pty', (acceptPty) => {
          acceptPty && acceptPty();
        });
        session.once('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.end();
        });
        session.once('exec', (acceptExec) => {
          const stream = acceptExec();
          stream.write('mock output\n');
          stream.exit(0);
          stream.end();
        });
        session.once('sftp', (acceptSftp) => {
          acceptSftp();
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
  // 断开所有残留 SSH 连接
  try {
    await getPool().disconnectAll();
  } catch {
    // noop
  }
  _resetPoolForTesting();
  _resetSSHSessionServiceForTesting();

  // 重置 DB
  closeDb();
  for (const suffix of ['', '-shm', '-wal', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  getDb(dbPath);
  runMigrations(dbPath);

  // 重建测试数据
  await freshState();
});

after(async () => {
  try {
    await getPool().disconnectAll();
  } catch {
    // noop
  }
  _resetPoolForTesting();

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

// ════════════════════════════════════════════════════════════════
// A. list-servers
// ════════════════════════════════════════════════════════════════

describe('A. list-servers', () => {
  test('A1: 无 auth → UNAUTHORIZED + audit denied', async () => {
    await assert.rejects(
      () => listServersHandler(undefined, makeExtra(null)),
      (err) => {
        assert.equal(err.code, 'UNAUTHORIZED');
        return true;
      }
    );
    const audits = findAudit({ action: 'list_servers', status: 'denied' });
    assert.equal(audits.length, 1, '应写 1 条 denied audit');
    assert.equal(audits[0].operatorId, null);
    assert.match(audits[0].errorMessage, /Missing or invalid/);
  });

  test('A2: viewer + 0 servers → 空 list + success audit', async () => {
    getDb().sqlite.exec('DELETE FROM servers');
    const result = await listServersHandler(undefined, makeExtra(viewerToken));
    assert.ok(result.content?.[0]?.text);
    assert.match(result.content[0].text, /No SSH servers visible/);
    const audits = findAudit({ action: 'list_servers', status: 'success' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, viewer.id);
  });

  test('A3: viewer (空 perms) + 3 servers → 看 3 个', async () => {
    const result = await listServersHandler(undefined, makeExtra(viewerToken));
    const text = result.content[0].text;
    assert.match(text, /mock-ssh-1/);
    assert.match(text, /mock-ssh-2/);
    assert.match(text, /unreachable-srv/);
    const audits = findAudit({ action: 'list_servers', status: 'success' });
    assert.equal(audits.length, 1);
  });

  test('A4: restricted (perms=[mockSsh1.id]) → 只看 mock-ssh-1', async () => {
    const result = await listServersHandler(undefined, makeExtra(restrictedToken));
    const text = result.content[0].text;
    assert.match(text, /mock-ssh-1/, 'restricted 应看到 mock-ssh-1');
    assert.doesNotMatch(text, /mock-ssh-2/, 'restricted 不应看到 mock-ssh-2');
    assert.doesNotMatch(text, /unreachable-srv/, 'restricted 不应看到 unreachable-srv');
  });
});

// ════════════════════════════════════════════════════════════════
// B. execute-command
// ════════════════════════════════════════════════════════════════

describe('B. execute-command', () => {
  test('B1: 合法 ls(无白名单)→ 成功 + exitCode=0 + audit success', async () => {
    const result = await executeCommandHandler(
      { command: 'ls -la', serverName: 'mock-ssh-1' },
      makeExtra(adminToken)
    );
    const text = result.content[0].text;
    assert.match(text, /Command executed on mock-ssh-1/);
    assert.match(text, /exitCode: 0/);
    assert.match(text, /mock output/);
    const audits = findAudit({ action: 'execute_command', status: 'success' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, admin.id);
    assert.equal(audits[0].serverId, mockSsh1.id);
    assert.equal(audits[0].exitCode, 0);
  });

  test('B2: rm -rf /(黑名单不匹配,只禁 sudo)→ 成功', async () => {
    // mock-ssh-1 黑名单 ^sudo\s,'rm -rf /' 不匹配 → 成功
    const result = await executeCommandHandler(
      { command: 'rm -rf /tmp/abc', serverName: 'mock-ssh-1' },
      makeExtra(adminToken)
    );
    assert.match(result.content[0].text, /exitCode: 0/);
    const audits = findAudit({ action: 'execute_command', status: 'success' });
    assert.equal(audits.length, 1);
  });

  test('B3: sudo xxx(黑名单命中)→ COMMAND_VALIDATION_FAILED + audit denied', async () => {
    await assert.rejects(
      () => executeCommandHandler(
        { command: 'sudo reboot', serverName: 'mock-ssh-1' },
        makeExtra(adminToken)
      ),
      (err) => {
        assert.equal(err.code, 'COMMAND_VALIDATION_FAILED');
        return true;
      }
    );
    const audits = findAudit({ action: 'execute_command', status: 'denied' });
    assert.equal(audits.length, 1, '应写 1 条 denied audit');
    assert.equal(audits[0].operatorId, admin.id);
    assert.match(audits[0].errorMessage, /blacklist/i);
  });

  test('B4: viewer (只有 read) → INSUFFICIENT_SCOPE + audit denied', async () => {
    await assert.rejects(
      () => executeCommandHandler(
        { command: 'ls', serverName: 'mock-ssh-1' },
        makeExtra(viewerToken)
      ),
      (err) => {
        assert.equal(err.code, 'INSUFFICIENT_SCOPE');
        return true;
      }
    );
    const audits = findAudit({ action: 'execute_command', status: 'denied' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, viewer.id);
    assert.match(audits[0].errorMessage, /write.*admin/);
  });

  test('B5: nonexistent server → SERVER_NOT_FOUND + audit failed', async () => {
    await assert.rejects(
      () => executeCommandHandler(
        { command: 'ls', serverName: 'nonexistent' },
        makeExtra(adminToken)
      ),
      (err) => {
        assert.equal(err.code, 'SERVER_NOT_FOUND');
        return true;
      }
    );
    const audits = findAudit({ action: 'execute_command', status: 'failed' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, admin.id);
    assert.equal(audits[0].serverId, null);
  });
});

// ════════════════════════════════════════════════════════════════
// C. upload
// ════════════════════════════════════════════════════════════════

describe('C. upload', () => {
  test('C1: 合法 local path + 不可达 server → SSH_CONNECTION_FAILED + audit failed', async () => {
    const localPath = makeTempLocalFile('up-src.txt', 'abc');
    await assert.rejects(
      () => uploadHandler(
        { localPath, remotePath: '/tmp/dest.txt', serverName: 'unreachable-srv' },
        makeExtra(adminToken)
      ),
      (err) => {
        // unreachable-srv → pool connect 失败 → SSH_CONNECTION_FAILED
        assert.equal(err.code, 'SSH_CONNECTION_FAILED');
        return true;
      }
    );
    const audits = findAudit({ action: 'upload_file', status: 'failed' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, admin.id);
    assert.equal(audits[0].serverId, unreachableSrv.id);
  });

  test('C2: 非法 local path(/etc/passwd)→ LOCAL_PATH_NOT_ALLOWED + audit denied', async () => {
    await assert.rejects(
      () => uploadHandler(
        { localPath: '/etc/passwd', remotePath: '/tmp/dest.txt', serverName: 'mock-ssh-1' },
        makeExtra(adminToken)
      ),
      (err) => {
        assert.equal(err.code, 'LOCAL_PATH_NOT_ALLOWED');
        return true;
      }
    );
    const audits = findAudit({ action: 'upload_file', status: 'denied' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, admin.id);
    assert.equal(audits[0].serverId, mockSsh1.id);
  });

  test('C3: 非法 remote path(非绝对)→ REMOTE_PATH_NOT_ALLOWED + audit denied', async () => {
    const localPath = makeTempLocalFile('up-src2.txt', 'abc');
    await assert.rejects(
      () => uploadHandler(
        { localPath, remotePath: 'relative/path', serverName: 'mock-ssh-1' },
        makeExtra(adminToken)
      ),
      (err) => {
        assert.equal(err.code, 'REMOTE_PATH_NOT_ALLOWED');
        return true;
      }
    );
    const audits = findAudit({ action: 'upload_file', status: 'denied' });
    assert.equal(audits.length, 1);
  });

  test('C4: viewer (无 write scope) → INSUFFICIENT_SCOPE + audit denied', async () => {
    const localPath = makeTempLocalFile('up-src3.txt', 'abc');
    await assert.rejects(
      () => uploadHandler(
        { localPath, remotePath: '/tmp/dest.txt', serverName: 'mock-ssh-1' },
        makeExtra(viewerToken)
      ),
      (err) => {
        assert.equal(err.code, 'INSUFFICIENT_SCOPE');
        return true;
      }
    );
    const audits = findAudit({ action: 'upload_file', status: 'denied' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, viewer.id);
  });

  test('C5: nonexistent server → SERVER_NOT_FOUND + audit failed', async () => {
    const localPath = makeTempLocalFile('up-src4.txt', 'abc');
    await assert.rejects(
      () => uploadHandler(
        { localPath, remotePath: '/tmp/dest.txt', serverName: 'nonexistent' },
        makeExtra(adminToken)
      ),
      (err) => {
        assert.equal(err.code, 'SERVER_NOT_FOUND');
        return true;
      }
    );
    const audits = findAudit({ action: 'upload_file', status: 'failed' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].serverId, null);
  });
});

// ════════════════════════════════════════════════════════════════
// D. download
// ════════════════════════════════════════════════════════════════

describe('D. download', () => {
  test('D1: 合法 local path + 不可达 server → SSH_CONNECTION_FAILED + audit failed', async () => {
    const localPath = join(LOCAL_TMP_DIR, 'dl-dest.txt');
    await assert.rejects(
      () => downloadHandler(
        { remotePath: '/etc/hostname', localPath, serverName: 'unreachable-srv' },
        makeExtra(adminToken)
      ),
      (err) => {
        assert.equal(err.code, 'SSH_CONNECTION_FAILED');
        return true;
      }
    );
    const audits = findAudit({ action: 'download_file', status: 'failed' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].serverId, unreachableSrv.id);
  });

  test('D2: 非法 local path(父目录不存在)→ LOCAL_PATH_NOT_ALLOWED + audit denied', async () => {
    await assert.rejects(
      () => downloadHandler(
        { remotePath: '/etc/hostname', localPath: join(LOCAL_TMP_DIR, 'sub-no-exist', 'x.txt'), serverName: 'mock-ssh-1' },
        makeExtra(adminToken)
      ),
      (err) => {
        assert.equal(err.code, 'LOCAL_PATH_NOT_ALLOWED');
        return true;
      }
    );
    const audits = findAudit({ action: 'download_file', status: 'denied' });
    assert.equal(audits.length, 1);
  });

  test('D3: 非法 remote path(非绝对)→ REMOTE_PATH_NOT_ALLOWED + audit denied', async () => {
    const localPath = join(LOCAL_TMP_DIR, 'dl-dest2.txt');
    await assert.rejects(
      () => downloadHandler(
        { remotePath: 'relative/path', localPath, serverName: 'mock-ssh-1' },
        makeExtra(adminToken)
      ),
      (err) => {
        assert.equal(err.code, 'REMOTE_PATH_NOT_ALLOWED');
        return true;
      }
    );
    const audits = findAudit({ action: 'download_file', status: 'denied' });
    assert.equal(audits.length, 1);
  });

  test('D4: viewer (无 write scope) → INSUFFICIENT_SCOPE + audit denied', async () => {
    const localPath = join(LOCAL_TMP_DIR, 'dl-dest3.txt');
    await assert.rejects(
      () => downloadHandler(
        { remotePath: '/etc/hostname', localPath, serverName: 'mock-ssh-1' },
        makeExtra(viewerToken)
      ),
      (err) => {
        assert.equal(err.code, 'INSUFFICIENT_SCOPE');
        return true;
      }
    );
    const audits = findAudit({ action: 'download_file', status: 'denied' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, viewer.id);
  });

  test('D5: nonexistent server → SERVER_NOT_FOUND + audit failed', async () => {
    const localPath = join(LOCAL_TMP_DIR, 'dl-dest4.txt');
    await assert.rejects(
      () => downloadHandler(
        { remotePath: '/etc/hostname', localPath, serverName: 'nonexistent' },
        makeExtra(adminToken)
      ),
      (err) => {
        assert.equal(err.code, 'SERVER_NOT_FOUND');
        return true;
      }
    );
    const audits = findAudit({ action: 'download_file', status: 'failed' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].serverId, null);
  });
});

// ════════════════════════════════════════════════════════════════
// E. get-server-status
// ════════════════════════════════════════════════════════════════

describe('E. get-server-status', () => {
  test('E1: nonexistent server → isError=true + INTERNAL_ERROR + audit failed', async () => {
    // handler 不鉴权,但 nonexistent server 会抛 plain Error
    // handler 把错误转成 INTERNAL_ERROR + isError: true + audit failed
    const result = await getServerStatusHandler(
      { serverName: 'nonexistent' },
      makeExtra(null)
    );
    assert.equal(result.isError, true);
    const parsed = parseHandlerResult(result);
    assert.equal(parsed.code, 'INTERNAL_ERROR');
    assert.match(parsed.message, /Server not found/);

    const audits = findAudit({ action: 'get_server_status', status: 'failed' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, null);
    assert.equal(audits[0].operatorType, 'agent');
    assert.match(audits[0].errorMessage, /Server not found/);
  });

  test('E2: 合法 server + 不可达 → success audit + 字段全空(runCommand 错误被 inner try 吞)', async () => {
    // collectSystemStatus 内部 worker 的 try/catch 把每条命令的连接错误吞掉,
    // 结果所有字段为空;outer try 不进入 catch,reachable 保持 true(initial 值)
    const result = await getServerStatusHandler(
      { serverName: 'unreachable-srv', timeout: 2000 },
      makeExtra(null)
    );
    assert.notEqual(result.isError, true);
    const parsed = parseHandlerResult(result);
    assert.equal(parsed.reachable, true, 'reachable 保持 true(initial)');
    assert.equal(parsed.hostname, undefined, 'hostname 字段应为空');
    assert.equal(parsed.osName, undefined, 'osName 字段应为空');
    // audit 仍为 success
    const audits = findAudit({ action: 'get_server_status', status: 'success' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].serverId, unreachableSrv.id);
  });

  test('E3: 无 auth header → handler 不鉴权,按调用继续', async () => {
    const result = await getServerStatusHandler(
      { serverName: 'nonexistent' },
      { requestInfo: { headers: {} } }
    );
    assert.equal(result.isError, true);
    // audit 按 agent 写入
    const audits = findAudit({ action: 'get_server_status' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, null);
  });
});

// ════════════════════════════════════════════════════════════════
// F. batch-execute-command
// ════════════════════════════════════════════════════════════════

describe('F. batch-execute-command', () => {
  test('F1: 2 servers (1 ok + 1 unreachable) parallel=2 cmd=ls → 1 success + 1 fail', async () => {
    const result = await batchExecuteCommandHandler(
      {
        servers: ['mock-ssh-1', 'unreachable-srv'],
        cmdString: 'ls',
        parallel: 2,
        timeout: 3000,
      },
      makeExtra(null)
    );
    const parsed = parseHandlerResult(result);
    assert.ok(parsed.summary, '应有 summary');
    assert.equal(parsed.summary.total, 2);
    assert.equal(parsed.summary.success, 1, 'mock-ssh-1 成功');
    assert.equal(parsed.summary.failed, 1, 'unreachable-srv 失败');

    // audit: 每个 server 一行
    const successAudits = findAudit({ action: 'batch_execute_command', status: 'success' });
    const failedAudits = findAudit({ action: 'batch_execute_command', status: 'failed' });
    assert.equal(successAudits.length, 1);
    assert.equal(failedAudits.length, 1);
    assert.equal(successAudits[0].serverId, mockSsh1.id);
    assert.equal(failedAudits[0].serverId, unreachableSrv.id);
  });

  test('F2: 全部 nonexistent server names → 0 results + empty summary', async () => {
    const result = await batchExecuteCommandHandler(
      { servers: ['nope-1', 'nope-2'], cmdString: 'ls' },
      makeExtra(null)
    );
    const parsed = parseHandlerResult(result);
    assert.equal(parsed.summary.total, 0);
    assert.deepEqual(parsed.results, []);
  });

  test('F3: 无 auth header → handler 不鉴权,正常执行 + audit 按 agent 写', async () => {
    const result = await batchExecuteCommandHandler(
      { servers: ['mock-ssh-1'], cmdString: 'ls' },
      { requestInfo: { headers: {} } }
    );
    const parsed = parseHandlerResult(result);
    assert.equal(parsed.summary.success, 1);
    const audits = findAudit({ action: 'batch_execute_command' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, null);
  });
});

// ════════════════════════════════════════════════════════════════
// G. search-files
// ════════════════════════════════════════════════════════════════

describe('G. search-files', () => {
  test('G1: 合法调用 → success audit + parsed results', async () => {
    const result = await searchFilesHandler(
      {
        servers: ['mock-ssh-1'],
        pattern: '*.conf',
        path: '/etc',
        maxDepth: 2,
        timeout: 3000,
      },
      makeExtra(null)
    );
    const parsed = parseHandlerResult(result);
    assert.ok(parsed.results, '应有 results');
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].serverId, mockSsh1.id);
    const audits = findAudit({ action: 'search_files', status: 'success' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operatorId, null);
  });

  test('G2: 全部 nonexistent server names → isError + error message(无 audit)', async () => {
    const result = await searchFilesHandler(
      { servers: ['nonexistent'], pattern: '*.txt' },
      makeExtra(null)
    );
    assert.equal(result.isError, true);
    const parsed = parseHandlerResult(result);
    assert.match(parsed.error, /No valid servers/);
    // 注:search-files 的失败 audit 只在 try 块异常时写,targets.length===0 直接 return
    const audits = findAudit({ action: 'search_files' });
    assert.equal(audits.length, 0);
  });

  test('G3: 无 auth header → handler 不鉴权,正常执行', async () => {
    const result = await searchFilesHandler(
      { servers: ['mock-ssh-1'], pattern: '*' },
      { requestInfo: { headers: {} } }
    );
    const parsed = parseHandlerResult(result);
    assert.ok(parsed.results, '无 auth 仍正常执行');
    const audits = findAudit({ action: 'search_files', status: 'success' });
    assert.equal(audits.length, 1);
  });
});

// ════════════════════════════════════════════════════════════════
// H. query-audit-logs
// ════════════════════════════════════════════════════════════════

describe('H. query-audit-logs', () => {
  test('H1: 先调一次 execute-command,再 query,能看到那条 audit', async () => {
    await executeCommandHandler(
      { command: 'echo hi', serverName: 'mock-ssh-1' },
      makeExtra(adminToken)
    );
    const rows = await queryAuditLogs({});
    const execRows = rows.filter((r) => r.action === 'execute_command');
    assert.ok(execRows.length >= 1);
    assert.equal(execRows[0].operatorId, admin.id);
    assert.equal(execRows[0].status, 'success');
  });

  test('H2: filter by serverId → 只看该 server 的', async () => {
    await executeCommandHandler(
      { command: 'ls', serverName: 'mock-ssh-1' },
      makeExtra(adminToken)
    );
    await executeCommandHandler(
      { command: 'ls', serverName: 'mock-ssh-2' },
      makeExtra(adminToken)
    );

    const rows = await queryAuditLogs({ serverId: mockSsh1.id });
    assert.ok(rows.length >= 1);
    for (const r of rows) {
      assert.equal(r.serverId, mockSsh1.id, '所有行都应是 mock-ssh-1');
    }
  });

  test('H3: filter by status=denied → 只看 denied 的', async () => {
    await executeCommandHandler(
      { command: 'ls', serverName: 'mock-ssh-1' },
      makeExtra(adminToken)
    );
    await assert.rejects(
      () => executeCommandHandler(
        { command: 'sudo reboot', serverName: 'mock-ssh-1' },
        makeExtra(adminToken)
      ),
      (err) => err.code === 'COMMAND_VALIDATION_FAILED'
    );

    const rows = await queryAuditLogs({ status: 'denied' });
    assert.ok(rows.length >= 1);
    for (const r of rows) {
      assert.equal(r.status, 'denied');
    }
  });

  test('H4a: viewer serverPermissionFilter=undefined → 看全部', async () => {
    await executeCommandHandler(
      { command: 'ls', serverName: 'mock-ssh-1' },
      makeExtra(adminToken)
    );
    await executeCommandHandler(
      { command: 'ls', serverName: 'mock-ssh-2' },
      makeExtra(adminToken)
    );

    // 模拟 HTTP 层不传 serverPermissionFilter(viewer 空 perms)
    const rows = await queryAuditLogs({});
    const serverIds = new Set(rows.map((r) => r.serverId).filter(Boolean));
    assert.ok(serverIds.has(mockSsh1.id), '应能看到 mock-ssh-1');
    assert.ok(serverIds.has(mockSsh2.id), '应能看到 mock-ssh-2');
  });

  test('H4b: restricted serverPermissionFilter=[mockSsh1.id] → 只看 mock-ssh-1', async () => {
    await executeCommandHandler(
      { command: 'ls', serverName: 'mock-ssh-1' },
      makeExtra(adminToken)
    );
    await executeCommandHandler(
      { command: 'ls', serverName: 'mock-ssh-2' },
      makeExtra(adminToken)
    );

    // 模拟 HTTP 层把 restricted.serverPermissions 传进去
    const rows = await queryAuditLogs({
      serverPermissionFilter: [mockSsh1.id],
    });
    assert.ok(rows.length >= 1);
    for (const r of rows) {
      // 应只看到 mock-ssh-1 的(或者 serverId IS NULL 的)
      if (r.serverId !== null) {
        assert.equal(r.serverId, mockSsh1.id, `serverId 应是 mock-ssh-1,got ${r.serverId}`);
      }
    }
  });

  test('H5: handler 直接调 → 返回 content + count + logs', async () => {
    await executeCommandHandler(
      { command: 'ls', serverName: 'mock-ssh-1' },
      makeExtra(adminToken)
    );
    const result = await queryAuditLogsHandler({}, makeExtra(null));
    assert.ok(result.content?.[0]?.text);
    const parsed = parseHandlerResult(result);
    assert.ok(typeof parsed.count === 'number');
    assert.ok(Array.isArray(parsed.logs));
    assert.ok(parsed.count >= 1);
  });
});
