// v3.84.2：隐私合规补强（登录页每次不勾选、宾客随礼页与宾客首页的隐私说明入口、隐私说明正文核对）与 books.getBook 排除伪造礼簿
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');

const MP = 'miniprogram/';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const OWNER = 'o-owner';
const quiet = async fn => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };

/** 加载一个页面的 Page 定义（假 wx：记录 navigateTo） */
function loadPage(rel, storage) {
  const key = require.resolve(path.join(ROOT, MP, rel));
  delete require.cache[key];
  const store = Object.assign({}, storage || {});
  const nav = [];
  const prev = { wx: global.wx, Page: global.Page, getApp: global.getApp };
  global.wx = {
    getStorageSync: k => store[k], setStorageSync: (k, v) => { store[k] = v; }, removeStorageSync: k => { delete store[k]; },
    showToast: () => {}, showModal: () => {}, navigateTo: o => nav.push(o.url)
  };
  let def;
  global.Page = d => { def = d; };
  global.getApp = () => ({ globalData: {} });
  try { require(key); } finally {
    ['wx', 'Page', 'getApp'].forEach(k => { if (prev[k] === undefined) delete global[k]; else global[k] = prev[k]; });
  }
  const page = Object.assign({ data: JSON.parse(JSON.stringify(def.data)) }, def);
  page.setData = function (o) { Object.assign(this.data, o); };
  return {
    page, store, nav,
    /** 在假 wx 下调用页面方法 */
    call(name, ...args) {
      const p = { wx: global.wx };
      global.wx = { getStorageSync: k => store[k], setStorageSync: (k, v) => { store[k] = v; }, removeStorageSync: k => { delete store[k]; }, showToast: () => {}, navigateTo: o => nav.push(o.url) };
      try { return page[name](...args); } finally { if (p.wx === undefined) delete global.wx; else global.wx = p.wx; }
    }
  };
}

test('登录页：始终不勾选（即使本地有 v3.84.0~v3.84.1 留下的同意记录）', () => {
  const L = loadPage('pages/login/login.js', { privacyAgreed: true });
  assert.strictEqual(L.page.data.agreed, false);
  L.call('onLoad');
  assert.strictEqual(L.page.data.agreed, false);
  assert.strictEqual(L.store.privacyAgreed, undefined);
  assert(!/getStorageSync\(['"]privacyAgreed/.test(read(MP + 'pages/login/login.js')), '登录页不读取本地同意记录');
});

test('登录页：勾选行点击区约 88rpx 高，勾选框仍是 36rpx', () => {
  const w = read(MP + 'pages/login/login.wxss');
  assert(/\.agree-hit \{[^}]*min-height: 88rpx/.test(w));
  assert(/\.ck \{[^}]*width: 36rpx; height: 36rpx/.test(w));
});

test('宾客随礼页：提交按钮下方有《隐私说明》链接，白事用「奠仪」，不含默认同意措辞', () => {
  const w = read(MP + 'pages/pay/pay.wxml');
  const i = w.indexOf('bindtap="onConfirmTransfer"');
  const j = w.indexOf('class="pv-note"');
  assert(i > 0 && j > i, '说明在提交按钮之后');
  const note = w.slice(j, w.indexOf('</view>', j));
  assert(note.includes("填写的姓名与{{isFuneral ? '奠仪' : '礼金'}}仅用于主家记账，详见"));
  assert(note.includes('bindtap="goPrivacy"') && note.includes('《隐私说明》'));
  assert(!/同意/.test(note));
  const P = loadPage('pages/pay/pay.js');
  P.call('goPrivacy');
  assert.deepStrictEqual(P.nav, ['/pages/privacy/privacy']);
  assert(/\.pv-note \{[^}]*text-align: center/.test(read(MP + 'pages/pay/pay.wxss')));
});

test('宾客首页：「常见问题」旁有《隐私说明》入口', () => {
  const w = read(MP + 'pages/index/index.wxml');
  const g = w.slice(w.indexOf("mode === 'guest'"));
  const faq = g.indexOf('bindtap="goFaq"');
  const pv = g.indexOf('bindtap="goPrivacy"');
  assert(faq > 0 && pv > faq && pv - faq < 200, '紧跟在常见问题之后');
  assert(/goPrivacy\(\) \{ wx\.navigateTo\(\{ url: '\/pages\/privacy\/privacy' \}\); \}/.test(read(MP + 'pages/index/index.js')));
});

test('全项目前端没有「即表示同意」「默认同意」一类文案', () => {
  const walk = (d, out) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) { if (n !== 'node_modules' && n !== '.claude') walk(p, out); } else if (/\.(js|wxml|json)$/.test(n)) out.push(p);
    }
    return out;
  };
  const RE = /即表示|即视为|视为同意|默认同意|登录即|提交即|即同意/;
  const bad = walk(path.join(ROOT, MP), []).filter(p => RE.test(fs.readFileSync(p, 'utf8')));
  assert.deepStrictEqual(bad.map(p => path.relative(ROOT, p)), []);
});

