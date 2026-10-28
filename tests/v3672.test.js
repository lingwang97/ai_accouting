// v3.67.2：头像存云文件 + 失败回落、昵称取最终值、机构模式称呼统一、白事去 emoji
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const root = path.join(__dirname, '../miniprogram');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const avatar = require('../miniprogram/utils/avatar.js');
const orgtext = require('../miniprogram/utils/orgtext.js');

test('avatar：临时路径视为无效，cloud:// 与 https 有效', () => {
  assert.strictEqual(avatar.isValid('cloud://env.xx/avatars/a.jpg'), true);
  assert.strictEqual(avatar.isValid('https://thirdwx.qlogo.cn/x/132'), true);
  assert.strictEqual(avatar.isValid('http://tmp/abc.jpg'), false);
  assert.strictEqual(avatar.isValid('wxfile://tmp_abc.jpg'), false);
  assert.strictEqual(avatar.isValid('https://tmp/abc.jpg'), false);
  assert.strictEqual(avatar.isValid(''), false);
  assert.strictEqual(avatar.safe('http://tmp/abc.jpg'), '');
  assert.strictEqual(avatar.safe('cloud://a/b.jpg'), 'cloud://a/b.jpg');
});

test('avatar.upload：走 wx.cloud.uploadFile，路径在 avatars/ 下，返回 fileID', async () => {
  let seen = null;
  global.getApp = () => ({ globalData: { openid: 'oABCDEFGHIJKLMNOP' } });
  global.wx = { cloud: { uploadFile: o => { seen = o; o.success({ fileID: 'cloud://x/' + o.cloudPath }); } } };
  const id = await avatar.upload('http://tmp/a.jpg');
  assert.ok(/^avatars\/.+\.jpg$/.test(seen.cloudPath));
  assert.ok(id.startsWith('cloud://'));
  assert.strictEqual(seen.filePath, 'http://tmp/a.jpg');
});

test('orgtext：机构模式替换礼簿 / 记账人，固定名称不动；普通模式原样', () => {
  assert.strictEqual(orgtext.t('当前礼簿', false), '当前礼簿');
  assert.strictEqual(orgtext.t('当前礼簿', true), '当前场次');
  assert.strictEqual(orgtext.t('记账人', true), '礼台人员');
  assert.strictEqual(orgtext.t('合计和礼簿页对不上？重算整本礼簿的合计', true), '合计和礼簿页对不上？重算整本场次的合计');
  assert.strictEqual(orgtext.t('传统礼簿 PDF 需选择一本礼簿整本导出', true), '传统礼簿 PDF 需选择一本场次整本导出');
  assert.strictEqual(orgtext.t('礼簿码 / 礼簿共享 / 礼簿类型', true), '礼簿码 / 礼簿共享 / 礼簿类型');
});

test('orgtext.wxs 与 orgtext.js 结果一致，且不含 wxs 不支持的语法', () => {
  const src = read('utils/orgtext.wxs');
  assert.ok(!/=>|\blet\b|\bconst\b|`/.test(src), 'wxs 只能用 ES5');
  const m = { exports: {} };
  new Function('module', src)(m);
  ['当前礼簿', '其他礼簿', '记账人', '礼簿码 礼簿共享 传统礼簿 礼簿页 礼簿类型', '你负责的礼簿已结束', '全部礼簿'].forEach(s => {
    [true, false].forEach(o => assert.strictEqual(m.exports.t(s, o), orgtext.t(s, o), s));
  });
});

test('机构模式用词：各页引入 wxs，且页面有 org 标志', () => {
  const pages = { books: 'orgMode', members: 'orgMode', cash: 'orgMode', index: 'account.orgMode', reconcile: 'org', export: 'org', printset: 'org', receiptset: 'org', bookdetail: 'orgMode' };
  Object.keys(pages).forEach(p => {
    const w = read(`pages/${p}/${p}.wxml`);
    assert.ok(/<wxs module="o" src="\/utils\/orgtext\.wxs">/.test(w), p);
    assert.ok(w.indexOf(pages[p]) >= 0, p);
  });
  ['reconcile', 'export', 'printset', 'receiptset'].forEach(p => assert.ok(/org: !!\(acc0 && acc0\.orgMode\)/.test(read(`pages/${p}/${p}.js`)), p));
});

test('登录：昵称失焦 / 审核回调取最终值；头像上传 fileID', () => {
  const w = read('pages/login/login.wxml');
  assert.ok(/bindblur="onNicknameBlur"/.test(w) && /bindnicknamereview=/.test(w));
  const j = read('pages/login/login.js');
  assert.ok(/avatarUtil\.upload/.test(j) && /onNicknameBlur/.test(j));
});

test('头像显示：mine 点头像可重选；members / bookshare / login 的 image 有 binderror 回落', () => {
  assert.ok(/open-type="chooseAvatar"/.test(read('pages/mine/mine.wxml')));
  assert.ok(/onChooseAvatar/.test(read('pages/mine/mine.js')));
  for (const f of ['pages/members/members.wxml', 'pages/bookshare/bookshare.wxml', 'pages/login/login.wxml', 'pages/mine/mine.wxml']) {
    read(f).split('\n').filter(l => /<image[^>]*avatar/.test(l) && !/avatar-default\.png" \/>/.test(l.replace(/\{\{[^}]*\}\}/g, ''))).forEach(l => assert.ok(/binderror=/.test(l), `${f}: ${l.trim().slice(0, 80)}`));
  }
});

test('白事：cash / pay / pending / bookdetail 不再出现固定 emoji 与「随礼人」', () => {
  const c = read('pages/cash/cash.wxml');
  assert.ok(/funeral \? "致奠人" : "随礼人"/.test(c));
  assert.ok(!/<view class="chip[^>]*>💵/.test(c));
  const p = read('pages/pay/pay.wxml');
  assert.ok(!/⚠️/.test(p));
  assert.ok(/wx:if="\{\{!isFuneral\}\}">❌/.test(p) && /wx:if="\{\{!isFuneral\}\}">📷/.test(p));
  assert.ok(!/>💵 现金/.test(read('pages/pending/pending.wxml')) && !/>💵 现金/.test(read('pages/bookdetail/bookdetail.wxml')));
});
