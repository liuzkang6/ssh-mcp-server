/**
 * 审计日志的脱敏工具。
 *
 * 规则:
 * - 替换 password=xxx / passphrase=xxx 为 password=***
 * - 移除 BEGIN PRIVATE KEY ... END PRIVATE KEY 整段
 * - 移除 Bearer xxx(保留 Bearer *** 形式)
 */

const PATTERNS: Array<{ regex: RegExp; replace: string | ((m: string) => string) }> = [
  // password=secret123 → password=***
  {
    regex: /(password\s*=\s*)([^\s,;'"]+)/gi,
    replace: '$1***',
  },
  // passphrase=xxx → passphrase=***
  {
    regex: /(passphrase\s*=\s*)([^\s,;'"]+)/gi,
    replace: '$1***',
  },
  // Bearer abc.def.ghi → Bearer ***
  {
    regex: /(Bearer\s+)([A-Za-z0-9_\-\.]+)/g,
    replace: '$1***',
  },
  // 整段 PEM 私钥
  {
    regex: /-----BEGIN[^-]+PRIVATE KEY-----[\s\S]*?-----END[^-]+PRIVATE KEY-----/g,
    replace: '***REDACTED PRIVATE KEY***',
  },
  // ssh-rsa / ssh-ed25519 公钥行
  {
    regex: /(ssh-(?:rsa|dss|ed25519|ecdsa)\s+)[A-Za-z0-9+\/=]+/g,
    replace: '$1***',
  },
];

/**
 * 脱敏单条字符串。
 */
export function sanitize(input: string | null | undefined): string | null {
  if (input == null) return null;

  let result = input;
  for (const { regex, replace } of PATTERNS) {
    result = result.replace(regex, replace as string);
  }
  return result;
}

/**
 * 截断 + 脱敏组合。用于审计 output/error 字段。
 */
export function sanitizeAndTruncate(
  input: string | null | undefined,
  maxLength = 10 * 1024 // 10KB
): string | null {
  if (input == null) return null;

  let result = sanitize(input);
  if (result == null) return null;

  if (result.length > maxLength) {
    result = result.substring(0, maxLength) + '...[truncated]';
  }
  return result;
}
