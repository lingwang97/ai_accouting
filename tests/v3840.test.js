// v3.84.0：隐私授权合规（微信审核「默认自动同意」被拒）——登录页勾选、未同意拦截、官方隐私弹窗、低基础库静默兼容
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MP = 'miniprogram/';

/** 加载一份干净的 utils/privacy.js（隔离模块状态），wx 用传入的假对象 */
function loadPrivacy(wxObj) {
  const key = require.resolve(path.join(ROOT, MP, 'utils/privacy.js'));
  delete require.cache[key];
  const prev = global.wx;
  global.wx = wxObj;
  const m = require(key);
  return {
    m,
    restore() {
      if (prev === undefined) delete global.wx; else global.wx = prev;
      delete require.cache[key];
    }
  };
}

/** 加载登录页：捕获 Page 定义，用假 wx / getApp */
function loadLogin(opts) {
  const key = require.resolve(path.join(ROOT, MP, 'pages/login/login.js'));
  const pkey = require.resolve(path.join(ROOT, MP, 'utils/privacy.js'));
  delete require.cache[key]; delete require.cache[pkey];
  const store = Object.assign({}, opts.storage || {});
  const prev = { wx: global.wx, Page: global.Page, getApp: global.getApp };
  const modals = [];
  global.wx = {
    getStorageSync: k => store[k],
    setStorageSync: (k, v) => { store[k] = v; },
    removeStorageSync: k => { delete store[k]; },
    showToast: () => {},
    showModal: o => { modals.push(o); if (o.success) o.success({ confirm: opts.confirm !== false }); },
    navigateTo: () => {}
  };
  let def;
  global.Page = d => { def = d; };
  global.getApp = () => ({ globalData: {} });
  require(key);
  const page = Object.assign({ data: JSON.parse(JSON.stringify(def.data)) }, def);
  page.setData = function (o) { Object.assign(this.data, o); };
  return {
    page, modals, store,
    restore() {
      ['wx', 'Page', 'getApp'].forEach(k => { if (prev[k] === undefined) delete global[k]; else global[k] = prev[k]; });
      delete require.cache[key]; delete require.cache[pkey];
    }
  };
}

test('登录页：没有「即表示」类默认同意文案，有「我已阅读并同意」勾选', () => {
  const w = read(MP + 'pages/login/login.wxml');
  assert(!/即表示|登录即|默认同意/.test(w), '不应出现默认同意文案');
  assert(w.includes('我已阅读并同意'));
  assert(w.includes('goPrivacy'), '《隐私说明》可点开');
  assert(w.includes('toggleAgree'));
});

test('登录页：勾选框默认未勾选', () => {
  const L = loadLogin({});
  try {
    assert.strictEqual(L.page.data.agreed, false);
    L.page.onLoad();
    assert.strictEqual(L.page.data.agreed, false, '没有本地记录时仍未勾选');
  } finally { L.restore(); }
});

test('登录页：勾选后记在本地，下次进入保持勾选；取消勾选清除记录', () => {
  const L = loadLogin({});
  try {
    L.page.onLoad();
    L.page.toggleAgree();
    assert.strictEqual(L.page.data.agreed, true);
    assert.strictEqual(L.store.privacyAgreed, true);
    L.page.toggleAgree();
    assert.strictEqual(L.page.data.agreed, false);
    assert.strictEqual(L.store.privacyAgreed, undefined);
  } finally { L.restore(); }
  const L2 = loadLogin({ storage: { privacyAgreed: true } });
  try { L2.page.onLoad(); assert.strictEqual(L2.page.data.agreed, true); } finally { L2.restore(); }
});

test('登录页：未同意点登录被拦截——弹窗文案与按钮合规；取消则不登录；同意则勾上并继续', async () => {
  const L = loadLogin({ confirm: false });
  try {
    L.page.onLoad();
    L.page.setData({ nickname: '张三' });
    await L.page.onSubmit();
    assert.strictEqual(L.modals.length, 1);
    const m = L.modals[0];
    assert.strictEqual(m.content, '请先阅读并同意《隐私说明》');
    assert.strictEqual(m.confirmText, '同意');
    assert.strictEqual(m.cancelText, '取消');
    assert(m.confirmText.length <= 4 && m.cancelText.length <= 4);
    assert.strictEqual(L.page.data.submitting, false, '取消后停住，没有进入登录');
    assert.strictEqual(L.page.data.agreed, false);
  } finally { L.restore(); }
  const L2 = loadLogin({ confirm: true });
  try {
    L2.page.onLoad();
    L2.page.setData({ nickname: '' }); // 同意后继续走原有校验（昵称为空只提示，不会越过）
    await L2.page.onSubmit();
    assert.strictEqual(L2.page.data.agreed, true, '点同意就勾上');
    assert.strictEqual(L2.store.privacyAgreed, true);
  } finally { L2.restore(); }
});

