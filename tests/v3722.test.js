// v3.72.2：上线前检查增强（system.adminPreflight 逐项、__meta 内存 / 超时 / 云调用权限探测、手动清单、心跳）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const meta = require('../tools/cloud-shared/meta.js');
const local = require('../miniprogram/pages/admin/preflight.js');
const { COLLECTIONS } = require('../tools/cloud-shared/collections.js');

const ADMIN = 'o-admin-000001';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const quiet = async fn => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };

test('期望配置与 config.json 一致：超时、云调用权限；各函数入口都接了 __meta', () => {
  const src = read('cloudfunctions/system/index.js');
  const T = JSON.parse(src.match(/const EXPECT_TIMEOUT = (\{[^}]*\})/)[1].replace(/(\w+):/g, '"$1":'));
  Object.keys(T).forEach(fn => assert.strictEqual(JSON.parse(read(`cloudfunctions/${fn}/config.json`)).timeout, T[fn], fn));
  const map = { MSG: 'security.msgSecCheck', IMG: 'security.imgSecCheck', SUB: 'subscribeMessage.send', WXA: 'wxacode.getUnlimited' };
  const A = src.match(/const EXPECT_APIS = \{([^}]*)\}/)[1];
  for (const fn of Object.keys(T)) {
    const m = A.match(new RegExp(fn + ': \\[([^\\]]*)\\]'));
    const want = m ? m[1].split(',').map(s => map[s.trim()]) : [];
    const cfg = JSON.parse(read(`cloudfunctions/${fn}/config.json`));
    assert.deepStrictEqual(want.slice().sort(), ((cfg.permissions && cfg.permissions.openapi) || []).slice().sort(), fn);
    const idx = read(`cloudfunctions/${fn}/index.js`);
    assert.ok(/exports\.main = async \(event, context\) => \{\s*\/\/[^\n]*\n\s*if \(event && event\.action === '__meta'\)/.test(idx), fn + ' 入口第一句处理 __meta');
    if (fn !== 'system') assert.ok(idx.includes(`handle(cloud, event, context, [${want.map(a => `'${a}'`).join(', ')}])`), fn + ' __meta 探测的权限与 config.json 一致');
  }
});

