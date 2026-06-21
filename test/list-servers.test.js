import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatServerList } from '../packages/server/dist/tools/list-servers.js';

describe('List Servers Tool', () => {
  it('没有配置时应返回友好提示', () => {
    assert.strictEqual(
      formatServerList([]),
      'No SSH servers visible to the current operator.'
    );
  });

  it('应返回可读摘要和原始 JSON', () => {
    const output = formatServerList([
      {
        id: '01HXXX',
        name: 'dev',
        host: '192.168.1.100',
        port: 22,
        username: 'root',
        group: 'dev',
        tags: ['linux'],
        description: 'dev box',
        transportMode: 'exec',
        commandWhitelistCount: 2,
        commandBlacklistCount: 1,
      },
    ]);

    assert.match(output, /Visible SSH servers \(RBAC filtered\):/);
    assert.match(output, /dev \| root@192\.168\.1\.100:22/);
    assert.match(output, /group=dev/);
    assert.match(output, /transport=exec/);
    assert.match(output, /whitelist=2/);
    assert.match(output, /blacklist=1/);
    assert.match(output, /Raw JSON:/);
    assert.match(output, /"name": "dev"/);
  });

  it('不应泄露加密字段名', () => {
    const output = formatServerList([
      {
        id: '01HXXX',
        name: 'dev',
        host: '1.2.3.4',
        port: 22,
        username: 'root',
        group: null,
        tags: [],
        description: null,
        transportMode: 'exec',
        commandWhitelistCount: 0,
        commandBlacklistCount: 0,
      },
    ]);
    assert.doesNotMatch(output, /encrypted/);
    assert.doesNotMatch(output, /password/i);
    assert.doesNotMatch(output, /private_?key/i);
  });
});
