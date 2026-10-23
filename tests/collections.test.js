// 集合清单一致性：init 的 COLLECTIONS、system 上线前检查的 REQUIRED_COLS、purge 清除目标
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const Purge = require('../tools/cloud-shared/purge.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const list = (src, name) => (src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));

const INIT = list(read('cloudfunctions/init/index.js'), 'COLLECTIONS');
const REQUIRED = list(read('cloudfunctions/system/index.js'), 'REQUIRED_COLS');

// 不属于「某个用户的数据」、清除账户时不需要删的集合（原因见注释）
const NOT_PURGED = {
  settings: '系统设置（管理员 / 预热 / 广告），不属于用户',
  admin_logs: '管理员操作日志',
  rate_limits: '限流计数（短期自清理）',
  sys_config: '往来人标识密钥，注销与清除测试数据都不能动',
  exports: 'purge.run 里单独处理（先删文件再删登记）',
  subscriptions: '用户注销保留开通记录，管理员清除时由 opts.subscription 删'
};

test('init 与 system 上线前检查的集合清单一致', () => {
  assert.ok(INIT.length >= 19, '解析到的集合数量异常');
  assert.deepStrictEqual([...INIT].sort(), [...REQUIRED].sort());
  assert.strictEqual(new Set(INIT).size, INIT.length, 'init 集合有重复');
});

test('purge 的清除目标集合都在集合清单里（含默认礼簿短码 book_codes）', () => {
  const cols = new Set(Purge.targets('o', { guestRecords: true }).map(t => t[1]));
  cols.forEach(c => assert.ok(INIT.includes(c), `purge 目标 ${c} 不在 init 清单`));
  assert.ok(cols.has('book_codes') && cols.has('trash_books') && cols.has('trash_records'));
});

test('集合清单里的每个集合：要么被 purge 清除，要么在明确的豁免名单里', () => {
  const purged = new Set(Purge.targets('o', { guestRecords: true }).map(t => t[1]));
  const uncovered = INIT.filter(c => !purged.has(c) && !NOT_PURGED[c]);
  assert.deepStrictEqual(uncovered, [], '新增集合需决定：加入 purge.targets，或在本测试 NOT_PURGED 写明原因');
  Object.keys(NOT_PURGED).forEach(c => assert.ok(INIT.includes(c), `豁免项 ${c} 已不在集合清单，请清理`));
});

test('purge 条件都只按「本人」限定，不会误删他人数据', () => {
  Purge.targets('o-me', { guestRecords: true }).forEach(([label, col, cond]) => {
    const keys = Object.keys(cond);
    assert.strictEqual(keys.length, 1, label);
    assert.ok(['ownerOpenid', 'memberOpenid', 'fromOpenid', 'payerOpenid', 'openid'].includes(keys[0]), label + ' ' + keys[0]);
    assert.ok(String(cond[keys[0]]).includes('o-me'), label);
  });
  // 默认不删「作为宾客的随礼」（属于对方礼簿）
  assert.ok(!Purge.targets('o', {}).some(t => t[1] === 'records' && t[2].payerOpenid));
});
