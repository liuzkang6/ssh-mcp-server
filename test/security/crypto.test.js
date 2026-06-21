// test/security/crypto.test.js
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// 生成测试用的 32 字节 base64 key
const TEST_KEY = Buffer.alloc(32, 1).toString('base64'); // 32 bytes of 0x01
process.env.ENCRYPTION_KEY = TEST_KEY;

const { encrypt, decrypt, encryptOptional, decryptOptional, loadMasterKey, _resetForTesting } =
  await import('../../packages/server/dist/security/crypto.js');

describe('crypto', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  test('round-trip: encrypt → decrypt 还原原文', () => {
    const plain = 'hello world 你好世界';
    const enc = encrypt(plain);
    assert.notEqual(enc, plain);
    assert.ok(enc.length > 0);
    const dec = decrypt(enc);
    assert.strictEqual(dec, plain);
  });

  test('空字符串加解密', () => {
    const enc = encrypt('');
    const dec = decrypt(enc);
    assert.strictEqual(dec, '');
  });

  test('特殊字符:换行、引号、SQL 注入', () => {
    const plain = "line1\nline2\n--DROP TABLE--;';";
    const enc = encrypt(plain);
    const dec = decrypt(enc);
    assert.strictEqual(dec, plain);
  });

  test('每次加密输出不同(随机 nonce)', () => {
    const plain = 'same text';
    const enc1 = encrypt(plain);
    const enc2 = encrypt(plain);
    assert.notStrictEqual(enc1, enc2, '同明文应该产生不同密文(随机 nonce)');
    assert.strictEqual(decrypt(enc1), plain);
    assert.strictEqual(decrypt(enc2), plain);
  });

  test('损坏的密文抛错', () => {
    // base64 解码后太短(< nonce 长度),触发 "too short"
    assert.throws(() => decrypt('aGVsbG8='), /too short/);
    // 长度正确但密文无效,GCM tag 验证失败
    assert.throws(() => decrypt(Buffer.alloc(40, 0).toString('base64')), /decrypt|tag|invalid|integrity/i);
  });

  test('太短的密文抛错', () => {
    const short = Buffer.alloc(5).toString('base64');
    assert.throws(() => decrypt(short), /too short/);
  });

  test('encryptOptional: null/空 返回 null', () => {
    assert.strictEqual(encryptOptional(null), null);
    assert.strictEqual(encryptOptional(undefined), null);
    assert.strictEqual(encryptOptional(''), null);
    assert.notStrictEqual(encryptOptional('hello'), null);
  });

  test('decryptOptional: null/空/坏数据 返回 null', () => {
    assert.strictEqual(decryptOptional(null), null);
    assert.strictEqual(decryptOptional(undefined), null);
    assert.strictEqual(decryptOptional(''), null);
    assert.strictEqual(decryptOptional('corrupt-data'), null);
  });

  test('loadMasterKey: 缺少环境变量抛错', () => {
    delete process.env.ENCRYPTION_KEY;
    _resetForTesting();
    assert.throws(() => loadMasterKey(), /Missing required/);
  });

  test('loadMasterKey: 长度不对抛错', () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    _resetForTesting();
    assert.throws(() => loadMasterKey(), /must decode to 32 bytes/);
  });
});
