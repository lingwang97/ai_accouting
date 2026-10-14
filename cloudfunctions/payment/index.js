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
    switch (event.action) {
      // 付款方
      case 'create': return await create(OPENID, event);
      case 'transferred': return await transferred(OPENID, event.rid, event.envVersion);
      case 'cancel': return await payerUpdate(OPENID, event.rid, [{ status: 'pending' }], 'cancelled');
      case 'status': return await status(OPENID, event.rid);
      case 'receipt': return await receipt(OPENID, event.rid);
      case 'myReceipts': return await myReceipts(OPENID);
      // 收款方
      case 'confirm': return await ownerUpdate(OPENID, event.rid, ['transferred', 'pending'], 'paid', event.amount);
      case 'confirmBatch': return await confirmBatch(OPENID, event.rids);
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
  const relation = RELATIONS.includes(event.relation) ? event.relation : '';
  const amount = Math.round(Number(event.amount) * 100) / 100;
  // 代随礼：[{name, amount?}]，金额选填；proxyFor 为名单文本（兼容展示与旧数据）
  const proxyItems = (Array.isArray(event.proxyItems) ? event.proxyItems : [])
    .map(p => ({
      name: String((p && p.name) || '').trim().slice(0, 10),
      amount: Number(p && p.amount) > 0 ? Math.round(Number(p.amount) * 100) / 100 : null
    }))
    .filter((p, i, arr) => p.name && p.name !== payerName && arr.findIndex(x => x.name === p.name) === i)
    .slice(0, 8);
  const proxyFor = proxyItems.length
    ? proxyItems.map(p => p.name).join('、')
    : String(event.proxyFor || '').trim().slice(0, 40);
  const proxyFen = proxyItems.reduce((s, p) => s + Math.round((p.amount || 0) * 100), 0);

  if (!validId(aid)) return err('参数错误');
  if (!payerName) return err('请填写付款人姓名');
  if (!Number.isFinite(amount) || amount <= 0) return err('请填写正确金额');
  if (amount > 100000) return err('单笔金额超限');
  if (proxyFen > Math.round(amount * 100)) return err('代随礼金额之和不能超过礼金总额');

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

  // 记入收礼方的当前礼簿（旧数据无礼簿时退回旧版主题名）
  let book = null;
  if (account.activeBookId) {
    try { book = (await db.collection('books').doc(account.activeBookId).get()).data; } catch (e) { /* 礼簿已删除 */ }
  }

  const added = await records.add({
    data: {
      aid,
      ownerOpenid: account.ownerOpenid,
      payerOpenid: openid,
      payerName,
      amount,
      remark,
      relation,
      proxyFor,
      proxyItems,
      bookId: book ? book._id : '',
      bookType: book ? book.type : 'other',
      themeName: book ? book.name : ((account.theme && account.theme.name) || ''),
      status: 'pending',
      printed: false,
      payDay,
      createdAt: now
    }
  });
  return ok({
    record: {
      _id: added._id, aid, payerName, amount, remark, relation, proxyFor, proxyItems,
      status: 'pending', payDay, createdAt: now,
      accountName: account.accountName,
      payMode: account.payMode || 'longpress',
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

/**
 * 宾客留存的电子回执：已入簿记录 + 该笔礼金所属礼簿的回执样式（宾客与主家均可查看）
 * 样式跟礼簿走，主家之后改了别的礼簿的样式，不影响这本礼簿的回执
 */
async function receipt(openid, rid) {
  const rec = await getRecord(rid);
  if (!rec) return err('记录不存在');
  if (rec.payerOpenid !== openid && rec.ownerOpenid !== openid) return err('无权查看');
  if (rec.status !== 'paid') return err('主家确认收到后才能生成回执');
  let account = {};
  let book = null;
  try { account = (await accounts.doc(rec.aid).get()).data; } catch (e) { /* 主家已注销 */ }
  if (rec.bookId) {
    try { book = (await db.collection('books').doc(rec.bookId).get()).data; } catch (e) { /* 礼簿已删除 */ }
  }
  return ok({
    record: receiptRecord(rec),
    accountName: account.accountName || '',
    tpl: (book && book.receiptTpl) || null // 为空时前端按事由类型套用场景默认样式
  });
}

/** 付款方的收据列表（最近 50 笔已到账） */
async function myReceipts(openid) {
  const res = await records.where({ payerOpenid: openid, status: 'paid' })
    .orderBy('paidAt', 'desc').limit(50).get();
  const aids = [...new Set(res.data.map(r => r.aid))];
  const names = {};
  if (aids.length) {
    const acc = await accounts.where({ _id: _.in(aids) }).field({ accountName: true }).get();
    acc.data.forEach(a => { names[a._id] = a.accountName; });
  }
  return ok({ list: res.data.map(r => ({ ...receiptRecord(r), accountName: names[r.aid] || '' })) });
}

/** 收据只暴露必要字段 */
const receiptRecord = r => ({
  _id: r._id, aid: r.aid, payerName: r.payerName, amount: r.amount, remark: r.remark,
  relation: r.relation || '', proxyFor: r.proxyFor || '', proxyItems: r.proxyItems || [],
  bookId: r.bookId || '', bookType: r.bookType || 'other',
  themeName: r.themeName, payDay: r.payDay, createdAt: r.createdAt, paidAt: r.paidAt
});

/**
 * 主家批量确认收到：单次最多 BATCH_MAX 笔（前端分批调用），每 5 笔并行，
 * 控制总耗时在云函数超时内；返回成功的记录供前端逐张打印
 */
const BATCH_MAX = 20;
async function confirmBatch(openid, rids) {
  if (!Array.isArray(rids) || rids.length === 0 || rids.length > BATCH_MAX) return err('参数错误');
  const done = [];
  const failed = [];
  for (let i = 0; i < rids.length; i += 5) {
    const part = rids.slice(i, i + 5);
    const results = await Promise.all(part.map(rid =>
      ownerUpdate(openid, String(rid), ['transferred', 'pending'], 'paid').catch(e => ({ code: 1, msg: e.message }))));
    results.forEach((res, k) => {
      if (res.code === 0) done.push(res.data.record);
      else failed.push(part[k]);
    });
  }
  return ok({ list: done, failed });
}

/** 收款方确认到账 / 拒绝 / 作废（带状态条件原子更新） */
async function ownerUpdate(openid, rid, fromList, to, actualAmount) {
  if (!validId(rid)) return err('记录不存在');
  const data = { status: to };
  if (to === 'paid') data.paidAt = new Date();
  // 主家按实际到账金额入簿：保留宾客原登记金额备查
  if (to === 'paid' && actualAmount !== undefined && actualAmount !== null) {
    const amt = Math.round(Number(actualAmount) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0 || amt > 100000) return err('实际金额不正确');
    const cur = await getRecord(rid);
    if (!cur || cur.ownerOpenid !== openid) return err('记录不存在');
    if (Math.round(cur.amount * 100) !== Math.round(amt * 100)) {
      data.amount = amt;
      data.declaredAmount = cur.amount;
      // 代随礼金额之和不能超过实际金额，超出时清空分人金额，只保留名单
      const proxyFen = (cur.proxyItems || []).reduce((t, x) => t + Math.round((x.amount || 0) * 100), 0);
      if (proxyFen > Math.round(amt * 100)) data.proxyItems = (cur.proxyItems || []).map(x => ({ name: x.name, amount: null }));
    }
  }
  const res = await records.where({ _id: rid, ownerOpenid: openid, status: _.in(fromList) })
    .update({ data });
  const rec = await getRecord(rid);
  if (!rec) return err('记录不存在');
  if (rec.ownerOpenid !== openid) return err('无权操作该账目');
  if (res.stats.updated !== 1) return err('当前状态不可操作，请刷新');
  // 礼簿份数与合计累加：入簿 +1，作废 -1
  // 入簿只累加到已完成补算、且分界时间不晚于本笔入簿时间的礼簿（之前的由补算统计，见 books.backfillStats）
  if (rec.bookId && (to === 'paid' || to === 'void')) {
    const sign = to === 'paid' ? 1 : -1;
    let cond = { _id: rec.bookId, statReady: true };
    if (to === 'paid') {
      // 旧版创建的礼簿没有 statSince，照常累加
      cond = _.and([cond, _.or([{ statSince: _.lte(rec.paidAt) }, { statSince: _.exists(false) }])]);
    }
    try {
      await db.collection('books').where(cond).update({
        data: { statCount: _.inc(sign), statFen: _.inc(sign * Math.round(rec.amount * 100)) }
      });
    } catch (e) { console.warn('礼簿合计更新失败', e.message); }
  }
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
const RELATIONS = ['亲戚', '朋友', '同事', '同学', '邻里', '其他'];

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
