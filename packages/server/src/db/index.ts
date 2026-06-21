import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

const DEFAULT_DB_PATH = process.env.DATA_DIR
  ? `${process.env.DATA_DIR}/platform.db`
  : './data/platform.db';

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database.Database | null = null;

/**
 * 初始化数据库连接(单例)。
 * 第一次调用时建文件 + 启用外键。
 */
export function getDb(dbPath: string = DEFAULT_DB_PATH) {
  if (_db && _sqlite) {
    return { db: _db, sqlite: _sqlite };
  }

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _sqlite = new Database(dbPath);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');

  _db = drizzle(_sqlite, { schema });

  return { db: _db, sqlite: _sqlite };
}

/**
 * 关闭数据库连接(用于优雅退出)。
 */
export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

export { schema };
