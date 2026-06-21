import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * 4 张核心表的 Drizzle schema。
 *
 * 设计要点:
 * - 主键统一用 ULID(26 字符),通过 ulid 库生成
 * - 时间戳统一存 Unix epoch 整数(ms)
 * - JSON 字段用 { mode: 'json' } 序列化/反序列化
 * - 凭证字段三张表都加密存,见 security/crypto.ts
 */

// ─────────────────────────────────────────────────────────
// 1. servers — 机器表(凭证加密存)
// ─────────────────────────────────────────────────────────
export const servers = sqliteTable(
  'servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(22),
    username: text('username').notNull(),

    // 加密的凭证(三选一)
    encryptedPassword: text('encrypted_password'),
    encryptedPrivateKey: text('encrypted_private_key'),
    encryptedPassphrase: text('encrypted_passphrase'),

    // 业务字段
    group: text('group'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
    description: text('description'),

    // 传输配置
    transportMode: text('transport_mode', { enum: ['exec', 'shell'] })
      .notNull()
      .default('exec'),
    commandWhitelist: text('command_whitelist', { mode: 'json' })
      .$type<string[]>()
      .default([]),
    commandBlacklist: text('command_blacklist', { mode: 'json' })
      .$type<string[]>()
      .default([]),
    allowedRemotePaths: text('allowed_remote_paths', { mode: 'json' })
      .$type<string[]>()
      .default([]),

    // 代理
    socksProxy: text('socks_proxy'), // socks://user:pass@host:port(可加密,这里先存明文 MVP)

    // 元数据
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    nameIdx: index('servers_name_idx').on(t.name),
    groupIdx: index('servers_group_idx').on(t.group),
  })
);

// ─────────────────────────────────────────────────────────
// 2. operators — 操作者表(人 + Agent 统一)
// ─────────────────────────────────────────────────────────
export const operators = sqliteTable(
  'operators',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['human', 'agent'] }).notNull(),
    name: text('name').notNull().unique(),

    // bcrypt hash:人类存密码 hash,Agent 存 api key hash
    credentialHash: text('credential_hash').notNull(),

    // 权限
    scopes: text('scopes', { mode: 'json' })
      .$type<string[]>() // ['read', 'write', 'admin']
      .notNull()
      .default([]),
    serverPermissions: text('server_permissions', { mode: 'json' })
      .$type<string[]>() // server ID 列表,空表示全部
      .default([]),

    // 状态
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastActiveAt: integer('last_active_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    nameIdx: index('operators_name_idx').on(t.name),
    typeIdx: index('operators_type_idx').on(t.type),
  })
);

// ─────────────────────────────────────────────────────────
// 3. sessions — 会话表(双操作者统一)
// ─────────────────────────────────────────────────────────
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    operatorId: text('operator_id')
      .notNull()
      .references(() => operators.id),
    operatorType: text('operator_type', { enum: ['human', 'agent'] }).notNull(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id),
    transportMode: text('transport_mode', { enum: ['exec', 'shell'] }).notNull(),

    startTime: integer('start_time').notNull(),
    endTime: integer('end_time'),
    status: text('status', { enum: ['active', 'closed', 'failed'] })
      .notNull()
      .default('active'),

    // 来源信息
    remoteAddr: text('remote_addr'),
    userAgent: text('user_agent'),
  },
  (t) => ({
    operatorIdx: index('sessions_operator_idx').on(t.operatorId),
    serverIdx: index('sessions_server_idx').on(t.serverId),
    statusIdx: index('sessions_status_idx').on(t.status),
  })
);

// ─────────────────────────────────────────────────────────
// 4. audit_logs — 审计日志表(双操作者统一)
// ─────────────────────────────────────────────────────────
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),

    sessionId: text('session_id').references(() => sessions.id),
    operatorId: text('operator_id').references(() => operators.id),
    operatorType: text('operator_type', { enum: ['human', 'agent'] }).notNull(),
    serverId: text('server_id').references(() => servers.id),

    // 操作类型
    action: text('action').notNull(), // 'execute_command' / 'upload' / 'batch_exec' / ...

    // 输入输出
    input: text('input', { mode: 'json' }), // 命令内容(完整保留,便于回放)
    output: text('output'), // 输出(自动截断 10KB,可能脱敏)
    exitCode: integer('exit_code'),

    // 状态
    status: text('status', {
      enum: ['success', 'failed', 'denied', 'cancelled'],
    }).notNull(),
    errorMessage: text('error_message'), // 自动脱敏

    // 性能
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    serverIdx: index('audit_server_idx').on(t.serverId),
    operatorIdx: index('audit_operator_idx').on(t.operatorId),
    actionIdx: index('audit_action_idx').on(t.action),
    createdAtIdx: index('audit_created_at_idx').on(t.createdAt),
  })
);

// 类型导出,方便 service 层引用
export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
