// v3.77.2：礼簿页「未收到」筛选（records.list status=rejected）、待确认页「最近标记未收到」折叠逻辑
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');
const foldseen = require('../miniprogram/utils/foldseen.js');

const ROOT = path.join(__dirname, '..');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const OWNER = 'o-owner';
const DAY = 86400000;

const rec = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', payerOpenid: 'g1', payerName: '王' + id, amount: 100, payMethod: 'wechat', status: 'paid', createdAt: new Date(), ...extra });
function seed(records) {
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1', orgMode: true }])
    .seed('users', [{ openid: OWNER }, { openid: 'clerk-a' }, { openid: 'fam' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '甲', type: 'wedding' }, { _id: 'b2', ownerOpenid: OWNER, name: '乙', type: 'other' }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'clerk-a', role: 'clerk', bookIds: ['b1'], perms: ['confirm', 'desk'] },
      { _id: 'm2', aid: 'acc1', memberOpenid: 'fam', role: 'viewer', bookIds: ['b1', 'b2'] }
    ])
    .seed('records', records);
}
const list = (openid, ev) => { state.openid = openid; return loadFunction('records').main({ action: 'list', ...ev }); };
const trail = [{ at: new Date(), who: 'owner', name: '主家', act: 'reject' }];
const data = () => [
  rec('p1'), rec('t1', { status: 'transferred' }),
  rec('x1', { status: 'rejected', rejectedAt: new Date(), rejectedBy: '主家', rejectReason: 'nofound', trail }),
  rec('x2', { status: 'rejected', rejectedAt: new Date(Date.now() - 5 * DAY), appealStatus: 'kept', trail }),
  rec('x3', { status: 'rejected', rejectedAt: new Date(), bookId: 'b2', appealStatus: 'open' }),
  rec('x4', { status: 'rejected', rejectedAt: new Date(), payerName: '李四' })
];