test('隐私说明正文：可见范围含记账人 / 家人、选图含封面照片、摄像头含拍摄、不读剪贴板', () => {
  const s = read(MP + 'pages/privacy/privacy.js');
  assert(!s.includes('仅对主家和宾客本人可见'));
  assert(s.includes('宾客的姓名、礼金对主家、获授权的记账人（礼台人员）和家人可见'));
  assert(s.includes('相册选图用于上传收款码和礼簿封面照片'));
  assert(/摄像头用于扫描礼簿码/.test(s));
  assert(s.includes('不读取你的剪贴板'));
  assert(s.includes('访问日志'), '云开发 traceUser 访问记录');
});

// ===== M1：books.getBook 排除带 _openid 的伪造礼簿 =====
function seed(book) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [book]);
}
function stubFiles() {
  const log = { deleted: [] };
  const origDel = sdk.deleteFile;
  sdk.deleteFile = async o => { log.deleted.push(...o.fileList); return { fileList: o.fileList.map(() => ({ status: 0 })) }; };
  sdk.openapi = { security: { imgSecCheck: async () => ({}), msgSecCheck: async () => ({}) } };
  log.restore = () => { sdk.deleteFile = origDel; sdk.openapi = {}; };
  return log;
}

test('getBook：客户端伪造的礼簿（顶层带 _openid）当作不存在——移除照片 / 改白事都不会删到别人的封面', async () => {
  const victim = 'cloud://env.b/covers/book-o-victim-1.jpg';
  const forged = { _id: 'fake1', _openid: OWNER, ownerOpenid: OWNER, name: '伪造', type: 'wedding', coverPhoto: { fileID: victim, shape: 'rect' }, createdAt: new Date() };
  seed(forged);
  let log = stubFiles();
  try {
    state.openid = OWNER;
    const r = await quiet(() => loadFunction('books').main({ action: 'setCoverPhoto', bookId: 'fake1', fileID: '' }));
    assert.notStrictEqual(r.code, 0);
    assert.deepStrictEqual(log.deleted, []);
  } finally { log.restore(); }
  seed(forged);
  log = stubFiles();
  try {
    state.openid = OWNER;
    const r = await quiet(() => loadFunction('books').main({ action: 'save', book: { _id: 'fake1', name: '伪造', type: 'funeral' }, _id: 'fake1', name: '伪造', type: 'funeral' }));
    assert.notStrictEqual(r.code, 0);
    assert.deepStrictEqual(log.deleted, []);
  } finally { log.restore(); }
});

test('getBook：正常礼簿（云函数写入、无 _openid）照常移除照片并删除文件', async () => {
  const f = `cloud://env.b/covers/book-${OWNER}-1.jpg`;
  seed({ _id: 'b1', ownerOpenid: OWNER, name: '婚礼', type: 'wedding', coverPhoto: { fileID: f, shape: 'rect' }, createdAt: new Date() });
  const log = stubFiles();
  try {
    state.openid = OWNER;
    const r = await quiet(() => loadFunction('books').main({ action: 'setCoverPhoto', bookId: 'b1', fileID: '' }));
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(log.deleted, [f]);
  } finally { log.restore(); }
});

test('trash.filesOf：伪造礼簿或伪造照片字段的封面不登记删除', () => {
  const t = require(path.join(ROOT, 'tools/cloud-shared/trash.js'));
  const own = () => false;
  const f = 'cloud://env.b/covers/book-x-1.jpg';
  assert(t.filesOf({ _id: 'b1', coverPhoto: { fileID: f } }, null, own).includes(f));
  assert(!t.filesOf({ _id: 'b1', _openid: 'x', coverPhoto: { fileID: f } }, null, own).includes(f));
  assert(!t.filesOf({ _id: 'b1', coverPhoto: { fileID: f, _openid: 'x' } }, null, own).includes(f));
  ['books', 'warmer'].forEach(fn => assert.strictEqual(read(`cloudfunctions/${fn}/trash.js`), read('tools/cloud-shared/trash.js')));
});
