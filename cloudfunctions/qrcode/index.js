// 云函数 qrcode — 生成收款专属小程序码（文档 §5、§6.2）；action=app 生成电子回执上的小程序首页码
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const ENVS = ['develop', 'trial', 'release'];
const { resolveCtx, canBook, readonly, trusted } = require('./ctx.js');

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return err('未获取到用户身份');
  try {
    if (event.action === 'app') return await appCode(event.envVersion);
    if (event.action !== 'gen') return err('未知 action');

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(event.aid || ''))) return err('参数错误');
    const db = cloud.database();
    const accounts = db.collection('accounts');
    const account = (await accounts.doc(event.aid).get()).data;
    // 主家本人或其记账人可生成
    const ctx = await resolveCtx(db, OPENID);
    if (readonly(ctx)) return err('家人共享为只读，不能出示礼簿码');
    if (!trusted(account) || account.ownerOpenid !== ctx.ownerOpenid) return err('无权生成该账户二维码');

    // 本场礼簿码（机构版多场同时办）：scene 用礼簿 id，宾客扫码后直接记入这一场
    let scene = event.aid;
    let book = null;
    if (event.bookId) {
      try { book = (await db.collection('books').doc(String(event.bookId)).get()).data; } catch (e) { /* 不存在 */ }
      if (!trusted(book) || book.ownerOpenid !== ctx.ownerOpenid || !canBook(ctx, book._id)) return err('礼簿不存在');
      scene = book._id;
    } else if (ctx.bookIds) {
      return err('你只负责部分场次，请在场次里生成本场礼簿码');
    }
    // scene 最长 32 字符，云数据库 _id 本身就是 32 位，因此直接用 id 作 scene（不加 "aid=" 前缀）
    if (scene.length > 32) return err('账户 ID 过长，无法生成小程序码');

    const wxacode = await cloud.openapi.wxacode.getUnlimited({
      scene,
      page: 'pages/pay/pay',
      width: 430,
      checkPath: false,          // 未发布阶段允许生成
      // 跟随调用方版本：开发版/体验版生成的码扫后打开对应版本，发布后为正式版
      envVersion: ENVS.includes(event.envVersion) ? event.envVersion : 'release'
    });

    if (!wxacode.buffer) return err('小程序码生成失败（检查 AppID 是否为正式号）');

    // 固定文件名（同一礼簿码、同一版本覆盖写入），避免每次生成都留下新文件
    const env = ENVS.includes(event.envVersion) ? event.envVersion : 'release';
    const upload = await cloud.uploadFile({
      cloudPath: `qrcodes/${scene}-${env}.png`,
      fileContent: wxacode.buffer
    });
    // 本场礼簿码页面显示本场主家与本场收款码（礼台人员读不到主家上传的图片，由这里生成链接）
    let payCodeUrl = '';
    if (book) {
      try {
        const t = await cloud.getTempFileURL({ fileList: [book.payCodeFileID || account.payCodeFileID] });
        payCodeUrl = (t.fileList[0] && t.fileList[0].status === 0 && t.fileList[0].tempFileURL) || '';
      } catch (e) { /* 预览失败不影响 */ }
    }
    return ok({
      fileID: upload.fileID,
      book: book ? { _id: book._id, name: book.name, type: book.type, hostName: book.hostName || '' } : null,
      payCodeUrl
    });
  } catch (e) {
    // 测试号无 openapi 权限时走此分支
    const msg = e.errCode === -1 || /openapi|40029|41004/i.test(String(e.errMsg || e.message))
      ? '测试号无法调用小程序码接口，请使用正式 AppID，或扫码收款码图片联调'
      : '生成失败：' + (e.errMsg || e.message);
    return err(msg);
  }
};

/**
 * 小程序首页码（宾客与主家都可获取）：每个版本只生成一次，fileID 存 settings 集合
 * 返回临时链接，前端直接显示 / 下载画到回执图片上
 */
async function appCode(envVersion) {
  const env = ENVS.includes(envVersion) ? envVersion : 'release';
  const db = cloud.database();
  const settings = db.collection('settings');
  const docId = 'appcode_' + env;
  let fileID = '';
  try {
    const d = (await settings.doc(docId).get()).data;
    if (trusted(d)) fileID = d.fileID; // 客户端伪造的记录忽略，重新生成并覆盖
  } catch (e) { /* 尚未生成 */ }
  if (!fileID) {
    const wxacode = await cloud.openapi.wxacode.getUnlimited({
      scene: 'from=receipt',
      page: 'pages/index/index',
      width: 280,
      checkPath: false,
      envVersion: env
    });
    if (!wxacode.buffer) return err('小程序码生成失败');
    fileID = (await cloud.uploadFile({ cloudPath: `qrcodes/app-${env}.png`, fileContent: wxacode.buffer })).fileID;
    try { await db.createCollection('settings'); } catch (e) { /* 已存在 */ }
    await settings.doc(docId).set({ data: { fileID, createdAt: new Date() } });
  }
  const t = await cloud.getTempFileURL({ fileList: [{ fileID, maxAge: 24 * 3600 }] });
  const f = t.fileList && t.fileList[0];
  if (!f || f.status !== 0) return err('小程序码读取失败');
  return ok({ url: f.tempFileURL });
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
