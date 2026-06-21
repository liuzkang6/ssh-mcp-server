import { eq, and } from 'drizzle-orm';
import { ulid } from 'ulid';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/index.js';
import { operators, type Operator, type NewOperator } from '../db/schema.js';

const BCRYPT_ROUNDS = 12;
const API_KEY_PREFIX = 'sk-';

export interface CreateOperatorInput {
  type: 'human' | 'agent';
  name: string;
  /** 人类:密码;Agent:首次创建时若不传则自动生成 API Key */
  credential?: string;
  scopes?: string[];
  serverPermissions?: string[];
}

export interface UpdateOperatorInput {
  scopes?: string[];
  serverPermissions?: string[];
  enabled?: boolean;
}

export interface ListFilter {
  type?: 'human' | 'agent';
  enabled?: boolean;
}

/**
 * 统一的"操作者"管理(人 + Agent)。
 *
 * 关键设计:
 * - credentialHash 存 bcrypt(单向,不可解密)
 * - 人类登录:verifyCredential 拿明文 vs hash
 * - Agent 鉴权:同上,只是明文是 API Key
 * - rotateApiKey:Agent 可换 key(明文只返回一次)
 */
export class OperatorManager {
  /**
   * 创建操作者。
   * - 人类:必须传 credential(密码)
   * - Agent:不传则自动生成 sk-{ulid}{32 字节随机}
   *
   * 返回 { operator, plainCredential }。plainCredential 仅在创建时返回一次。
   */
  create(input: CreateOperatorInput): { operator: Operator; plainCredential: string } {
    if (!input.name?.trim()) throw new Error('name is required');
    if (!['human', 'agent'].includes(input.type)) {
      throw new Error(`Invalid type: ${input.type}`);
    }

    let plainCredential: string;
    if (input.type === 'human') {
      if (!input.credential) throw new Error('Human operator requires credential (password)');
      if (input.credential.length < 6) {
        throw new Error('Password must be at least 6 characters');
      }
      plainCredential = input.credential;
    } else {
      // Agent:用户可指定,或自动生成
      plainCredential = input.credential || this.generateApiKey();
    }

    const { db } = getDb();
    const now = Date.now();

    const newRow: NewOperator = {
      id: ulid(),
      type: input.type,
      name: input.name.trim(),
      credentialHash: bcrypt.hashSync(plainCredential, BCRYPT_ROUNDS),
      scopes: input.scopes ?? (input.type === 'human' ? ['read', 'write'] : ['read', 'write']),
      serverPermissions: input.serverPermissions ?? [],
      enabled: true,
      lastActiveAt: null,
      createdAt: now,
    };

    try {
      db.insert(operators).values(newRow).run();
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) {
        throw new Error(`Operator name already exists: ${input.name}`);
      }
      throw e;
    }

    const op = this.getById(newRow.id)!;
    return { operator: op, plainCredential };
  }

  getById(id: string): Operator | null {
    const { db } = getDb();
    const rows = db.select().from(operators).where(eq(operators.id, id)).all();
    return rows[0] ?? null;
  }

  getByName(name: string): Operator | null {
    const { db } = getDb();
    const rows = db.select().from(operators).where(eq(operators.name, name)).all();
    return rows[0] ?? null;
  }

  list(filter: ListFilter = {}): Operator[] {
    const { db } = getDb();
    const conds = [];
    if (filter.type) conds.push(eq(operators.type, filter.type));
    if (filter.enabled !== undefined) conds.push(eq(operators.enabled, filter.enabled));
    const where = conds.length > 0 ? and(...conds) : undefined;
    return db.select().from(operators).where(where).all();
  }

  /**
   * 验证凭证。统一错误信息(防用户名枚举)。
   * 不存在 / 已禁用 / 密码错都返回 false。
   */
  verifyCredential(name: string, credential: string): Operator | null {
    const op = this.getByName(name);
    if (!op || !op.enabled) {
      // 仍然跑一次 bcrypt 防时序攻击
      bcrypt.compareSync(credential, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
      return null;
    }
    const ok = bcrypt.compareSync(credential, op.credentialHash);
    if (!ok) return null;

    // 更新 lastActiveAt
    const { db } = getDb();
    db.update(operators)
      .set({ lastActiveAt: Date.now() })
      .where(eq(operators.id, op.id))
      .run();

    return op;
  }

  /**
   * 轮换 Agent 的 API Key。返回新明文 key(只此一次)。
   */
  rotateApiKey(id: string): { operator: Operator; plainCredential: string } | null {
    const op = this.getById(id);
    if (!op || op.type !== 'agent') return null;

    const newKey = this.generateApiKey();
    const { db } = getDb();
    db.update(operators)
      .set({ credentialHash: bcrypt.hashSync(newKey, BCRYPT_ROUNDS) })
      .where(eq(operators.id, id))
      .run();

    return { operator: this.getById(id)!, plainCredential: newKey };
  }

  update(id: string, patch: UpdateOperatorInput): Operator | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const { db } = getDb();
    const updateData: Partial<NewOperator> = {};
    if (patch.scopes !== undefined) updateData.scopes = patch.scopes;
    if (patch.serverPermissions !== undefined)
      updateData.serverPermissions = patch.serverPermissions;
    if (patch.enabled !== undefined) updateData.enabled = patch.enabled;
    db.update(operators).set(updateData).where(eq(operators.id, id)).run();
    return this.getById(id);
  }

  setEnabled(id: string, enabled: boolean): Operator | null {
    return this.update(id, { enabled });
  }

  delete(id: string): boolean {
    const { db } = getDb();
    const result = db.delete(operators).where(eq(operators.id, id)).run();
    return result.changes > 0;
  }

  /**
   * 生成 API Key:sk-{ulid}{32 字节 base64url}
   */
  private generateApiKey(): string {
    const tail = randomBytes(24).toString('base64url');
    return `${API_KEY_PREFIX}${ulid()}${tail}`;
  }
}

let _instance: OperatorManager | null = null;
export function getOperatorManager(): OperatorManager {
  if (!_instance) _instance = new OperatorManager();
  return _instance;
}
