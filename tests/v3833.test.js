// v3.83.3：封面照片清理链路（清除全部测试数据 / 管理员删礼簿 / 记账人上传的旧照 / 改白事）、保存失败核对、服务端大小上限
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
const ADMIN = 'o-admin';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

function seed(b1) {
  db.reset()
    .seed('settings', [{ _id: 'admins', openids: [ADMIN] }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: 'u-clerk2', currentAid: 'acc1' }])
    .seed('members', [{ _id: 'm2', aid: 'acc1', memberOpenid: 'u-clerk2', role: 'clerk', allBooks: true, perms: ['books'] }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '婚礼', type: 'wedding', statReady: true, statCount: 0, statFen: 0, createdAt: new Date(), ...(b1 || {}) }]);
}

/** 记录 deleteFile 与 doc().update；download 固定返回 buf */
function stub(buf) {
  const log = { deleted: [], updates: [] };
  const origCol = db.collection.bind(db);
  db.collection = name => {
    const c = origCol(name);
    const od = c.doc;
    c.doc = id => { const d = od(id); const ou = d.update; d.update = async o => { log.updates.push({ name, id, data: o.data }); return ou ? ou.call(d, o) : { stats: { updated: 1 } }; }; return d; };
    return c;
  };
  const origDel = sdk.deleteFile, origTmp = sdk.getTempFileURL;
  sdk.deleteFile = async o => { log.deleted.push(...o.fileList); return { fileList: o.fileList.map(() => ({ status: 0 })) }; };
  sdk.getTempFileURL = async o => ({ fileList: o.fileList.map(f => ({ fileID: f, status: 0, tempFileURL: 'https://tmp.example/x.jpg' })) });
  sdk.openapi = { security: { imgSecCheck: async () => ({}), msgSecCheck: async () => ({}) } };
  state.download = async () => (buf === undefined ? JPG : buf);
  log.restore = () => { db.collection = origCol; sdk.deleteFile = origDel; sdk.getTempFileURL = origTmp; sdk.openapi = {}; };
  return log;
}
const run = async (fn, openid, body) => { state.openid = openid; return quiet(() => fn.main(body)); };

test('中2：记账人上传的封面，主家更换 / 移除时旧文件也会删除（只认 covers/ 目录）', async () => {
  const clerkFile = 'cloud://env.b/covers/book-u-clerk2-5.jpg';
  seed({ coverPhoto: { fileID: clerkFile, shape: 'rect' } });
  let log = stub();
  try {
    const fn = loadFunction('books');
    const r = await run(fn, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: `cloud://env.b/covers/book-${OWNER}-9.jpg` });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(log.deleted.includes(clerkFile), '记账人上传的旧照片删除');
  } finally { log.restore(); }
  seed({ coverPhoto: { fileID: clerkFile, shape: 'rect' } });
  log = stub();
  try {
    const r = await run(loadFunction('books'), OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: '' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(log.deleted, [clerkFile]);
  } finally { log.restore(); }
  // 库里不是 covers/ 目录的值（不该出现）：不删
  seed({ coverPhoto: { fileID: 'cloud://env.b/paycodes/x.png', shape: 'rect' } });
  log = stub();
  try {
    await run(loadFunction('books'), OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: '' });
    assert.deepStrictEqual(log.deleted, []);
  } finally { log.restore(); }
});

test('低3：服务端封面上限 1.6MB（超过拒绝并删文件）；导出读取同一上限', async () => {
  seed();
  const big = Buffer.concat([JPG, Buffer.alloc(Math.ceil(1.6 * 1024 * 1024))]);
  const log = stub(big);
  try {
    const f = `cloud://env.b/covers/book-${OWNER}-7.jpg`;
    const r = await run(loadFunction('books'), OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: f });
    assert.ok(/太大/.test(r.msg), r.msg);
    assert.deepStrictEqual(log.deleted, [f]);
  } finally { log.restore(); }
  assert.ok(/const COVER_MAX = 1\.6 \* 1024 \* 1024/.test(read('cloudfunctions/books/index.js')));
  assert.ok(/buf\.length <= 1\.6 \* 1024 \* 1024/.test(fs.readFileSync(path.join(ROOT, 'cloudfunctions/export/index.js'), 'latin1')));
});

