import { ulid } from 'ulid';
import bcrypt from 'bcrypt';
import { getOperatorManager, type OperatorManager } from './operator-manager.js';
import type { Operator } from '../db/schema.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 鉴权服务。
 *
 * 设计:
 * - 人类:JWT(HS256,1h 过期,载荷含 operatorId / type / scopes / exp)
 * - Agent:API Key(永久,通过 OperatorManager.verifyCredential 验证)
 * - 不引入 @fastify/jwt 等第三方库,直接 HMAC-SHA256,减少依赖
 */

const JWT_TTL_SECONDS = 60 * 60; // 1h
const JWT_ALG = 'HS256';

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error('JWT_SECRET must be set and at least 16 characters');
  }
  return s;
}

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export interface JwtPayload {
  operatorId: string;
  type: 'human' | 'agent';
  scopes: string[];
  exp: number; // seconds since epoch
  iat: number;
}

export interface OperatorContext {
  operator: Operator;
  isAgent: boolean;
  scopes: string[];
  hasScope(scope: string): boolean;
  canAccessServer(serverId: string): boolean;
}

export class AuthService {
  constructor(private opManager: OperatorManager = getOperatorManager()) {}

  /**
   * 人类登录:用户名 + 密码 → JWT
   */
  loginAsHuman(name: string, password: string): { token: string; operator: Operator } | null {
    const op = this.opManager.verifyCredential(name, password);
    if (!op || op.type !== 'human') return null;
    const token = this.signJwt({
      operatorId: op.id,
      type: 'human',
      scopes: op.scopes,
    });
    return { token, operator: op };
  }

  /**
   * 验证 JWT → OperatorContext
   */
  verifyJwt(token: string): OperatorContext | null {
    const payload = this.verifyJwtToken(token);
    if (!payload) return null;
    const op = this.opManager.getById(payload.operatorId);
    if (!op || !op.enabled) return null;
    return this.toContext(op);
  }

  /**
   * 验证 API Key(Agent) → OperatorContext
   */
  verifyApiKey(key: string): OperatorContext | null {
    if (!key.startsWith('sk-')) return null;
    const op = this.opManager.verifyCredential(
      // API Key 没有 name,只能遍历(慢但安全)
      // 优化:用 hash 前缀查 DB
      this.lookupNameByApiKeyPrefix(key) ?? '',
      key
    );
    if (!op || op.type !== 'agent') return null;
    return this.toContext(op);
  }

  /**
   * 从 Bearer token 字符串("Bearer xxx")中提取 token,自动判断 JWT / API Key。
   */
  verifyBearer(authHeader: string | undefined): OperatorContext | null {
    if (!authHeader) return null;
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const token = m[1].trim();
    if (token.startsWith('sk-')) {
      return this.verifyApiKey(token);
    }
    return this.verifyJwt(token);
  }

  // ── JWT 内部实现 ──

  private signJwt(payload: Omit<JwtPayload, 'exp' | 'iat'>): string {
    const now = Math.floor(Date.now() / 1000);
    const fullPayload: JwtPayload = {
      ...payload,
      iat: now,
      exp: now + JWT_TTL_SECONDS,
    };
    const header = { alg: JWT_ALG, typ: 'JWT' };
    const headerB64 = base64url(JSON.stringify(header));
    const payloadB64 = base64url(JSON.stringify(fullPayload));
    const signature = this.hmacSign(`${headerB64}.${payloadB64}`);
    return `${headerB64}.${payloadB64}.${signature}`;
  }

  private verifyJwtToken(token: string): JwtPayload | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sig] = parts;
    const expectedSig = this.hmacSign(`${headerB64}.${payloadB64}`);
    if (!this.safeEqual(sig, expectedSig)) return null;

    let payload: JwtPayload;
    try {
      payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));
    } catch {
      return null;
    }

    if (typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  }

  private hmacSign(data: string): string {
    return base64url(
      createHmac('sha256', getSecret()).update(data).digest()
    );
  }

  private safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }

  /**
   * API Key 前缀查 owner(优化:避免每次 verifyCredential 扫全表)。
   * 当前是简化实现:每次都扫全表。生产可加 api_key_prefix 列。
   */
  private apiKeyCache = new Map<string, string>(); // key → operator name

  private lookupNameByApiKeyPrefix(key: string): string | null {
    if (this.apiKeyCache.has(key)) {
      return this.apiKeyCache.get(key)!;
    }
    // 退化:扫全表 agent,用 bcrypt 比对明文 key vs credentialHash
    // bcrypt 单次 ~100ms,agent 数量小(MVP)可接受
    const agents = this.opManager.list({ type: 'agent' });
    for (const a of agents) {
      if (bcrypt.compareSync(key, a.credentialHash)) {
        this.apiKeyCache.set(key, a.name);
        return a.name;
      }
    }
    return null;
  }

  // ── Context 构造 ──

  private toContext(op: Operator): OperatorContext {
    return {
      operator: op,
      isAgent: op.type === 'agent',
      scopes: op.scopes,
      hasScope: (scope: string) => op.scopes.includes(scope),
      canAccessServer: (serverId: string) => {
        if (op.scopes.includes('admin')) return true;
        const perms = op.serverPermissions ?? [];
        if (perms.length === 0) return true; // 空 = 全部
        return perms.includes(serverId);
      },
    };
  }
}

let _instance: AuthService | null = null;
export function getAuthService(): AuthService {
  if (!_instance) _instance = new AuthService();
  return _instance;
}
