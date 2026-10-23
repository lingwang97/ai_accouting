// 前端 request.js 与云函数 action 清单对照；payment 新增 action 必须同时进 OWNER_ACTIONS 和 NEED
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strs = s => (s.match(/'([^']+)'/g) || []).map(x => x.slice(1, -1));

/** 云函数入口里能识别的 action：case 'x' / action === 'x' / action !== 'x' / [...].includes(event.action) */
function cloudActions(fn) {
  const src = read(`cloudfunctions/${fn}/index.js`);
  const set = new Set();
  (src.match(/case '([\w]+)'/g) || []).forEach(m => set.add(m.slice(6, -1)));
  (src.match(/action\s*[=!]==\s*'([\w]+)'/g) || []).forEach(m => set.add(m.match(/'([\w]+)'/)[1]));
  src.split('\n').filter(l => /\.includes\(event\.action\)/.test(l)).forEach(l => strs(l.slice(0, l.indexOf('.includes'))).forEach(a => set.add(a)));
  set.delete('__warm');
  return set;
}
const FUNCS = ['account', 'books', 'export', 'fontsetup', 'login', 'payment', 'printtpl', 'qrcode', 'records', 'renqing', 'system'];
const ACTIONS = Object.fromEntries(FUNCS.map(f => [f, cloudActions(f)]));
const allActions = new Set(FUNCS.flatMap(f => [...ACTIONS[f]]));

const req = read('miniprogram/utils/request.js');
const READ = (() => {
  const m = req.match(/const READ_ACTIONS = \[([\s\S]*?)\];/);
  assert.ok(m, '找不到 READ_ACTIONS');
  return strs(m[1].replace(/\/\/.*$/gm, ''));
})();

/** request.js 里每个 call('函数', {action: ...}) 用到的 [函数, action] */
const CALLS = [];
req.split('\n').forEach(line => {
  const m = line.match(/call\('(\w+)',/);
  if (!m || m[1] === 'export') return; // export 的 d 由页面传入（format / action）
  (line.match(/action:\s*([^,}]*)/g) || []).forEach(a => strs(a).forEach(s => CALLS.push([m[1], s])));
});

test('识别到云函数 action 与前端调用（防止解析失效导致用例空跑）', () => {
  assert.ok(allActions.size > 60, 'action 数量异常: ' + allActions.size);
  assert.ok(READ.length > 30 && CALLS.length > 60, `READ=${READ.length} CALLS=${CALLS.length}`);
  ['confirm', 'amend', 'unreject'].forEach(a => assert.ok(ACTIONS.payment.has(a), a));
});

test('request.js 调用的每个 action 在对应云函数里都有处理（防漏注册）', () => {
  // login 云函数：除 check 外一律走登录（默认分支，没有 case 'login'）
  const missing = CALLS.filter(([fn, a]) => !ACTIONS[fn].has(a) && !(fn === 'login' && a === 'login')).map(([fn, a]) => `${fn}.${a}`);
  assert.deepStrictEqual([...new Set(missing)], []);
});

test('READ_ACTIONS 里的每一项都对应真实存在的云函数 action（防拼写错误）', () => {
  assert.deepStrictEqual(READ.filter(a => !allActions.has(a)), []);
});

test('READ_ACTIONS 不含写操作（写操作需触发「数据已变化」标记）', () => {
  const WRITE = /^(save|set|delete|add|update|confirm|reject|void|cashEntry|amend|create|approve|remove|archive|purge|transfer|unreject|dismiss|mark|recalc|resume|cancel|leave|accept|backup|cleanup)/i;
  assert.deepStrictEqual(READ.filter(a => WRITE.test(a) && !/Preview$/.test(a)), []);
});

test('READ_ACTIONS 与前端 request.js 中的只读封装一致：无重复项', () => {
  assert.strictEqual(new Set(READ).size, READ.length);
});

test('payment：OWNER_ACTIONS 与 NEED 的键完全一致，且都有 case 处理', () => {
  const src = read('cloudfunctions/payment/index.js');
  const owner = strs(src.match(/const OWNER_ACTIONS = \[([^\]]*)\]/)[1]);
  const needBody = src.match(/const NEED = \{([^\n]*)\};/)[1];
  const need = (needBody.match(/(\w+):\s*(?:'|\[)/g) || []).map(x => x.replace(/:.*$/, ''));
  assert.deepStrictEqual([...owner].sort(), [...need].sort());
  owner.forEach(a => assert.ok(ACTIONS.payment.has(a), '缺少 case ' + a));
});

test('payment：只有 OWNER_ACTIONS 之外的 action 才是宾客端动作，二者不重叠', () => {
  const src = read('cloudfunctions/payment/index.js');
  const owner = new Set(strs(src.match(/const OWNER_ACTIONS = \[([^\]]*)\]/)[1]));
  const guestSide = ['create', 'transferred', 'cancel', 'status', 'receipt', 'myReceipts'];
  guestSide.forEach(a => { assert.ok(ACTIONS.payment.has(a), a); assert.ok(!owner.has(a), a + ' 不应在 OWNER_ACTIONS'); });
});
