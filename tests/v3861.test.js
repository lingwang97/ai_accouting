// v3.86.1 界面检查 F1-F8：宾客首页新流程说明、pay 底栏占位、横滑标签 scroll-view、cash 权限、pending 标签换行、红点自动滑动、亮屏双码按窗口缩放、records 标签分行
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { ROOT } = require('./helpers/sdk-stub.js');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('F1 宾客首页说明：先转账（备注写姓名）→ 再扫礼簿码登记 → 主家核对入簿；还没转也可先登记', () => {
  const w = read('miniprogram/pages/index/index.wxml');
  assert.ok(w.includes('扫主家的收款码转账（备注写姓名）') && w.includes('再扫礼簿码，填写姓名和礼金登记') && w.includes('主家核对到账后入簿'));
  assert.ok(w.includes('还没转账也可以先登记'));
  assert.ok(!w.includes('扫描主家礼簿码') && !w.includes('按提示向主家收款码转账'));
});

test('F2 pay：底栏后有同内容隐藏占位，容器不再写死底部留白；占位不可点', () => {
  const w = read('miniprogram/pages/pay/pay.wxml');
  const s = read('miniprogram/pages/pay/pay.wxss');
  assert.ok(w.includes('pay-bar-ph') && /<button class="btn-primary" disabled>/.test(w));
  assert.ok(/\.pay-bar-ph \{[^}]*position: static[^}]*visibility: hidden[^}]*pointer-events: none/.test(s));
  assert.ok(/\.container\.has-bar \{ padding-bottom: 0/.test(s));
});

test('F3 标签条：my-gifts / records 用 scroll-view 横滑 + 右侧渐变；红点时自动滑到「有变动」', () => {
  const gw = read('miniprogram/components/my-gifts/index.wxml');
  const gj = read('miniprogram/components/my-gifts/index.js');
  assert.ok(/<scroll-view class="mg-seg" scroll-x enable-flex[^>]*scroll-into-view="\{\{segTo\}\}"/.test(gw) && gw.includes('mg-seg-fade'));
  assert.ok(gj.includes("segTo: 'mt-' + tab") && gj.includes("segTo: 'mt-changed'") && gj.includes('_dotScrolled') && gj.includes('scrollOffset'));
  const rw = read('miniprogram/pages/records/records.wxml');
  const rj = read('miniprogram/pages/records/records.js');
  assert.ok(/<scroll-view class="st-seg" scroll-x enable-flex[^>]*scroll-into-view/.test(rw) && rw.includes('st-fade') && rw.includes('bindtap="onStatus"'));
  assert.ok(rj.includes('measureSt') && rj.includes('stFade'));
});

test('F4 cash：没有修改 / 作废权限不显示剩余小时', () => {
  const j = read('miniprogram/pages/cash/cash.js');
  assert.ok(j.includes("perm.can('confirm') || perm.can('void')") && j.includes("canAmend ? require('../../utils/editlock.js').hint(r) : ''"));
});

test('F5 pending：标签行可换行，姓名至少 4 个字宽', () => {
  const s = read('miniprogram/pages/pending/pending.wxss');
  assert.ok(/\.name-row \{[^}]*flex-wrap: wrap/.test(s) && /\.name-row \.payer \{[^}]*min-width: 4em/.test(s));
});

test('F6 「开启变更提醒」点击区扩大（上下 18rpx，不撑高行）', () => {
  assert.ok(/\.mg-resub \{[^}]*padding: 18rpx 16rpx[^}]*margin-top: -18rpx/.test(read('miniprogram/components/my-gifts/index.wxss')));
});

test('F7 亮屏双码：码边长按窗口高度缩放（240-440rpx）', () => {
  const j = read('miniprogram/pages/qrcode/qrcode.js');
  const w = read('miniprogram/pages/qrcode/qrcode.wxml');
  assert.strictEqual((w.match(/width:\{\{qrRpx\}\}rpx;height:\{\{qrRpx\}\}rpx/g) || []).length, 2);
  const m = /function qrSize\(winRpx\) \{[\s\S]*?\n\}/.exec(j);
  assert.ok(m);
  const qrSize = new Function(m[0] + '; return qrSize;')();
  assert.strictEqual(qrSize(1334), 240); // iPhone SE
  assert.strictEqual(qrSize(1700), 385);
  assert.strictEqual(qrSize(2400), 440); // 平板上限
});

test('F8 records：状态类小标签单独一行，可换行', () => {
  const w = read('miniprogram/pages/records/records.wxml');
  const s = read('miniprogram/pages/records/records.wxss');
  assert.ok(w.includes('class="r-tags"') && w.includes('class="r-tg declared"') && w.includes('onAmendLog') && w.includes('onCorrect'));
  assert.ok(/\.r-tags \{[^}]*flex-wrap: wrap/.test(s));
  assert.ok(!w.includes('catchtap="onCorrect"> · '));
});

test('版本号 3.86.1', () => {
  assert.ok(/VERSION: '3\.86\.1'/.test(read('miniprogram/config.js')));
});
