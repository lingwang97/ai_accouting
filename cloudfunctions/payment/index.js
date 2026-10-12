// 云函数 payment — 扫码付款与转账确认（文档 §6.3）
// 状态流转：pending(待转账) → transferred(付款方已转账，待收款方确认) → paid(收款方确认到账)
//          pending → cancelled(付款方取消，或超过 30 分钟未转账被自动取消，仍可补点「已转账」)；transferred → rejected(收款方未收到款)；paid → void(作废)
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const notify = require('./notify.js');
const accounts = db.collection('accounts');
const records = db.collection('records');

/** 幂等建集合（init 未跑完时自愈） */
async function ensureCol(name) {
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    await ensureCol('records');
    switch (event.action) {
      // 付款方
      case 'create': return await create(OPENID, event);
      case 'transferred': return await transferred(OPENID, event.rid, event.envVersion);
      case 'cancel': return await payerUpdate(OPENID, event.rid, [{ status: 'pending' }], 'cancelled');
      case 'status': return await status(OPENID, event.rid);
      // 收款方
      case 'confirm': return await ownerUpdate(OPENID, event.rid, ['transferred', 'pending'], 'paid');
      case 'reject': return await ownerUpdate(OPENID, event.rid, ['transferred', 'pending'], 'rejected');
      case 'void': return await ownerUpdate(OPENID, event.rid, ['paid'], 'void');
      default: return err('未知 action');
    }
  } catch (e) {
    return err('操作失败：' + e.message);
  }
};

/** 付款方发起转账：创建待转账记录，返回收款码 */
async function create(openid, event) {
  const aid = String(event.aid || '');
  const payerName = String(event.payerName || '').trim().slice(0, 20);
  const remark = String(event.remark || '').trim().slice(0, 50);
  const amount = Math.round(Number(event.amount) * 100) / 100;

  if (!validId(aid)) return err('参数错误');
  if (!payerName) return err('请填写付款人姓名');
  if (!Number.isFinite(amount) || amount <= 0) return err('请填写正确金额');
  if (amount > 100000) return err('单笔金额超限');

  let account;
  try {
    account = (await accounts.doc(aid).get()).data;
  } catch (e) {
    return err('收款账户不存在');
  }

  // 防刷：同一付款人 1 分钟内最多发起 RATE_MAX 笔
  const now = new Date();
  const recent = await records.where({
    payerOpenid: openid,
    createdAt: _.gt(new Date(now.getTime() - 60 * 1000))
  }).count();
  if (recent.total >= RATE_MAX) return err('操作太频繁，请稍后再试');

  const payDay = bjDay(now);

  const added = await records.add({
    data: {
      aid,
      ownerOpenid: account.ownerOpenid,
      payerOpenid: openid,
      payerName,
      amount,
      remark,
      themeName: (account.theme && account.theme.name) || '',
      status: 'pending',
      printed: false,
      payDay,
      createdAt: now
    }
  });
  return ok({
    record: {
      _id: added._id, aid, payerName, amount, remark,
      status: 'pending', payDay, createdAt: now,
      accountName: account.accountName,
      payCodeFileID: account.payCodeFileID
    }
  });
}

/** 付款方已转账：pending（或超时被自动取消的）→ transferred，并通知收款方 */
async function transferred(openid, rid, envVersion) {
  const res = await payerUpdate(openid, rid,
    [{ status: 'pending' }, { status: 'cancelled', autoCancelled: true }], 'transferred');
  if (res.code === 0 && res.data.changed) await notifyOwner(rid, envVersion);
  return res;
}

/**
 * 付款方推进自己的记录状态。
 * 带状态条件原子更新，避免与收款方确认并发时互相覆盖。
 */
async function payerUpdate(openid, rid, fromConds, to) {
  if (!validId(rid)) return err('记录不存在');
  const data = { status: to };
  if (to === 'transferred') { data.transferredAt = new Date(); data.autoCancelled = _.remove(); }
  const res = await records.where(_.or(fromConds.map(c => ({ _id: rid, payerOpenid: openid, ...c }))))
    .update({ data });
  if (res.stats.updated === 1) return ok({ status: to, changed: true });

  // 未更新：已推进过（幂等返回当前状态）或无权
  const rec = await getRecord(rid);
  if (!rec) return err('记录不存在');
  if (rec.payerOpenid !== openid) return err('无权操作');
  return ok({ status: rec.status, changed: false });
}

/** 订阅消息提醒收款方（未配置模板或店主未订阅时静默跳过） */
async function notifyOwner(rid, envVersion) {
  if (!notify.TMPL_ID) return;
  try {
    const rec = await getRecord(rid);
    await cloud.openapi.subscribeMessage.send({
      touser: rec.ownerOpenid,
      templateId: notify.TMPL_ID,
      page: 'pages/mine/mine',
      miniprogramState: { develop: 'developer', trial: 'trial' }[envVersion] || 'formal',
      data: notify.build(rec, bjTime(rec.transferredAt || new Date()))
    });
  } catch (e) {
    console.warn('订阅消息发送失败', e.errCode, e.errMsg || e.message); // 43101=店主未订阅，正常
  }
}

/** 付款方轮询状态 */
async function status(openid, rid) {
  const rec = await getRecord(rid);
  if (!rec) return err('记录不存在');
  if (rec.payerOpenid !== openid && rec.ownerOpenid !== openid) return err('无权查看');
  return ok({
    status: rec.status,
    record: {
      _id: rec._id, payerName: rec.payerName, amount: rec.amount,
      remark: rec.remark, status: rec.status, createdAt: rec.createdAt, paidAt: rec.paidAt
    }
  });
}

/** 收款方确认到账 / 拒绝 / 作废（带状态条件原子更新） */
async function ownerUpdate(openid, rid, fromList, to) {
  if (!validId(rid)) return err('记录不存在');
  const data = { status: to };
  if (to === 'paid') data.paidAt = new Date();
  const res = await records.where({ _id: rid, ownerOpenid: openid, status: _.in(fromList) })
    .update({ data });
  const rec = await getRecord(rid);
  if (!rec) return err('记录不存在');
  if (rec.ownerOpenid !== openid) return err('无权操作该账目');
  if (res.stats.updated !== 1) return err('当前状态不可操作，请刷新');
  return ok({ rid, status: to, record: rec });
}

async function getRecord(rid) {
  if (!validId(rid)) return null;
  try {
    return (await records.doc(rid).get()).data;
  } catch (e) {
    return null;
  }
}

const RATE_MAX = 3;

/** 云函数运行在 UTC，日期统一按北京时间（UTC+8） */
function bj(d) {
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return { day: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, hm: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}` };
}
const bjDay = d => bj(d).day;
const bjTime = d => { const b = bj(d); return `${b.day} ${b.hm}`; };

const validId = s => /^[a-zA-Z0-9_-]{1,64}$/.test(String(s || ''));
const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
