// test/services/ssh-connection-pool.test.js
//
// Phase 5.5.4: SSHConnectionPool 单元测试
//
// 设计原则:
//   - 不真连 SSH(无法注入 Client,且会拖慢测试)
//   - 仅测 Pool 自身的可观察行为:单例 / 重置 / 空池 API / 错误路径 / 状态清理
//   - 真连行为留给 Phase 11.6 MCP 集成测试

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1) 设环境变量(必须,否则 loadMasterKey 抛)
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString('base64');

const DATA_DIR = mkdtempSync(join(tmpdir(), 'pool-test-'));
process.env.DATA_DIR = DATA_DIR;
const dbPath = join(DATA_DIR, 'platform.db');

const { runMigrations } = await import('../../packages/server/dist/db/migrate.js');
const { closeDb, getDb } = await import('../../packages/server/dist/db/index.js');
const { getPool, _resetPoolForTesting } = await import(
  '../../packages/server/dist/services/ssh-connection-pool.js'
);

before(() => {
  getDb(dbPath);
  runMigrations(dbPath);
});

beforeEach(() => {
  // 每个 case 拿全新 pool,保证 size/entries 不被前一个 case 影响
  _resetPoolForTesting();
});

after(() => {
  _resetPoolForTesting();
  closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════
// A. 单例 / 重置
// ════════════════════════════════════════════════════════════════════

describe('A. 单例 / 重置', () => {
  test('A1: getPool() 多次调用返回同一实例', () => {
    const p1 = getPool();
    const p2 = getPool();
    const p3 = getPool();
    assert.strictEqual(p1, p2);
    assert.strictEqual(p2, p3);
  });

  test('A2: _resetPoolForTesting() 之后 getPool() 返回新实例', () => {
    const p1 = getPool();
    _resetPoolForTesting();
    const p2 = getPool();
    assert.notStrictEqual(p1, p2, 'reset 后应得到新实例');
  });

  test('A3: reset 后 size 为 0(旧 pool 的 entries 不可见)', () => {
    const p1 = getPool();
    assert.strictEqual(p1.size(), 0);
    _resetPoolForTesting();
    const p2 = getPool();
    assert.strictEqual(p2.size(), 0, '新 pool 应当是干净的');
  });
});

// ════════════════════════════════════════════════════════════════════
// B. 空池 API
// ════════════════════════════════════════════════════════════════════

describe('B. 空池 API', () => {
  test('B1: size() 在空池上为 0', () => {
    const pool = getPool();
    assert.strictEqual(pool.size(), 0);
  });

  test('B2: getActiveSessions("any") 在空池上返回 []', () => {
    const pool = getPool();
    assert.deepEqual(pool.getActiveSessions('any-server-id'), []);
  });

  test('B3: getActiveSessions("") 在空池上返回 []', () => {
    const pool = getPool();
    assert.deepEqual(pool.getActiveSessions(''), []);
  });

  test('B4: release("non-existent-key") 是静默 no-op(不抛,resolve undefined)', async () => {
    const pool = getPool();
    // 源码语义:key 不存在时直接 return(undefined)。
    const result = await pool.release('op:srv:exec-not-in-pool');
    assert.strictEqual(result, undefined);
    // 同时验证 entries 仍为空(没误删)
    assert.strictEqual(pool.size(), 0);
  });

  test('B5: 多次 release 同一不存在 key 都不抛', async () => {
    const pool = getPool();
    await pool.release('op:srv:exec-x');
    await pool.release('op:srv:exec-x');
    await pool.release('op:srv:exec-y');
    assert.strictEqual(pool.size(), 0);
  });
});

// ════════════════════════════════════════════════════════════════════
// C. acquire 错误路径(不真连,走 "server not found")
// ════════════════════════════════════════════════════════════════════

describe('C. acquire 错误路径', () => {
  test('C1: acquire({serverId: 不存在, mode: "exec"}) reject,code=SSH_CONNECTION_FAILED,msg 含 "Server not found"', async () => {
    const pool = getPool();
    await assert.rejects(
      () =>
        pool.acquire({
          operatorId: 'op-test',
          serverId: 'srv-does-not-exist',
          mode: 'exec',
        }),
      (err) => {
        assert.strictEqual(err.name, 'ToolError');
        assert.strictEqual(err.code, 'SSH_CONNECTION_FAILED');
        assert.match(err.message, /Server not found/);
        assert.match(err.message, /srv-does-not-exist/);
        return true;
      }
    );
  });

  test('C2: acquire({mode: "shell", serverId: 不存在}) 同样 reject', async () => {
    const pool = getPool();
    await assert.rejects(
      () =>
        pool.acquire({
          operatorId: 'op-test',
          serverId: 'srv-does-not-exist',
          mode: 'shell',
        }),
      (err) => {
        assert.strictEqual(err.code, 'SSH_CONNECTION_FAILED');
        assert.match(err.message, /Server not found/);
        return true;
      }
    );
  });

  test('C3: 失败 acquire 不污染 pool(size 仍 0,getActiveSessions 返回 [])', async () => {
    const pool = getPool();
    await assert.rejects(() =>
      pool.acquire({
        operatorId: 'op-test',
        serverId: 'srv-does-not-exist',
        mode: 'exec',
      })
    );
    assert.strictEqual(pool.size(), 0, '失败后 entries 仍应为空');
    assert.deepEqual(pool.getActiveSessions('srv-does-not-exist'), []);
  });

  test('C4: 失败后再 acquire 同 key 仍 reject(无 stuck pendingConnections)', async () => {
    const pool = getPool();
    // 第一次 reject
    await assert.rejects(() =>
      pool.acquire({
        operatorId: 'op-test',
        serverId: 'srv-does-not-exist',
        mode: 'exec',
      })
    );
    // 第二次:应仍是 reject(不是 unhandled,也不是 stale promise)
    await assert.rejects(
      () =>
        pool.acquire({
          operatorId: 'op-test',
          serverId: 'srv-does-not-exist',
          mode: 'exec',
        }),
      (err) => {
        assert.strictEqual(err.code, 'SSH_CONNECTION_FAILED');
        return true;
      }
    );
    assert.strictEqual(pool.size(), 0);
  });

  test('C5: 并发两个 acquire 同一 key 都被 reject,pool 仍干净', async () => {
    const pool = getPool();
    const probe = (opId) =>
      pool
        .acquire({ operatorId: opId, serverId: 'srv-x', mode: 'exec' })
        .then(
          () => ({ ok: true }),
          (err) => ({ ok: false, code: err.code, msg: err.message })
        );
    const [r1, r2] = await Promise.all([probe('op-1'), probe('op-1')]);
    assert.strictEqual(r1.ok, false, 'r1 应 reject');
    assert.strictEqual(r2.ok, false, 'r2 应 reject');
    assert.strictEqual(r1.code, 'SSH_CONNECTION_FAILED');
    assert.strictEqual(r2.code, 'SSH_CONNECTION_FAILED');
    assert.match(r1.msg, /Server not found/);
    assert.match(r2.msg, /Server not found/);
    assert.strictEqual(pool.size(), 0);
  });
});

// ════════════════════════════════════════════════════════════════════
// D. disconnect 行为
// ════════════════════════════════════════════════════════════════════

describe('D. disconnect 行为', () => {
  test('D1: 空池上 disconnectAll() 不抛、resolve undefined', async () => {
    const pool = getPool();
    const result = await pool.disconnectAll();
    assert.strictEqual(result, undefined);
    assert.strictEqual(pool.size(), 0);
  });

  test('D2: 多次调用 disconnectAll() 都安全', async () => {
    const pool = getPool();
    await pool.disconnectAll();
    await pool.disconnectAll();
    await pool.disconnectAll();
    assert.strictEqual(pool.size(), 0);
  });

  test('D3: disconnectAll() 之后 acquire 仍能正常工作(虽 reject,但池子可继续用)', async () => {
    const pool = getPool();
    await pool.disconnectAll();
    await assert.rejects(() =>
      pool.acquire({
        operatorId: 'op-test',
        serverId: 'srv-does-not-exist',
        mode: 'exec',
      })
    );
    assert.strictEqual(pool.size(), 0);
  });
});