test('登录页：未同意时头像按钮不是 chooseAvatar、昵称框禁用且有点击拦截；同意后才是 chooseAvatar', () => {
  const w = read(MP + 'pages/login/login.wxml');
  const m = w.match(/<button[^>]*open-type="chooseAvatar"[^>]*>/g) || [];
  assert.strictEqual(m.length, 1, '只有一处 chooseAvatar');
  assert(/wx:if="\{\{agreed\}\}"/.test(m[0]), 'chooseAvatar 仅在已同意时渲染');
  assert(/wx:else[^>]*bindtap="onNeedAgree"/.test(w), '未同意时的头像按钮走同意弹窗');
  assert(/disabled="\{\{!agreed\}\}"/.test(w));
  assert(/type="\{\{agreed \? 'nickname' : 'text'\}\}"/.test(w), '未同意时不是 nickname 类型');
  assert(/nick-mask" wx:if="\{\{!agreed\}\}" bindtap="onNeedAgree"/.test(w));
  const L = loadLogin({});
  try {
    L.page.onLoad();
    L.page.onChooseAvatar({ detail: { avatarUrl: 'x' } });
    assert.strictEqual(L.page.data.avatar, '', '未同意不接收头像');
  } finally { L.restore(); }
});

test('app.json 有 __usePrivacyCheck__；app.js 启动时接管隐私授权事件', () => {
  const j = JSON.parse(read(MP + 'app.json'));
  assert.strictEqual(j.__usePrivacyCheck__, true);
  const a = read(MP + 'app.js');
  assert(/utils\/privacy\.js'\)\.init\(\)/.test(a));
  assert(a.indexOf("privacy.js').init()") < a.indexOf('if (!wx.cloud)'), '在基础库检查之前注册');
});

test('隐私弹窗组件：agreePrivacyAuthorization 按钮 + agree / disagree 回调 + 隐私说明入口', () => {
  const w = read(MP + 'components/privacy-popup/index.wxml');
  assert(/open-type="agreePrivacyAuthorization"/.test(w));
  assert(/bindagreeprivacyauthorization="onAgree"/.test(w));
  assert(/id="agree-btn"/.test(w));
  assert(/bindtap="onDisagree"/.test(w) && /bindtap="goPrivacy"/.test(w) && /openContract/.test(w));
  const js = read(MP + 'components/privacy-popup/index.js');
  assert(/buttonId: 'agree-btn', event: 'agree'/.test(js));
  assert(/event: 'disagree'/.test(js));
  assert(/typeof wx\.openPrivacyContract === 'function'/.test(js), '没有官方接口时不显示入口');
  const css = read(MP + 'components/privacy-popup/index.wxss');
  assert(/var\(--primary/.test(css), '颜色跟随主题');
  assert(!/\bgap\s*:/.test(css), '不用 gap');
});

test('所有触发隐私接口的页面都挂了 privacy-popup', () => {
  const APIS = /wx\.(chooseMedia|chooseImage|saveImageToPhotosAlbum|getClipboardData|setClipboardData|openBluetoothAdapter|scanCode)\b|open-type="chooseAvatar"|type="nickname"|receipt\.saveImage\(|printer\.(printRecord|printQrTest|printTest|printBorderSample)|ble\.(openAdapter|connect)/;
  const dir = path.join(ROOT, MP, 'pages');
  const bad = [];
  let hit = 0;
  const walk = d => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|wxml)$/.test(n)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (!APIS.test(src)) continue;
      hit++;
      const base = p.replace(/\.(js|wxml)$/, '');
      const w = fs.readFileSync(base + '.wxml', 'utf8');
      const j = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
      if (!/<privacy-popup\s*\/>/.test(w) || !(j.usingComponents || {})['privacy-popup']) bad.push(path.relative(ROOT, base));
    }
  };
  walk(dir);
  assert(hit >= 10, '应扫到足够多的页面，实际 ' + hit);
  assert.deepStrictEqual([...new Set(bad)], []);
});

test('低基础库（无 onNeedPrivacyAuthorization）：init 静默返回 false，不报错', () => {
  const P = loadPrivacy({});
  try {
    assert.strictEqual(P.m.supported(), false);
    assert.doesNotThrow(() => assert.strictEqual(P.m.init(), false));
    assert.strictEqual(P.m.localAgreed(), false, '没有 getStorageSync 也不抛');
    assert.doesNotThrow(() => P.m.setLocalAgreed(true));
  } finally { P.restore(); }
});

test('有接口时：init 注册回调；事件交给当前弹窗；弹窗晚登记时接手排队事件', () => {
  let cb = null;
  const P = loadPrivacy({ onNeedPrivacyAuthorization: f => { cb = f; } });
  try {
    assert.strictEqual(P.m.init(), true);
    assert.strictEqual(typeof cb, 'function');
    const got = [];
    const inst = { open: (r, info) => got.push([r, info]) };
    P.m.setCurrent(inst);
    const r1 = () => {};
    cb(r1, { referrer: 'x' });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0][0], r1);
    P.m.clearCurrent(inst);
    const r2 = () => {};
    cb(r2, {});
    const inst2 = { open: r => got.push([r]) };
    P.m.setCurrent(inst2);
    assert.strictEqual(got[got.length - 1][0], r2);
    P.m.clearCurrent(inst2);
  } finally { P.restore(); }
});

test('没人接手时 resolve 收到 disagree（不会一直挂起）', async () => {
  let cb = null;
  const P = loadPrivacy({ onNeedPrivacyAuthorization: f => { cb = f; } });
  try {
    P.m.init();
    let r = null;
    cb(x => { r = x; }, {});
    await new Promise(res => setTimeout(res, 2200));
    assert.deepStrictEqual(r, { event: 'disagree' });
  } finally { P.restore(); }
});
