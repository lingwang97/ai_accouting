// 云函数 account — 收款账户管理（文档 §5）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const accounts = db.collection('accounts');
const PAY_MODES = ['longpress', 'screen'];

/** 幂等建集合（init 未跑完时自愈；同一实例每个集合只尝试一次） */
const colReady = {};
async function ensureCol(name) {
  if (colReady[name]) return;
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
  colReady[name] = true;
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
      case 'purge':
        return await purge(OPENID, event.confirm);
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
  // 收款模式：longpress=付款方手机长按识别收款码（原模式）；screen=店主亮屏双码（新模式）。未传则保持原值
  if (PAY_MODES.includes(event.payMode)) data.payMode = event.payMode;
  // 礼金快捷金额（宾客随礼页一键选择），未传则保持原值
  if (Array.isArray(event.quickAmounts)) {
    data.quickAmounts = event.quickAmounts.map(Number)
      .filter(n => Number.isFinite(n) && n > 0 && n <= 100000)
      .map(n => Math.round(n * 100) / 100)
      .slice(0, 8);
  }

  const found = await accounts.where({ ownerOpenid: openid }).limit(1).get();
  if (found.data.length === 0) {
    const added = await accounts.add({ data: { ownerOpenid: openid, ...data, createdAt: db.serverDate() } });
    return ok({ account: { _id: added._id, ownerOpenid: openid, ...data } });
  }
  await accounts.doc(found.data[0]._id).update({ data });
  return ok({ account: { ...found.data[0], ...data } });
}

const DEFAULT_QUICK = [200, 500, 600, 800, 1000, 1888];

/** 当前礼簿的公开信息（宾客随礼页显示） */
async function activeBook(a) {
  if (!a.activeBookId) return { name: (a.theme && a.theme.name) || '', type: 'other' };
  try {
    const b = (await db.collection('books').doc(a.activeBookId).get()).data;
    return { name: b.name, type: b.type, date: b.date || '' };
  } catch (e) {
    return { name: (a.theme && a.theme.name) || '', type: 'other' };
  }
}


/**
 * 清除我的数据（注销）：删除主家的礼簿、礼金记录、送礼记录、模板、主家信息、用户信息与收款码图片
 * 导出 / 存档文件由前端先调用 export 云函数 purge 删除
 * 宾客在他人礼簿中的随礼记录属于对方礼簿档案，不在此删除
 */
async function purge(openid, confirm) {
  if (confirm !== 'DELETE') return err('参数错误');
  const removeAll = async (name, cond) => {
    let total = 0;
    try { await db.createCollection(name); } catch (e) { /* 已存在 */ }
    for (let i = 0; i < 50; i++) {
      const res = await db.collection(name).where(cond).remove();
      total += res.stats.removed;
      if (!res.stats.removed) break;
    }
    return total;
  };
  const found = await accounts.where({ ownerOpenid: openid }).limit(1).get();
  const acc = found.data[0];
  if (acc && acc.payCodeFileID) {
    try { await cloud.deleteFile({ fileList: [acc.payCodeFileID] }); } catch (e) { /* 文件已不存在 */ }
  }
  const removed = {
    records: await removeAll('records', { ownerOpenid: openid }),
    books: await removeAll('books', { ownerOpenid: openid }),
    gifts_out: await removeAll('gifts_out', { ownerOpenid: openid }),
    print_templates: await removeAll('print_templates', { ownerOpenid: openid }),
    accounts: await removeAll('accounts', { ownerOpenid: openid }),
    users: await removeAll('users', { openid })
  };
  return ok({ removed });
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
      payMode: a.payMode || 'longpress',
      quickAmounts: (a.quickAmounts && a.quickAmounts.length) ? a.quickAmounts : DEFAULT_QUICK,
      book: await activeBook(a),
      theme: a.theme || { name: '默认主题', primary: '#07C160' }
    }
  });
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
