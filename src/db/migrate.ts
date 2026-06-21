import { getDb, closeDb } from './index.js';

/**
 * 建表 SQL。直接执行,不依赖 drizzle-kit(简化部署)。
 * 表结构与 schema.ts 一一对应。
 */
const CREATE_TABLES_SQL = `
-- servers
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  encrypted_password TEXT,
  encrypted_private_key TEXT,
  encrypted_passphrase TEXT,
  "group" TEXT,
  tags TEXT DEFAULT '[]',
  description TEXT,
  transport_mode TEXT NOT NULL DEFAULT 'exec',
  command_whitelist TEXT DEFAULT '[]',
  command_blacklist TEXT DEFAULT '[]',
  allowed_remote_paths TEXT DEFAULT '[]',
  socks_proxy TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS servers_name_idx ON servers(name);
CREATE INDEX IF NOT EXISTS servers_group_idx ON servers("group");

-- operators
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('human', 'agent')),
  name TEXT NOT NULL UNIQUE,
  credential_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  server_permissions TEXT DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_active_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS operators_name_idx ON operators(name);
CREATE INDEX IF NOT EXISTS operators_type_idx ON operators(type);

-- sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  operator_type TEXT NOT NULL CHECK (operator_type IN ('human', 'agent')),
  server_id TEXT NOT NULL REFERENCES servers(id),
  transport_mode TEXT NOT NULL CHECK (transport_mode IN ('exec', 'shell')),
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'failed')),
  remote_addr TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_operator_idx ON sessions(operator_id);
CREATE INDEX IF NOT EXISTS sessions_server_idx ON sessions(server_id);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);

-- audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  operator_id TEXT REFERENCES operators(id),
  operator_type TEXT NOT NULL CHECK (operator_type IN ('human', 'agent')),
  server_id TEXT REFERENCES servers(id),
  action TEXT NOT NULL,
  input TEXT,
  output TEXT,
  exit_code INTEGER,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'denied', 'cancelled')),
  error_message TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_server_idx ON audit_logs(server_id);
CREATE INDEX IF NOT EXISTS audit_operator_idx ON audit_logs(operator_id);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_created_at_idx ON audit_logs(created_at);
`;

/**
 * 执行 migration。启动时调用,幂等。
 */
export function runMigrations(dbPath?: string) {
  const { sqlite } = getDb(dbPath);

  // 拆成单条语句执行(better-sqlite3 exec 一次跑完)
  sqlite.exec(CREATE_TABLES_SQL);
}

/**
 * 独立运行的入口:`npm run db:migrate`
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runMigrations();
    console.log('✓ Migrations applied successfully');
  } catch (e) {
    console.error('✗ Migration failed:', e);
    process.exit(1);
  } finally {
    closeDb();
  }
}
