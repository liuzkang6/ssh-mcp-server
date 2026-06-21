import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from 'node:crypto';

/**
 * AES-256-GCM 加解密工具。
 *
 * 主密钥来自环境变量 ENCRYPTION_KEY(base64 编码的 32 字节)。
 * 输出格式:base64(nonce[12] || ciphertext || tag[16])
 */

const KEY_LENGTH = 32; // AES-256
const NONCE_LENGTH = 12; // GCM 标准
const TAG_LENGTH = 16;

let _key: Buffer | null = null;

/**
 * 读取并校验主密钥。启动时必须调用一次。
 * 缺/错则抛错,进程应立即退出。
 */
export function loadMasterKey(envVar = 'ENCRYPTION_KEY'): Buffer {
  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(
      `Missing required environment variable: ${envVar}. ` +
        `Generate with: openssl rand -base64 32`
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch (e) {
    throw new Error(`Failed to decode ${envVar} as base64: ${(e as Error).message}`);
  }

  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `${envVar} must decode to ${KEY_LENGTH} bytes (got ${key.length}). ` +
        `Generate with: openssl rand -base64 32`
    );
  }

  _key = key;
  return key;
}

/**
 * 获取已加载的主密钥。如未加载则尝试加载。
 */
function getKey(): Buffer {
  if (!_key) {
    loadMasterKey();
  }
  return _key!;
}

/**
 * 加密明文 → base64 字符串。
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = gcm(key, nonce);
  const ciphertext = cipher.encrypt(new TextEncoder().encode(plaintext));

  // ciphertext 已经包含 tag(noble ciphers 实现)
  return Buffer.concat([nonce, ciphertext]).toString('base64');
}

/**
 * 解密 base64 字符串 → 明文。
 */
export function decrypt(encoded: string): string {
  const key = getKey();
  const buf = Buffer.from(encoded, 'base64');

  if (buf.length <= NONCE_LENGTH) {
    throw new Error('Ciphertext too short');
  }

  const nonce = buf.subarray(0, NONCE_LENGTH);
  const ciphertext = buf.subarray(NONCE_LENGTH);

  const decipher = gcm(key, nonce);
  const plaintext = decipher.decrypt(ciphertext);
  return new TextDecoder().decode(plaintext);
}

/**
 * 安全地加密(空字符串返回 null,不报错)。
 */
export function encryptOptional(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') return null;
  return encrypt(plaintext);
}

/**
 * 安全地解密(null/空 返回 null)。
 */
export function decryptOptional(encoded: string | null | undefined): string | null {
  if (encoded == null || encoded === '') return null;
  try {
    return decrypt(encoded);
  } catch {
    return null;
  }
}

/**
 * 重置内部状态(仅用于测试)。
 */
export function _resetForTesting() {
  _key = null;
}
