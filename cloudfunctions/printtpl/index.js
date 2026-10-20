// 云函数 printtpl — 打印模板存取（文档 §6.6）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const tpls = db.collection('print_templates');

/** 幂等建集合（init 未跑完时自愈；同一实例每个集合只尝试一次） */
const colReady = {};
async function ensureCol(name) {
  if (colReady[name]) return;
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
  colReady[name] = true;
}

const ALLOWED_FIELDS = ['title', 'divider', 'theme', 'payDay', 'time', 'payerName', 'relation', 'amount', 'remark', 'thanks'];
const DEFAULT_FIELDS = ['title', 'divider', 'theme', 'payDay', 'time', 'payerName', 'amount', 'remark', 'thanks'];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    await ensureCol('print_templates');
    if (event.action === 'get') return await get(OPENID);
    if (event.action === 'save') return await save(OPENID, event.tpl);
    return err('未知 action');
  } catch (e) {
    return err('模板操作失败：' + e.message);
  }
};

async function get(openid) {
  const found = await tpls.where({ ownerOpenid: openid }).limit(1).get();
  if (found.data.length > 0) return ok({ tpl: found.data[0] });
  // 返回默认模板
  return ok({
    tpl: {
      ownerOpenid: openid,
      paperWidth: 32,
      fields: DEFAULT_FIELDS,
      title: '礼金回执',
      fontSize: 'normal',
      showDivider: true,
      alignAmount: 'right',
      thanks: '承蒙厚爱，谨致谢忱'
    }
  });
}

async function save(openid, tpl) {
  tpl = tpl || {};
  const data = {
    paperWidth: tpl.paperWidth === 48 ? 48 : 32,
    fields: Array.isArray(tpl.fields)
      ? tpl.fields.filter(f => ALLOWED_FIELDS.includes(f)).slice(0, 10)
      : DEFAULT_FIELDS,
    title: String(tpl.title || '礼金回执').slice(0, 30),
    showDivider: tpl.showDivider !== false,
    thanks: String(tpl.thanks || '').slice(0, 40),
    updatedAt: db.serverDate()
  };
  if (data.fields.length === 0) return err('至少保留一个打印字段');

  const found = await tpls.where({ ownerOpenid: openid }).limit(1).get();
  if (found.data.length === 0) {
    const added = await tpls.add({ data: { ownerOpenid: openid, ...data } });
    return ok({ tpl: { _id: added._id, ownerOpenid: openid, ...data } });
  }
  await tpls.doc(found.data[0]._id).update({ data });
  return ok({ tpl: { ...found.data[0], ...data } });
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
