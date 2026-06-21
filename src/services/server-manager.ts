import { eq, like, and, or, isNull, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getDb } from '../db/index.js';
import { servers, type Server, type NewServer } from '../db/schema.js';
import { encryptOptional, decryptOptional } from '../security/crypto.js';

/**
 * 服务器管理服务。
 *
 * 负责:
 * - CRUD(凭证加密存)
 * - 列表查询(支持 group/tag/name 过滤)
 * - 凭证解密(内部 API,仅 Pool 调用)
 */

export interface CreateServerInput {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  group?: string;
  tags?: string[];
  description?: string;
  transportMode?: 'exec' | 'shell';
  commandWhitelist?: string[];
  commandBlacklist?: string[];
  allowedRemotePaths?: string[];
  socksProxy?: string;
}

export interface UpdateServerInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  group?: string;
  tags?: string[];
  description?: string;
  transportMode?: 'exec' | 'shell';
  commandWhitelist?: string[];
  commandBlacklist?: string[];
  allowedRemotePaths?: string[];
  socksProxy?: string;
}

export interface ListFilter {
  group?: string;
  tag?: string;
  nameLike?: string;
  /** 若指定,只返回 ID 在这个列表里的 server(用于 RBAC) */
  ids?: string[];
}

export class ServerManager {
  /**
   * 创建服务器。校验必填,加密凭证,ULID 生成 id。
   */
  create(input: CreateServerInput): Server {
    // 必填校验
    if (!input.name?.trim()) throw new Error('name is required');
    if (!input.host?.trim()) throw new Error('host is required');
    if (!input.username?.trim()) throw new Error('username is required');
    if (!input.password && !input.privateKey) {
      throw new Error('Either password or privateKey must be provided');
    }

    const port = input.port ?? 22;
    if (port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${port}`);
    }

    const { db } = getDb();
    const now = Date.now();

    const newRow: NewServer = {
      id: ulid(),
      name: input.name.trim(),
      host: input.host.trim(),
      port,
      username: input.username.trim(),
      encryptedPassword: encryptOptional(input.password),
      encryptedPrivateKey: encryptOptional(input.privateKey),
      encryptedPassphrase: encryptOptional(input.passphrase),
      group: input.group?.trim() || null,
      tags: input.tags ?? [],
      description: input.description?.trim() || null,
      transportMode: input.transportMode ?? 'exec',
      commandWhitelist: input.commandWhitelist ?? [],
      commandBlacklist: input.commandBlacklist ?? [],
      allowedRemotePaths: input.allowedRemotePaths ?? [],
      socksProxy: input.socksProxy?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      db.insert(servers).values(newRow).run();
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) {
        throw new Error(`Server name already exists: ${input.name}`);
      }
      throw e;
    }

    return this.getById(newRow.id)!;
  }

  /**
   * 按 ID 查(凭证保持加密)。
   */
  getById(id: string): Server | null {
    const { db } = getDb();
    const rows = db.select().from(servers).where(eq(servers.id, id)).all();
    return rows[0] ?? null;
  }

  /**
   * 按 name 查。
   */
  getByName(name: string): Server | null {
    const { db } = getDb();
    const rows = db.select().from(servers).where(eq(servers.name, name)).all();
    return rows[0] ?? null;
  }

  /**
   * 列表(支持多维过滤 + RBAC 限制)。
   */
  list(filter: ListFilter = {}): Server[] {
    const { db } = getDb();
    const conds = [];

    if (filter.group) {
      conds.push(eq(servers.group, filter.group));
    }
    if (filter.nameLike) {
      conds.push(like(servers.name, `%${filter.nameLike}%`));
    }
    if (filter.tag) {
      // tags 是 JSON 数组,SQLite 用 LIKE 简单匹配(避免 JSON 函数依赖)
      conds.push(like(servers.tags, `%"${filter.tag}"%`));
    }
    if (filter.ids && filter.ids.length > 0) {
      const placeholders = filter.ids.map(() => '?').join(',');
      conds.push(sql`${servers.id} IN (${sql.raw(placeholders)})`);
    }

    const where = conds.length > 0 ? and(...conds) : undefined;
    return db.select().from(servers).where(where).all();
  }

  /**
   * 更新服务器。凭证字段未传则保持原值。
   */
  update(id: string, patch: UpdateServerInput): Server | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const { db } = getDb();
    const updateData: Partial<NewServer> = {
      updatedAt: Date.now(),
    };

    if (patch.name !== undefined) updateData.name = patch.name.trim();
    if (patch.host !== undefined) updateData.host = patch.host.trim();
    if (patch.port !== undefined) updateData.port = patch.port;
    if (patch.username !== undefined) updateData.username = patch.username.trim();
    if (patch.password !== undefined) {
      updateData.encryptedPassword = encryptOptional(patch.password);
    }
    if (patch.privateKey !== undefined) {
      updateData.encryptedPrivateKey = encryptOptional(patch.privateKey);
    }
    if (patch.passphrase !== undefined) {
      updateData.encryptedPassphrase = encryptOptional(patch.passphrase);
    }
    if (patch.group !== undefined) updateData.group = patch.group?.trim() || null;
    if (patch.tags !== undefined) updateData.tags = patch.tags;
    if (patch.description !== undefined) updateData.description = patch.description?.trim() || null;
    if (patch.transportMode !== undefined) updateData.transportMode = patch.transportMode;
    if (patch.commandWhitelist !== undefined) updateData.commandWhitelist = patch.commandWhitelist;
    if (patch.commandBlacklist !== undefined) updateData.commandBlacklist = patch.commandBlacklist;
    if (patch.allowedRemotePaths !== undefined) updateData.allowedRemotePaths = patch.allowedRemotePaths;
    if (patch.socksProxy !== undefined) updateData.socksProxy = patch.socksProxy?.trim() || null;

    db.update(servers).set(updateData).where(eq(servers.id, id)).run();
    return this.getById(id);
  }

  /**
   * 删除服务器(硬删)。
   */
  delete(id: string): boolean {
    const { db } = getDb();
    const result = db.delete(servers).where(eq(servers.id, id)).run();
    return result.changes > 0;
  }

  /**
   * 获取解密后的凭证(内部 API,仅 Pool 调用)。
   * 返回的明文凭证**严禁**写入日志或 audit。
   */
  getDecryptedCredentials(id: string): {
    password: string | null;
    privateKey: string | null;
    passphrase: string | null;
  } | null {
    const server = this.getById(id);
    if (!server) return null;
    return {
      password: decryptOptional(server.encryptedPassword),
      privateKey: decryptOptional(server.encryptedPrivateKey),
      passphrase: decryptOptional(server.encryptedPassphrase),
    };
  }

  /**
   * 解析 SSH 连接配置(供 SSHConnectionPool 使用)。
   */
  resolveSshConfig(id: string) {
    const server = this.getById(id);
    if (!server) return null;
    const creds = this.getDecryptedCredentials(id)!;
    return {
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      password: creds.password,
      privateKey: creds.privateKey,
      passphrase: creds.passphrase,
      socksProxy: server.socksProxy,
      transportMode: server.transportMode,
      commandWhitelist: server.commandWhitelist,
      commandBlacklist: server.commandBlacklist,
      allowedRemotePaths: server.allowedRemotePaths,
    };
  }
}

let _instance: ServerManager | null = null;

/** 获取单例。 */
export function getServerManager(): ServerManager {
  if (!_instance) _instance = new ServerManager();
  return _instance;
}
