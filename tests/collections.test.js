// 集合清单一致性：collections.js（init / system 上线前检查共用）、purge 清除目标、云函数副本
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const Purge = require('../tools/cloud-shared/purge.js');
const { COLLECTIONS, NOT_PURGED } = require('../tools/cloud-shared/collections.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('init 与 system 上线前检查都引用共享的 collections.js，没有各自写死清单', () => {
  assert.ok(COLLECTIONS.length >= 19 && new Set(COLLECTIONS).size === COLLECTIONS.length);
  assert.ok(/require\('\.\/collections\.js'\)/.test(read('cloudfunctions/init/index.js')));
  assert.ok(/require\('\.\/collections\.js'\)/.test(read('cloudfunctions/system/index.js')));
  assert.ok(!/const (COLLECTIONS|REQUIRED_COLS) = \[/.test(read('cloudfunctions/init/index.js') + read('cloudfunctions/system/index.js')));
});

test('purge 的清除目标集合都在集合清单里（含默认礼簿短码 book_codes）', () => {
  const cols = new Set(Purge.targets('o', { guestRecords: true }).map(t => t[1]));
  cols.forEach(c => assert.ok(COLLECTIONS.includes(c), `purge 目标 ${c} 不在集合清单`));
  assert.ok(cols.has('book_codes') && cols.has('trash_books') && cols.has('trash_records'));
});

test('集合清单里的每个集合：要么被 purge 清除，要么在 NOT_PURGED 里写明原因', () => {
  const purged = new Set(Purge.targets('o', { guestRecords: true }).map(t => t[1]));
  const uncovered = COLLECTIONS.filter(c => !purged.has(c) && !NOT_PURGED[c]);
  assert.deepStrictEqual(uncovered, [], '新增集合需决定：加入 purge.targets，或在 collections.js 的 NOT_PURGED 写明原因');
  Object.keys(NOT_PURGED).forEach(c => assert.ok(COLLECTIONS.includes(c), `豁免项 ${c} 已不在集合清单，请清理`));
});

test('purge 条件都只按「本人」限定，不会误删他人数据（_id 须含本人 openid，如 rate_limits 的 nc_<openid>）', () => {
  Purge.targets('o-me', { guestRecords: true }).forEach(([label, col, cond]) => {
    const keys = Object.keys(cond);
    assert.strictEqual(keys.length, 1, label);
    assert.ok(['ownerOpenid', 'memberOpenid', 'fromOpenid', 'payerOpenid', 'openid', '_id'].includes(keys[0]), label + ' ' + keys[0]);
    assert.ok(String(cond[keys[0]]).includes('o-me'), label);
  });
  // 默认不删「作为宾客的随礼」（属于对方礼簿）
  assert.ok(!Purge.targets('o', {}).some(t => t[1] === 'records' && t[2].payerOpenid));
});

test('代码里用到的集合都在清单里（防止新增集合忘了登记）', () => {
  const used = new Set();
  ['account', 'books', 'export', 'login', 'payment', 'qrcode', 'records', 'renqing', 'warmer', 'system'].forEach(fn => {
    (read(`cloudfunctions/${fn}/index.js`).match(/collection\('([a-z_]+)'\)/g) || []).forEach(m => used.add(m.match(/'([a-z_]+)'/)[1]));
  });
  const unknown = [...used].filter(c => !COLLECTIONS.includes(c) && c !== 'printtpl');
  assert.deepStrictEqual(unknown, []);
});
