// test/services/ssh-connection-session-lifecycle.test.js
//
// Phase 5.6.3: SSH Session 生命周期集成测试
//
// 目标:
//   - 用本地 mock SSH server(ssh2.Server)走完 SSHSessionService + SSHConnectionPool 全流程
//   - 验证 sessions 表的 INSERT/UPDATE 时序:acquire → active → closed/failed
//   - 覆盖 refCount、released flag、跨 operator 隔离、并发 acquire
//
// 设计:
//   - 启动一个 mock SSH server(全测试共享),listen ephemeral port
//   - 每个 case 独立 DB 状态 + 独立 pool
//   - 用 ssh2 generateKeyPairSync 生成 host key(2048-bit RSA)

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';

const { Server } = ssh2;

// 1) 设环境变量(必须,否则 loadMasterKey 抛)
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString('base64');

const DATA_DIR = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
process.env.DATA_DIR = DATA_DIR;
const dbPath = join(DATA_DIR, 'platform.db');

const { runMigrations } = await import('../../packages/server/dist/db/migrate.js');
const { closeDb, getDb } = await import('../../packages/server/dist/db/index.js');
const { sessions } = await import('../../packages/server/dist/db/schema.js');
const { getPool, _resetPoolForTesting } = await import(
  '../../packages/server/dist/services/ssh-connection-pool.js'
);
const { getSSHSessionService, _resetSSHSessionServiceForTesting } = await import(
  '../../packages/server/dist/services/ssh-session-service.js'
);
const { getServerManager } = await import(
  '../../packages/server/dist/services/server-manager.js'
);
const { getOperatorManager } = await import(
  '../../packages/server/dist/services/operator-manager.js'
);

// 2) 生成 SSH host key(给 mock server 用)
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

let sshServer = null;
let sshPort = 0;

// ── 钩子 ─────────────────────────────────────────────────────────────

before(async () => {
  // 启动 mock SSH server:接受任意认证,exec 立即 exit 0
  sshServer = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      // 接受任何认证(password / publickey / none)
      ctx.accept();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        // 接受 PTY 分配(SSHSessionService 默认真)
        session.once('pty', (acceptPty, _reject, _info) => {
          acceptPty && acceptPty();
        });
        session.once('exec', (acceptExec, _reject, _info) => {
          const stream = acceptExec();
          stream.exit(0);
          stream.end();
        });
      });
    });
  });

  await new Promise((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
  sshPort = sshServer.address().port;
});