test('手机端集合清单与 collections.js 一致', () => {
  const src = read('miniprogram/pages/admin/admin.js');
  const list = JSON.parse(src.match(/const COLS_OF = \(\) => (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.deepStrictEqual(list, COLLECTIONS);
});

test('meta.runtimeOf：优先 context（内存 MB、超时毫秒→秒），其次环境变量，取不到为 0', () => {
  assert.deepStrictEqual(meta.runtimeOf({ memory_limit_in_mb: 1024, time_limit_in_ms: 60000 }, {}), { memory: 1024, timeout: 60 });
  assert.deepStrictEqual(meta.runtimeOf({}, { SCF_FUNCTIONMEMORYSIZE: '256', SCF_FUNCTIONTIMEOUT: '20' }), { memory: 256, timeout: 20 });
  assert.deepStrictEqual(meta.runtimeOf(null, {}), { memory: 0, timeout: 0 });
});

function fakeOpenapi(mode) {
  const deny = () => Promise.reject(Object.assign(new Error('-604101 function has no permission'), { errCode: -604101 }));
  sdk.openapi = {
    security: { msgSecCheck: mode === 'deny' ? deny : async () => ({ result: { suggest: 'pass' } }), imgSecCheck: mode === 'deny' ? deny : async () => ({}) },
    subscribeMessage: { send: mode === 'deny' ? deny : () => Promise.reject(Object.assign(new Error('invalid template id'), { errCode: 40037 })) },
    wxacode: { getUnlimited: mode === 'deny' ? deny : async () => ({ buffer: Buffer.alloc(4) }) }
  };
}

test('__meta：无凭据只返回内存 / 超时；有效凭据才探测，40037 等业务错误算已开通，-604101 算未开通', async () => {
  const ctx = { memory_limit_in_mb: 256, time_limit_in_ms: 20000, function_name: 'payment' };
  const APIS = ['security.msgSecCheck', 'security.imgSecCheck', 'subscribeMessage.send', 'wxacode.getUnlimited'];
  fakeOpenapi('ok');
  db.reset();
  let r = await meta.handle(sdk, { action: '__meta' }, ctx, APIS);
  assert.deepStrictEqual(r.data, { fn: 'payment', memory: 256, timeout: 20, perms: null });
  const nonce = 'metanonce_' + 'a'.repeat(24);
  db.seed('settings', [{ _id: nonce, kind: 'metaprobe', createdAt: Date.now(), openid: ADMIN }]);
  r = await meta.handle(sdk, { action: '__meta', nonce }, ctx, APIS);
  assert.deepStrictEqual(r.data.perms, { 'security.msgSecCheck': 'ok', 'security.imgSecCheck': 'ok', 'subscribeMessage.send': 'ok', 'wxacode.getUnlimited': 'ok' });
  fakeOpenapi('deny');
  r = await meta.handle(sdk, { action: '__meta', nonce }, ctx, APIS);
  assert.ok(Object.values(r.data.perms).every(v => v === 'denied'));
  // 伪造 / 过期凭据不探测
  db.reset().seed('settings', [{ _id: nonce, _openid: 'x', kind: 'metaprobe', createdAt: Date.now(), openid: ADMIN }]);
  assert.strictEqual((await meta.handle(sdk, { action: '__meta', nonce }, ctx, APIS)).data.perms, null);
  db.reset().seed('settings', [{ _id: nonce, kind: 'metaprobe', createdAt: Date.now() - 5 * 60 * 1000, openid: ADMIN }]);
  assert.strictEqual((await meta.handle(sdk, { action: '__meta', nonce }, ctx, APIS)).data.perms, null);
  sdk.openapi = {};
});

test('各云函数 __meta 不需要用户身份、不读写业务数据（warmer 也不被定时触发限制挡住）', async () => {
  for (const fn of ['account', 'records', 'warmer', 'renqing']) {
    db.reset(); db.log.length = 0;
    state.openid = '';
    const r = await loadFunction(fn).main({ action: '__meta' }, { memory_limit_in_mb: 256, time_limit_in_ms: 20000 });
    assert.strictEqual(r.code, 0, fn + ' ' + r.msg);
    assert.strictEqual(r.data.timeout, 20);
    assert.strictEqual(db.log.length, 0, fn);
  }
  state.openid = 'tester';
});

function adminDb() {
  db.reset()
    .seed('settings', [{ _id: 'admins', openids: [ADMIN] }])
    .seed('users', [{ openid: ADMIN, nickname: '老王' }]);
  db.persist = true;
  state.openid = ADMIN;
}

test('adminPreflight：逐项返回 ok/bad/warn 与怎么修；无运行记录的触发器、未响应的函数、未建索引都被列出；保存摘要', async () => {
  adminDb();
  const calls = [];
  const orig = sdk.callFunction;
  sdk.callFunction = async o => {
    calls.push(o);
    if (o.name === 'printtpl') throw new Error('FUNCTION_NOT_FOUND');
    if (o.name === 'export') return { result: { code: 0, data: { fn: 'export', memory: 256, timeout: 60, perms: null } } };
    if (o.data.action === '__meta') return { result: { code: 0, data: { fn: o.name, memory: 256, timeout: 60, perms: null } } };
    return { result: { code: 0, data: null } };
  };
  let r;
  try { r = await quiet(() => loadFunction('system').main({ action: 'adminPreflight' }, { memory_limit_in_mb: 256, time_limit_in_ms: 60000 })); } finally { sdk.callFunction = orig; }
  assert.strictEqual(r.code, 0, r.msg);
  const by = l => r.data.items.find(x => x.label === l) || r.data.items.find(x => x.label.startsWith(l));
  assert.strictEqual(by('warmer 触发器').status, 'bad');
  assert.ok(by('warmer 触发器').fix.includes('上传触发器'));
  assert.strictEqual(by('索引').status, 'warn');
  assert.strictEqual(by('WX_APPSECRET').status, 'bad');
  assert.strictEqual(by('export').status, 'bad', 'export 内存 256 < 1024');
  assert.ok(by('export').text.includes('1024'));
  assert.strictEqual(by('account').status, 'warn', '读不到云调用权限结果：建议核对');
  assert.strictEqual(by('旧函数 printtpl').status, 'ok');
  assert.ok(r.data.items.every(x => ['ok', 'bad', 'warn', 'manual'].includes(x.status) && x.group && x.label));
  // __meta 调用都带了一次性凭据，且用完删除
  const nonce = calls.find(c => c.data.action === '__meta').data.nonce;
  assert.ok(/^metanonce_[0-9a-f]{24}$/.test(nonce));
  assert.ok(calls.filter(c => c.data.action === '__meta').every(c => c.data.nonce === nonce));
  // 摘要写入 settings.preflight_last，供管理员页顶部提醒
  const last = db.data.settings.find(d => d._id === 'preflight_last');
  assert.strictEqual(last.bad, r.data.bad);
  assert.ok(!JSON.stringify(r.data).includes(ADMIN), '不返回 openid');
});

test('adminPreflight：伪造的 person_key、缺字段的 settings.plans、管理员过多都会提示', async () => {
  adminDb();
  db.seed('sys_config', [{ _id: 'person_key', _openid: 'x', secret: 'y'.repeat(64) }]);
  db.seed('settings', [{ _id: 'plans', free: { name: '免费版', features: { maxBooks: 3 } } }]);
  db.data.settings.find(d => d._id === 'admins').openids = [ADMIN, 'a2', 'a3'];
  const r = await quiet(() => loadFunction('system').main({ action: 'adminPreflight' }, {}));
  const by = l => r.data.items.find(x => x.label.startsWith(l));
  assert.strictEqual(by('往来人标识密钥').status, 'bad');
  assert.strictEqual(by('套餐定义').status, 'warn');
  assert.ok(by('套餐定义').text.includes('pro（整个套餐）'));
  assert.ok(by('套餐定义').text.includes('peakMode'));
  assert.strictEqual(by('管理员人数').status, 'warn');
});

test('上线前手动清单：只有管理员能勾选，记录勾选人昵称与时间，不返回 openid；未知项拒绝', async () => {
  adminDb();
  let r = await loadFunction('system').main({ action: 'adminChecklist' });
  assert.ok(r.data.list.length >= 10 && r.data.list.every(x => !x.done));
  r = await loadFunction('system').main({ action: 'adminCheckItem', key: 'printer', done: true });
  const it = r.data.list.find(x => x.key === 'printer');
  assert.strictEqual(it.done, true);
  assert.strictEqual(it.byName, '老王');
  assert.ok(it.at);
  assert.ok(!JSON.stringify(r.data).includes(ADMIN));
  assert.strictEqual((await loadFunction('system').main({ action: 'adminCheckItem', key: 'nope', done: true })).msg, '参数错误');
  state.openid = 'someone';
  assert.strictEqual((await loadFunction('system').main({ action: 'adminCheckItem', key: 'printer', done: false })).msg, '无管理员权限');
  // adminGet 带回清单与上次摘要
  state.openid = ADMIN;
  const g = await loadFunction('system').main({ action: 'adminGet' });
  assert.strictEqual(g.data.checklist.find(x => x.key === 'printer').done, true);
});

test('warmer 写心跳（10 分钟内同一实例只写一次）；export cleanup 记录运行时间；一键建索引记录结果', async () => {
  db.reset(); db.persist = true;
  state.openid = '';
  const w = loadFunction('warmer');
  await quiet(() => w.main({ Type: 'Timer' }));
  const n1 = db.data.settings.filter(d => d._id === 'warmer_beat').length;
  assert.strictEqual(n1, 1);
  db.log.length = 0;
  await quiet(() => w.main({ Type: 'Timer' }));
  assert.ok(!db.log.some(l => l.col === 'settings' && l.cond && l.cond._id === 'warmer_beat'));
  state.openid = 'tester';
  assert.ok(read('cloudfunctions/export/index.js').includes("doc('export_cleanup_beat').set("));
  assert.ok(read('cloudfunctions/system/index.js').includes("P.writeSetting(db, 'index_status'"));
});

test('手机端检测：版本比较、集合试读（-502003 已锁 / 能读未锁 / 不存在）', async () => {
  assert.ok(local.compareVersion('2.21.2', '2.21.2') === 0);
  assert.ok(local.compareVersion('2.9.0', '2.21.2') < 0);
  assert.ok(local.compareVersion('3.0.1', '2.21.2') > 0);
  const fake = mode => ({ collection: () => ({ limit: () => ({ get: o => (mode === 'open' ? o.success({ data: [] }) : o.fail(mode === 'locked' ? { errCode: -502003, errMsg: 'permission denied' } : { errCode: -502005, errMsg: 'collection not exist' })) }) }) });
  assert.strictEqual(await local.probeOne(fake('open'), 'x'), 'open');
  assert.strictEqual(await local.probeOne(fake('locked'), 'x'), 'locked');
  assert.strictEqual(await local.probeOne(fake('missing'), 'x'), 'missing');
});