test('list status=rejected：只返回未收到（不限 24 小时、含申诉状态与处理日志），全部 / 待确认 / 已入簿口径不变', async () => {
  seed(data());
  const r = await list(OWNER, { status: 'rejected' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(r.data.list.map(x => x._id).sort(), ['x1', 'x2', 'x3', 'x4']);
  assert.strictEqual(r.data.listTotal, 4);
  const x1 = r.data.list.find(x => x._id === 'x1');
  assert.strictEqual(x1.rejectReason, 'nofound');
  assert.ok(Array.isArray(x1.trail));
  assert.ok(!('payerOpenid' in x1));
  assert.strictEqual(r.data.list.find(x => x._id === 'x3').appealStatus, 'open');
  const all = await list(OWNER, {});
  assert.deepStrictEqual(all.data.list.map(x => x._id).sort(), ['p1', 't1']); // 「全部」不含未收到（保持现状）
  assert.deepStrictEqual((await list(OWNER, { status: 'paid' })).data.list.map(x => x._id), ['p1']);
  assert.deepStrictEqual((await list(OWNER, { status: 'confirm' })).data.list.map(x => x._id), ['t1']);
  assert.strictEqual(all.data.total, 1); // 顶部合计口径不受筛选影响
});

test('list status=rejected：礼簿筛选、关键词、排序 / 分页与现有一致', async () => {
  seed(data());
  assert.deepStrictEqual((await list(OWNER, { status: 'rejected', bookId: 'b2' })).data.list.map(x => x._id), ['x3']);
  assert.deepStrictEqual((await list(OWNER, { status: 'rejected', keyword: '李' })).data.list.map(x => x._id), ['x4']);
  const p = await list(OWNER, { status: 'rejected', pageSize: 2, page: 2, sort: 'time_asc' });
  assert.strictEqual(p.data.list.length, 2);
  assert.strictEqual(p.data.listTotal, 4);
  assert.strictEqual((await list(OWNER, { status: 'bad-value' })).data.list.length, 2); // 非法值回落到全部
});

test('list status=rejected 权限：记账人只看到自己负责（canBook）礼簿的；指定别的礼簿得空；家人共享只读看不到标记人与日志', async () => {
  seed(data());
  const c = await list('clerk-a', { status: 'rejected' });
  assert.deepStrictEqual(c.data.list.map(x => x._id).sort(), ['x1', 'x2', 'x4']); // 无 b2 的 x3
  assert.strictEqual((await list('clerk-a', { status: 'rejected', bookId: 'b2' })).data.list.length, 0);
  const v = await list('fam', { status: 'rejected' });
  assert.strictEqual(v.code, 0, v.msg);
  assert.strictEqual(v.data.list.length, 4);
  v.data.list.forEach(x => { assert.ok(!('trail' in x)); assert.ok(!('rejectedBy' in x)); });
  const stranger = await list('stranger', { status: 'rejected' });
  assert.ok(stranger.code !== 0 || stranger.data.list.length === 0);
});

test('foldseen：没见过的记录出现时展开一次；已见过的不再展开；用户收起后保持；seen 最多 200 个', () => {
  let s = foldseen.next([], ['a'], true);
  assert.deepStrictEqual([s.folded, s.opened, s.seen], [false, true, ['a']]); // 首次出现 → 展开
  s = foldseen.next(s.seen, ['a'], true); // 用户收起后，同一批不再展开
  assert.deepStrictEqual([s.folded, s.opened], [true, false]);
  s = foldseen.next(s.seen, ['a', 'b'], true); // 新增 b → 再展开一次
  assert.deepStrictEqual([s.folded, s.opened, s.seen], [false, true, ['a', 'b']]);
  s = foldseen.next(s.seen, ['a', 'b'], false); // 已展开且无新增：保持展开
  assert.deepStrictEqual([s.folded, s.opened], [false, false]);
  s = foldseen.next(['a'], [], true); // 列表为空：保持
  assert.deepStrictEqual([s.folded, s.opened], [true, false]);
  const many = Array.from({ length: 250 }, (_, i) => 'id' + i);
  assert.strictEqual(foldseen.next([], many, true).seen.length, 200);
  assert.deepStrictEqual(foldseen.next(null, ['z'], false), { folded: false, seen: ['z'], opened: false });
});

test('前端接线：礼簿页四个筛选（320 宽字号）、未收到行（原因 / 申诉 / 处理经过 / 撤销 / 去核对）；待确认页折叠并本机记住；FAQ', () => {
  const js = rd('miniprogram/pages/records/records.js');
  assert.ok(js.includes("statuses: ['全部', '待确认', '未收到', '已入簿']"));
  assert.ok(js.includes("const ST_KEYS = ['all', 'confirm', 'rejected', 'paid']"));
  const wxml = rd('miniprogram/pages/records/records.wxml');
  assert.ok(wxml.includes("item.status === 'rejected'") && wxml.includes('onUnreject') && wxml.includes('onGoAppeal') && wxml.includes('onTrail'));
  assert.ok(wxml.includes('item.canUnreject') && wxml.includes('切换{{unit}}后可撤销'));
  assert.ok(/\.st-seg \.seg-item \{[^}]*font-size: 24rpx/.test(rd('miniprogram/pages/records/records.wxss')));
  const pj = rd('miniprogram/pages/pending/pending.js');
  assert.ok(pj.includes("foldseen.next(") && pj.includes("wx.setStorageSync(REJ_FOLD_KEY"));
  assert.ok(/try \{ const f = wx\.getStorageSync\(REJ_FOLD_KEY\)/.test(pj), '读取在 try/catch 里');
  const pw = rd('miniprogram/pages/pending/pending.wxml');
  assert.ok(pw.includes('onRejFold') && pw.includes('{{rejected.length}} 笔') && pw.includes('wx:if="{{!rejFold}}"'));
  assert.ok(rd('miniprogram/pages/guide/faq.js').includes('筛选选「未收到」'));
});

test('云端 list 白名单含 rejected；LISTED 不含 REJECTED；索引沿用 owner_book_status / owner_status_time（无新增）', () => {
  const src = rd('cloudfunctions/records/index.js');
  assert.ok(src.includes("event.status === 'rejected' ? [REC.REJECTED]"));
  const st = rd('tools/cloud-shared/status.js');
  assert.ok(/const LISTED = \[REC\.PAID, REC\.TRANSFERRED, REC\.PENDING\]/.test(st));
  const sys = rd('cloudfunctions/system/index.js');
  assert.ok(sys.includes("'owner_book_status'") && sys.includes("'owner_status_time'"));
});
