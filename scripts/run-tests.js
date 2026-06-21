#!/usr/bin/env node

/**
 * 测试运行器
 * 使用 Node.js 内置的测试框架运行所有测试
 */

import { execSync } from 'child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function findTestFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...findTestFiles(p));
    } else if (name.endsWith('.test.js')) {
      out.push(p);
    }
  }
  return out;
}

const root = new URL('..', import.meta.url).pathname;
const tests = findTestFiles(join(root, 'test'));

console.log('🧪 运行测试...\n');

try {
  execSync('node scripts/build.js', {
    stdio: 'inherit',
    cwd: root
  });
  execSync(`node --test ${tests.join(' ')}`, {
    stdio: 'inherit',
    cwd: root
  });
} catch (err) {
  process.exit(1);
}
