// 云函数 account — 收款账户管理（文档 §5）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const accounts = db.collection('accounts');

/** 幂等建集合（init 未跑完时自愈） */
async function ensureCol(name) {
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    await ensureCol('accounts');
    switch (event.action) {
      case 'get':
        return await getMine(OPENID);
      case 'save':
        return await save(OPENID, event);
      case 'getByAid':
        return await getByAid(event.aid);
      default:
        return err('未知 action');
    }
  } catch (e) {
    return err('账户操作失败：' + e.message);
  }
};

async function getMine(openid) {
  const found = await accounts.where({ ownerOpenid: openid }).limit(1).get();
  return ok({ account: found.data[0] || null });
}

async function save(openid, event) {
  const accountName = String(event.accountName || '').trim().slice(0, 30);
  const payCodeFileID = String(event.payCodeFileID || '').slice(0, 200);
  if (!accountName) return err('请填写账户名称');
  if (!payCodeFileID.startsWith('cloud://')) return err('收款码图片无效');

  // 校验上传的确实是图片且可访问
  try {
    const info = await cloud.getTempFileURL({ fileList: [payCodeFileID] });
    const f = info.fileList && info.fileList[0];
    if (!f || !f.tempFileURL || f.status !== 0) return err('收款码图片不可用，请重新上传');
    if (f.fileID && /\.(png|jpe?g|webp)$/i.test(f.fileID) === false) return err('仅支持图片格式');
  } catch (e) {
    return err('收款码图片校验失败');
  }

  const theme = {
    name: String((event.theme && event.theme.name) || '默认主题').slice(0, 20),
    primary: /^#[0-9a-fA-F]{6}$/.test((event.theme || {}).primary || '') ? event.theme.primary : '#07C160',
    bg: /^#[0-9a-fA-F]{6}$/.test((event.theme || {}).bg || '') ? event.theme.bg : '#F7F7F7'
  };
  const data = { accountName, payCodeFileID, theme, updatedAt: db.serverDate() };

  const found = await accounts.where({ ownerOpenid: openid }).limit(1).get();
  if (found.data.length === 0) {
    const added = await accounts.add({ data: { ownerOpenid: openid, ...data, createdAt: db.serverDate() } });
    return ok({ account: { _id: added._id, ownerOpenid: openid, ...data } });
  }
  await accounts.doc(found.data[0]._id).update({ data });
  return ok({ account: { ...found.data[0], ...data } });
}

/** 付款方用：只返回公开字段 */
async function getByAid(aid) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(aid || ''))) return err('参数错误');
  let rec;
  try {
    rec = await accounts.doc(aid).get();
  } catch (e) {
    return err('收款账户不存在');
  }
  const a = rec.data;
  return ok({
    account: {
      _id: a._id,
      accountName: a.accountName,
      theme: a.theme || { name: '默认主题', primary: '#07C160' }
    }
  });
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
