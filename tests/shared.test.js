// 共享模块：status.js（状态与阈值）、common.js（返回格式 / 北京时间），以及云函数目录里相对 require 是否齐全
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const S = require('../tools/cloud-shared/status.js');
const C = require('../tools/cloud-shared/common.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('status：常量取值与数据库里已存的字符串一致（改了就会让旧数据失效）', () => {
  assert.deepStrictEqual(S.REC, { PENDING: 'pending', TRANSFERRED: 'transferred', PAID: 'paid', REJECTED: 'rejected', CANCELLED: 'cancelled', VOID: 'void' });
  assert.deepStrictEqual(S.MEMBER, { PENDING: 'pending', ACTIVE: 'active' });
  assert.deepStrictEqual(S.LISTED, ['paid', 'transferred', 'pending']);
  assert.deepStrictEqual(S.COUNTED, ['paid', 'transferred', 'pending']);
});

test('status：时间阈值与改动前一致（30 分钟 / 3 分钟 / 24 小时）', () => {
  assert.strictEqual(S.PENDING_TTL, 30 * 60 * 1000);
  assert.strictEqual(S.STALL_MS, 3 * 60 * 1000);
  assert.strictEqual(S.STALL_KEEP_MS, 24 * 3600 * 1000);
  assert.strictEqual(S.UNREJECT_MS, 24 * 3600 * 1000);
});

test('status：「待确认」口径只认 transferred（pending 是宾客还没点转账，不算）', () => {
  assert.ok(S.isToConfirm({ status: 'transferred' }));
  ['pending', 'paid', 'rejected', 'cancelled', 'void', undefined].forEach(s => assert.ok(!S.isToConfirm({ status: s }), String(s)));
  assert.ok(!S.isToConfirm(null));
});

test('common：ok / err 返回格式不变', () => {
  assert.deepStrictEqual(C.ok({ a: 1 }), { code: 0, msg: 'ok', data: { a: 1 } });
  assert.deepStrictEqual(C.ok(), { code: 0, msg: 'ok', data: undefined });
  assert.deepStrictEqual(C.err('x'), { code: 1, msg: 'x', data: null });
});

test('common：北京时间换算（跨天 / 跨月 / 跨年边界）', () => {
  assert.deepStrictEqual([C.bjDay('2026-10-23T15:59:59Z'), C.bjTime('2026-10-23T15:59:59Z'), C.bjHour('2026-10-23T15:59:59Z')], ['2026-10-23', '2026-10-23 23:59', 23]);
  assert.deepStrictEqual([C.bjDay('2026-10-23T16:00:00Z'), C.bjTime('2026-10-23T16:00:00Z'), C.bjHour('2026-10-23T16:00:00Z')], ['2026-10-24', '2026-10-24 00:00', 0]);
  assert.strictEqual(C.bjDay('2026-10-31T16:00:00Z'), '2026-11-01');
  assert.strictEqual(C.bjTime('2026-12-31T16:05:00Z'), '2027-01-01 00:05');
  assert.strictEqual(C.bjHour(new Date('2026-03-01T01:00:00Z')), 9);
  assert.strictEqual(C.bjDay(new Date('2026-03-01T01:00:00Z')), '2026-03-01');
});

test('common：与改动前各云函数里的内联算法逐一比对（北京时间计算完全不变）', () => {
  // 改动前 payment.bj / records.bjDay / export.fmtDateTime / warmer 与 records.remindDue 的写法
  const p = n => (n < 10 ? '0' + n : '' + n);
  const oldBj = d => { const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000); return { day: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, hm: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}` }; };
  const oldIso = d => new Date(d.getTime() + 8 * 3600 * 1000).toISOString();
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 5000; i++) {
    const d = new Date(Date.UTC(2020, 0, 1) + Math.floor(rnd() * 3650) * 86400000 + Math.floor(rnd() * 86400) * 1000);
    const o = oldBj(d), iso = oldIso(d);
    assert.strictEqual(C.bjDay(d), o.day);
    assert.strictEqual(C.bjTime(d), `${o.day} ${o.hm}`);
    assert.strictEqual(C.bjDay(d), iso.slice(0, 10));
    assert.strictEqual(C.bjHour(d), Number(iso.slice(11, 13)));
    assert.strictEqual(C.bjHour(d), new Date(d.getTime() + 8 * 3600 * 1000).getUTCHours());
  }
});

test('云函数目录里所有相对 require 的文件都存在（共享模块没同步到位会在冷启动时才报错）', () => {
  const missing = [];
  fs.readdirSync(path.join(ROOT, 'cloudfunctions')).forEach(fn => {
    const dir = path.join(ROOT, 'cloudfunctions', fn);
    fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('font-')).forEach(f => {
      (fs.readFileSync(path.join(dir, f), 'utf8').match(/require\('\.\/[^']+'\)/g) || []).forEach(r => {
        const rel = r.slice(9, -2);
        const target = path.join(dir, rel.endsWith('.js') || rel.endsWith('.json') ? rel : rel + '.js');
        if (!fs.existsSync(target)) missing.push(`${fn}/${f} -> ${rel}`);
      });
    });
  });
  assert.deepStrictEqual(missing, []);
});

test('云函数入口里不再有写死的记录状态字符串（统一用 status.js 常量）', () => {
  const bad = [];
  fs.readdirSync(path.join(ROOT, 'cloudfunctions')).forEach(fn => {
    const f = `cloudfunctions/${fn}/index.js`;
    read(f).split('\n').forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (ln.includes('event.status')) return; // 前端筛选参数（confirm / paid），不是记录状态
      if (/\bstatus\s*(?::|===|!==)\s*(_\.neq\()?'(pending|transferred|paid|rejected|cancelled|void|active)'/.test(ln)) bad.push(`${f}:${i + 1}`);
    });
  });
  assert.deepStrictEqual(bad, []);
});

test('前端 utils/status.js 与共享源文件一致', () => {
  assert.strictEqual(read('miniprogram/utils/status.js'), read('tools/cloud-shared/status.js'));
});

test('小程序 js 里不再有写死的记录状态字符串（wxml 模板无法引入模块，保留字面量）', () => {
  const bad = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) return walk(f);
    if (!f.endsWith('.js') || f.endsWith(path.join('utils', 'status.js'))) return;
    fs.readFileSync(f, 'utf8').split('\n').forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (/\bstatus\s*(?:===|!==|:)\s*'(pending|transferred|paid|rejected|cancelled|void)'/.test(ln)) bad.push(path.relative(ROOT, f) + ':' + (i + 1));
    });
  });
  walk(path.join(ROOT, 'miniprogram'));
  assert.deepStrictEqual(bad, []);
});
