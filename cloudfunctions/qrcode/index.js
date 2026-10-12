// 云函数 qrcode — 生成收款专属小程序码（文档 §5、§6.2）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    if (event.action !== 'gen') return err('未知 action');

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(event.aid || ''))) return err('参数错误');
    const db = cloud.database();
    const accounts = db.collection('accounts');
    const account = (await accounts.doc(event.aid).get()).data;
    if (!account || account.ownerOpenid !== OPENID) return err('无权生成该账户二维码');

    // scene 最长 32 字符：aid=xxx
    const scene = 'aid=' + event.aid;
    if (scene.length > 32) return err('账户 ID 过长');

    const wxacode = await cloud.openapi.wxacode.getUnlimited({
      scene,
      page: 'pages/pay/pay',
      width: 430,
      checkPath: false,          // 未发布阶段允许生成
      // 跟随调用方版本：开发版/体验版生成的码扫后打开对应版本，发布后为正式版
      envVersion: ['develop', 'trial', 'release'].includes(event.envVersion) ? event.envVersion : 'release'
    });

    if (!wxacode.buffer) return err('小程序码生成失败（检查 AppID 是否为正式号）');

    const upload = await cloud.uploadFile({
      cloudPath: `qrcodes/${event.aid}-${Date.now()}.png`,
      fileContent: wxacode.buffer
    });
    return ok({ fileID: upload.fileID });
  } catch (e) {
    // 测试号无 openapi 权限时走此分支
    const msg = e.errCode === -1 || /openapi|40029|41004/i.test(String(e.errMsg || e.message))
      ? '测试号无法调用小程序码接口，请使用正式 AppID，或扫码收款码图片联调'
      : '生成失败：' + (e.errMsg || e.message);
    return err(msg);
  }
};

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