test('中3：coverPhotoUrl 带 fileID 时回 is（只回布尔，不回路径）', async () => {
  const f = `cloud://env.b/covers/book-${OWNER}-3.jpg`;
  seed({ coverPhoto: { fileID: f, shape: 'oval' } });
  const log = stub();
  try {
    const fn = loadFunction('books');
    let r = await run(fn, OWNER, { action: 'coverPhotoUrl', bookId: 'b1', fileID: f });
    assert.strictEqual(r.data.is, true);
    assert.ok(!JSON.stringify(r.data).includes('cloud://'));
    r = await run(fn, OWNER, { action: 'coverPhotoUrl', bookId: 'b1', fileID: `cloud://env.b/covers/book-${OWNER}-4.jpg` });
    assert.strictEqual(r.data.is, false);
    r = await run(fn, OWNER, { action: 'coverPhotoUrl', bookId: 'b1' });
    assert.strictEqual(r.data.is, false);
  } finally { log.restore(); }
  // 前端：网络失败先核对；云端拒绝才删；核对失败不删
  const s = read('miniprogram/pages/booktheme/booktheme.js');
  assert.ok(/if \(!req\.isNetErr\(e\)\) throw e;/.test(s));
  assert.ok(/saved = !!\(await req\.bookCoverUrl\(d\.id, fileID\)\)\.is/.test(s));
  assert.ok(/if \(saved === true\) return done\(\);/.test(s));
  assert.ok(/if \(saved === null\) kept = true;/.test(s));
  assert.ok(/if \(fileID && !kept\) wx\.cloud\.deleteFile/.test(s));
  assert.ok(/bookCoverUrl: \(bookId, fileID\) =>/.test(read('miniprogram/utils/request.js')));
});

test('低1：礼簿改成白事时移除封面照片并删文件；其他改动不动照片', async () => {
  const f = `cloud://env.b/covers/book-${OWNER}-2.jpg`;
  seed({ coverPhoto: { fileID: f, shape: 'rect' } });
  db.applyUpdates = true; // 让 where().update 真正写入（看 coverPhoto 是否移除）
  let log = stub();
  try {
    const r = await run(loadFunction('books'), OWNER, { action: 'save', book: { _id: 'b1', name: '婚礼', type: 'wedding', location: '' } });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(log.deleted, []);
  } finally { log.restore(); }
  seed({ coverPhoto: { fileID: f, shape: 'rect' } });
  db.applyUpdates = true; // 让 where().update 真正写入（看 coverPhoto 是否移除）
  log = stub();
  try {
    const r = await run(loadFunction('books'), OWNER, { action: 'save', book: { _id: 'b1', name: '婚礼', type: 'funeral', location: '' } });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(log.deleted, [f]);
    const b = (await db.collection('books').doc('b1').get()).data;
    assert.ok(!b.coverPhoto, '库里的 coverPhoto 已移除');
    assert.strictEqual(b.type, 'funeral');
  } finally { log.restore(); }
  db.applyUpdates = false;
  // 前端确认文案：按钮不超过 4 字
  const s = read('miniprogram/pages/bookedit/bookedit.js');
  assert.ok(/白事礼簿不使用封面照片，已设置的照片会移除/.test(s));
  assert.ok(/confirmText: '继续', cancelText: '取消'/.test(s));
  assert.ok(/hadCover: !!b\.coverPhoto/.test(s));
});

test('中1：管理员删礼簿、清除全部测试数据都删封面照片文件（只认 covers/，伪造的忽略）', async () => {
  const f = `cloud://env.b/covers/book-${OWNER}-1.jpg`;
  seed({ coverPhoto: { fileID: f, shape: 'rect' } });
  db.seed('books', [{ _id: 'b2', ownerOpenid: OWNER, name: '假', coverPhoto: { fileID: 'cloud://env.b/covers/x.jpg', _openid: 'evil' } }]);
  let log = stub();
  try {
    state.openid = ADMIN;
    const r = await quiet(() => loadFunction('system').main({ action: 'adminPurgeBook', bookId: 'b1', confirmName: '婚礼' }));
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(log.deleted.includes(f));
  } finally { log.restore(); }
  seed({ coverPhoto: { fileID: f, shape: 'rect' } });
  db.seed('books', [{ _id: 'b2', ownerOpenid: OWNER, name: '假', coverPhoto: { fileID: 'cloud://env.b/covers/x.jpg', _openid: 'evil' } }]);
  log = stub();
  try {
    state.openid = ADMIN;
    const r = await quiet(() => loadFunction('system').main({ action: 'adminWipeAll', confirmText: '清除全部测试数据', keepAdmins: false }));
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(log.deleted.includes(f), '清除全部测试数据删封面');
    assert.ok(!log.deleted.includes('cloud://env.b/covers/x.jpg'), '伪造文档的不删');
  } finally { log.restore(); }
});

test('低4：purge.fileIds 的封面条件同时看礼簿与照片字段的 _openid，且 field 取 _openid', () => {
  const s = read('tools/cloud-shared/purge.js');
  assert.ok(/b\.coverPhoto && !b\._openid && !b\.coverPhoto\._openid && /.test(s));
  assert.ok(/field\(\{ _id: true, _openid: true,/.test(s), 'field 取 _openid，伪造判断才生效');
});

test('版本号 3.83.3', () => {
  assert.ok(/VERSION: '3\.83\.3'/.test(read('miniprogram/config.js')));
});