beforeEach(async () => {
  // 先把可能残留的连接优雅关掉(即便 _resetPoolForTesting 也要先发 end)
  try {
    await getPool().disconnectAll();
  } catch {
    // noop
  }
  _resetPoolForTesting();
  _resetSSHSessionServiceForTesting();

  // 重置 DB:关库 → 删文件 → 重开 → 跑 migration
  closeDb();
  for (const suffix of ['', '-shm', '-wal', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  getDb(dbPath);
  runMigrations(dbPath);
});

after(async () => {
  // 关闭所有 pool 连接
  try {
    await getPool().disconnectAll();
  } catch {
    // noop
  }
  _resetPoolForTesting();

  // 关闭 mock SSH server(等所有连接断)
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
});

// ── 工具函数 ─────────────────────────────────────────────────────────

/** 创建一个测试用 human operator(name 必须唯一)。 */
function makeOperator(name) {
  return getOperatorManager().create({
    type: 'human',
    name,
    credential: 'password123',
    scopes: ['admin', 'read', 'write'],
    serverPermissions: [],
  }).operator;
}

/** 创建一个指向 mock SSH server 的 server 记录。 */
function makeServer(name) {
  return getServerManager().create({
    name,
    host: '127.0.0.1',
    port: sshPort,
    username: 'tester',
    password: 'any',
    transportMode: 'exec',
  });
}

/** 查 sessions 表(返回所有行)。 */
function getSessionRows() {
  return getDb().db.select().from(sessions).all();
}

// ════════════════════════════════════════════════════════════════════
// Case 1: 正常 acquire → release → status='closed'
// ════════════════════════════════════════════════════════════════════

describe('Case 1: 正常 exec 流程 → status=closed', () => {
  test('exec() 完成后 sessions 标 closed,endTime 非空,startTime <= endTime', async () => {
    const op = makeOperator('op1');
    const server = makeServer('srv1');

    const result = await getSSHSessionService().exec({
      operatorId: op.id,
      serverId: server.id,
      cmdString: 'ls',
    });

    assert.strictEqual(result.exitCode, 0, 'mock server 立即 exit 0');

    const rows = getSessionRows();
    assert.strictEqual(rows.length, 1, '应该恰好 1 行 session');
    const r = rows[0];
    assert.strictEqual(r.status, 'closed', 'release 后 status=closed');
    assert.ok(r.endTime !== null, 'endTime 必须非空');
    assert.ok(r.startTime <= r.endTime, 'startTime <= endTime');
    assert.strictEqual(r.operatorId, op.id, 'operatorId 匹配');
    assert.strictEqual(r.serverId, server.id, 'serverId 匹配');
    assert.strictEqual(r.transportMode, 'exec', 'transportMode 匹配');
  });
});

// ════════════════════════════════════════════════════════════════════
// Case 2: 异常断开 → status='failed'
// ════════════════════════════════════════════════════════════════════

describe('Case 2: 异常断开 → status=failed', () => {
  test('client.destroy() 后 sessions 标 failed,endTime 非空', async () => {
    const op = makeOperator('op2');
    const server = makeServer('srv2');

    const entry = await getPool().acquire({
      operatorId: op.id,
      serverId: server.id,
      mode: 'exec',
    });

    // 强杀 client(模拟网络断开 / 进程崩溃)
    entry.client.destroy();

    // 等 'close' / 'error' 事件触发的 cleanup
    await new Promise((r) => setTimeout(r, 200));

    const rows = getSessionRows();
    assert.strictEqual(rows.length, 1, '应该恰好 1 行 session');
    const r = rows[0];
    assert.strictEqual(r.status, 'failed', '异常断开 → status=failed');
    assert.ok(r.endTime !== null, 'endTime 必须非空');
    assert.strictEqual(r.operatorId, op.id);
    assert.strictEqual(r.serverId, server.id);
  });
});

// ════════════════════════════════════════════════════════════════════
// Case 3: refCount 行为
// ════════════════════════════════════════════════════════════════════

describe('Case 3: refCount 行为', () => {
  test('同 key 两次 acquire 共享 entry,sessions 只 1 行', async () => {
    const op = makeOperator('op3');
    const server = makeServer('srv3');

    const e1 = await getPool().acquire({
      operatorId: op.id,
      serverId: server.id,
      mode: 'exec',
    });
    const e2 = await getPool().acquire({
      operatorId: op.id,
      serverId: server.id,
      mode: 'exec',
    });

    assert.strictEqual(e1, e2, '应该共享同一个 entry');
    assert.strictEqual(e1.refCount, 2, 'refCount 应该是 2');

    // 查 sessions:只 1 行(没有重复 INSERT)
    const rows = getSessionRows();
    assert.strictEqual(rows.length, 1, '应该恰好 1 行 session(没重复 INSERT)');

    const key = `${op.id}:${server.id}:exec`;

    // 第一次 release:refCount -> 1
    await getPool().release(key);
    assert.strictEqual(e1.refCount, 1, 'refCount 减到 1');

    // 第二次 release:refCount -> 0,entry 删除,status=closed
    await getPool().release(key);

    const rowsAfter = getSessionRows();
    assert.strictEqual(rowsAfter.length, 1, '仍然 1 行');
    assert.strictEqual(rowsAfter[0].status, 'closed', '归零后 status 变 closed');
  });
});

// ════════════════════════════════════════════════════════════════════
// Case 4: 异常断开 + 同 server 另一 operator 不受影响
// ════════════════════════════════════════════════════════════════════

describe('Case 4: 跨 operator 隔离', () => {
  test('op A 异常断开不影响 op B 的 entry', async () => {
    const opA = makeOperator('opA4');
    const opB = makeOperator('opB4');
    const server = makeServer('srv4');

    const eA = await getPool().acquire({
      operatorId: opA.id,
      serverId: server.id,
      mode: 'exec',
    });
    const eB = await getPool().acquire({
      operatorId: opB.id,
      serverId: server.id,
      mode: 'exec',
    });

    assert.notStrictEqual(eA, eB, '不同 operator 的 key 不同,应该是不同 entry');
    assert.strictEqual(getPool().size(), 2, 'pool 应该有 2 个 entry');

    // A 强杀 client
    eA.client.destroy();

    // 等 cleanup 跑完
    await new Promise((r) => setTimeout(r, 200));

    const rows = getSessionRows();
    assert.strictEqual(rows.length, 2, '应该 2 行 session');
    const aRow = rows.find((r) => r.operatorId === opA.id);
    const bRow = rows.find((r) => r.operatorId === opB.id);
    assert.ok(aRow && bRow, 'A 和 B 的 session 行都应在');
    assert.strictEqual(aRow.status, 'failed', 'A 异常断开应标 failed');
    assert.strictEqual(bRow.status, 'active', 'B 应仍为 active');

    // A 的 entry 已从 pool 删除
    assert.strictEqual(getPool().size(), 1, 'A 的 entry 应被清理');

    // B release
    await getPool().release(`${opB.id}:${server.id}:exec`);

    const rowsAfter = getSessionRows();
    const bRowAfter = rowsAfter.find((r) => r.operatorId === opB.id);
    assert.strictEqual(bRowAfter.status, 'closed', 'B release 后变 closed');
    assert.strictEqual(getPool().size(), 0, 'pool 已空');
  });
});

// ════════════════════════════════════════════════════════════════════
// Case 5: released 标志防覆盖
// ════════════════════════════════════════════════════════════════════

describe('Case 5: released flag 防覆盖', () => {
  test('release 之后 client end 事件不会再覆盖 status', async () => {
    const op = makeOperator('op5');
    const server = makeServer('srv5');

    await getPool().acquire({
      operatorId: op.id,
      serverId: server.id,
      mode: 'exec',
    });

    // 正常 release(release 会置 released=true,UPDATE status=closed,client.end())
    await getPool().release(`${op.id}:${server.id}:exec`);

    // 立即查:应是 'closed'
    let rows = getSessionRows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'closed');

    // 等可能的 'end' 事件触发(此时 entry 已被 release 标过 released=true)
    await new Promise((r) => setTimeout(r, 300));

    // 应该还是 'closed'(end 事件 cleanup 看到 released=true,跳过 UPDATE)
    rows = getSessionRows();
    assert.strictEqual(
      rows[0].status,
      'closed',
      'released flag 应阻止覆盖为 failed'
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// Case 6: 并发 acquire 同 key 只 INSERT 1 行
// ════════════════════════════════════════════════════════════════════

describe('Case 6: 并发 acquire 同 key', () => {
  test('3 个并发 acquire 同 key → 共享 1 个 entry,sessions 只 1 行', async () => {
    const op = makeOperator('op6');
    const server = makeServer('srv6');

    const [e1, e2, e3] = await Promise.all([
      getPool().acquire({
        operatorId: op.id,
        serverId: server.id,
        mode: 'exec',
      }),
      getPool().acquire({
        operatorId: op.id,
        serverId: server.id,
        mode: 'exec',
      }),
      getPool().acquire({
        operatorId: op.id,
        serverId: server.id,
        mode: 'exec',
      }),
    ]);

    // 3 个调用都应共享同一 entry
    assert.strictEqual(e1, e2, 'e1 === e2');
    assert.strictEqual(e2, e3, 'e2 === e3');

    // sessions 表只 1 行(pendingConnections 复用,没重复 INSERT)
    const rows = getSessionRows();
    assert.strictEqual(rows.length, 1, '应该恰好 1 行 session');

    const key = `${op.id}:${server.id}:exec`;

    // release 3 次(第一次归零 → 关闭,后两次 silent no-op)
    await getPool().release(key);
    await getPool().release(key);
    await getPool().release(key);

    const rowsAfter = getSessionRows();
    assert.strictEqual(rowsAfter.length, 1, '仍然 1 行');
    assert.strictEqual(rowsAfter[0].status, 'closed', '归零后 status 变 closed');
  });
});
