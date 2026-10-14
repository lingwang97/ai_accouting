// 云函数 records — 账目列表 / 汇总 / 打印标记（文档 §5、§8）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const records = db.collection('records');
const PENDING_TTL = 30 * 60 * 1000;

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
    await ensureCol('records');
    if (event.action === 'list' || event.action === 'pending') await expirePending(OPENID);
    switch (event.action) {
      case 'list':
        return await list(OPENID, event);
      case 'detail':
        return await detail(OPENID, event.rid);
      case 'markPrinted':
        return await markPrinted(OPENID, event.rids);
      case 'pending':
        return await pending(OPENID);
      case 'themes':
        return await themes(OPENID);
      default:
        return err('未知 action');
    }
  } catch (e) {
    return err('查询失败：' + e.message);
  }
};

/** 超过 PENDING_TTL 仍未转账的记录自动取消（惰性执行，付款方之后仍可补点「已转账」） */
async function expirePending(openid) {
  await records.where({
    ownerOpenid: openid,
    status: 'pending',
    createdAt: _.lt(new Date(Date.now() - PENDING_TTL))
  }).update({ data: { status: 'cancelled', autoCancelled: true } });
}

/** 分页 + 全量汇总；按日/关键词筛选 */
async function list(openid, event) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || 20));

  // 列表显示：已确认 + 待确认（transferred/pending）；汇总只算已确认 paid
  const base = { ownerOpenid: openid };
  if (event.payDay) base.payDay = String(event.payDay).slice(0, 10);
  if (event.bookId) base.bookId = String(event.bookId).slice(0, 64);
  if (event.relation) base.relation = String(event.relation).slice(0, 10);
  let kw = null;
  if (event.keyword) {
    // 搜索姓名时同时匹配代随礼名单（搜"王五"能找到"李四 代 王五"）
    const reg = db.RegExp({ regexp: escapeReg(String(event.keyword).slice(0, 20)), options: 'i' });
    kw = _.or([{ payerName: reg }, { proxyFor: reg }]);
  }
  const withKw = c => (kw ? _.and([c, kw]) : c);
  const paidCond = withKw({ ...base, status: 'paid' });
  const listCond = withKw({ ...base, status: _.in(['paid', 'transferred', 'pending']) });
  const pendingCond = withKw({ ...base, status: 'transferred' });

  const [totalRes, pendingRes, listTotalRes, sumRes, listRes] = await Promise.all([
    records.where(paidCond).count(),
    records.where(pendingCond).count(),
    records.where(listCond).count(),
    // 汇总用聚合避免拉全量
    records.aggregate().match(paidCond)
      .group({ _id: null, totalFen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .end(),
    records.where(listCond)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()
  ]);

  const totalFen = (sumRes.list && sumRes.list[0] && sumRes.list[0].totalFen) || 0;
  return ok({
    list: listRes.data,
    total: totalRes.total,          // 已确认笔数
    pendingCount: pendingRes.total, // 待确认笔数
    listTotal: listTotalRes.total,  // 列表总条数（分页用）
    sum: Math.round(totalFen) / 100, // 整数分累加后还原，避免浮点误差
    page,
    pageSize
  });
}

async function detail(openid, rid) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(rid || ''))) return err('参数错误');
  const rec = (await records.doc(rid).get()).data;
  if (!rec || rec.ownerOpenid !== openid) return err('无权查看');
  return ok({ record: rec });
}

/** 打印成功回写：只允许收款方标记自己的账目 */
async function markPrinted(openid, rids) {
  if (!Array.isArray(rids) || rids.length === 0 || rids.length > 50) return err('参数错误');
  const res = await records.where({ ownerOpenid: openid, _id: _.in(rids) })
    .update({ data: { printed: true } });
  return ok({ updated: res.stats.updated });
}

/** 待收款方确认的转账（"我的"页置顶 + 角标） */
async function pending(openid) {
  const res = await records.where({ ownerOpenid: openid, status: 'transferred' })
    .orderBy('createdAt', 'desc').limit(50).get();
  return ok({ list: res.data, count: res.data.length });
}

/** 出现过的记账主题（导出筛选用） */
async function themes(openid) {
  const res = await records.aggregate()
    .match({ ownerOpenid: openid, status: 'paid' })
    .group({ _id: '$themeName' })
    .limit(100)
    .end();
  return ok({ list: (res.list || []).map(t => t._id).filter(Boolean) });
}

const escapeReg = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
