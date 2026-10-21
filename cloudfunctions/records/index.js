// 云函数 records — 账目列表 / 汇总 / 打印标记（文档 §5、§8）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const records = db.collection('records');
const { resolveCtx, canBook, readonly, can, workBook } = require('./ctx.js');
const PENDING_TTL = 30 * 60 * 1000;

/** 幂等建集合（init 未跑完时自愈；同一实例每个集合只尝试一次） */
const colReady = {};
async function ensureCol(name) {
  if (colReady[name]) return;
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
  colReady[name] = true;
}

exports.main = async (event) => {
  // 预热：warmer 云函数按「系统设置」定时唤醒，保持实例常驻、减少冷启动；直接返回，不做任何读写
  if (event && (event.action === '__warm' || event.Type === 'Timer')) return { code: 0, msg: 'warm', data: null }; // Timer：兼容之前上传过的旧预热触发器
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return err('未获取到用户身份');
  try {
    await ensureCol('records');
    // 记账人代主家操作：数据一律按主家
    const ctx = await resolveCtx(db, OPENID);
    const OWNER = ctx.ownerOpenid;
    // 只读家人不触发写操作
    if (['list', 'pending', 'dashboard', 'pendingStat'].includes(event.action) && !readonly(ctx) && ctx.account) await expirePending(OWNER);
    switch (event.action) {
      case 'dashboard':
        return await dashboard(ctx);
      // 对账、多场汇总：记账人需有「对账与导出」权限（家人共享可查看）
      case 'orgSummary':
        if (ctx.role === 'clerk' && !can(ctx, 'export')) return err('你没有对账与导出的权限');
        return await orgSummary(ctx, event);
      case 'reconcile':
        if (ctx.role === 'clerk' && !can(ctx, 'export')) return err('你没有对账与导出的权限');
        return await reconcile(ctx, event);
      case 'list':
        return await list(OWNER, event, ctx);
      case 'detail':
        return await detail(OWNER, event.rid, ctx);
      case 'markPrinted':
        if (readonly(ctx)) return err('家人共享为只读');
        if (!can(ctx, 'show')) return err('你没有打印权限');
        return await markPrinted(OWNER, event.rids, ctx);
      case 'pending':
        return await pending(OWNER, ctx);
      case 'pendingStat':
        return await pendingStat(OWNER, ctx);
      case 'themes':
        return await themes(OWNER, ctx);
      // 同名区分：礼台记账前查礼簿里同名的人；给某位宾客设区分备注
      case 'nameCheck':
        if (!can(ctx, 'desk')) return err('无权查询');
        return await nameCheck(ctx, event.names);
      case 'setNameTag':
        if (!can(ctx, 'desk') && !can(ctx, 'confirm')) return err('无权修改');
        return await setNameTag(ctx, event.rid, event.tag);
      default:
        return err('未知 action');
    }
  } catch (e) {
    console.error('records', event.action, e);
    return err('查询失败，请稍后重试');
  }
};

/**
 * 超过 PENDING_TTL 仍未转账的记录自动取消（惰性执行，付款方之后仍可补点「已转账」）
 * 是写操作，同一实例内每位主家每分钟最多执行一次，避免拖慢每次查询
 */
const expiredAt = new Map();
async function expirePending(openid) {
  const last = expiredAt.get(openid) || 0;
  if (Date.now() - last < 60 * 1000) return;
  expiredAt.set(openid, Date.now());
  // 转账+现金批次不自动取消：现金可能已交到礼台，由主家在待确认里处理
  await records.where({
    ownerOpenid: openid,
    status: 'pending',
    batchPay: _.neq('mixed'),
    createdAt: _.lt(new Date(Date.now() - PENDING_TTL))
  }).update({ data: { status: 'cancelled', autoCancelled: true } });
}

/**
 * 工作台一次取齐：主家信息与身份、当前礼簿合计、今日收礼、待确认（原先前端要依次调 4 次）
 * 当前礼簿尚未建立或尚未补算合计时 needBooks=true，前端再调 books.list（会自动建默认礼簿、补算）
 */
async function dashboard(ctx) {
  const account = ctx.account;
  const lastNotify = (ctx.user && ctx.user.lastNotify) || null;
  const joins = await myJoins(ctx);
  if (!account) return ok({ account: null, role: ctx.role, lastNotify, joins });
  const owner = ctx.ownerOpenid;
  const today = bjDay(new Date());
  const scope = ctx.bookIds ? { bookId: _.in(ctx.bookIds) } : {};
  const activeId = workBook(ctx); // 机构模式记账人：自己选的一场
  // 待确认只算当前礼簿；其他礼簿的只给个数（工作台小提示），确认要先切换礼簿
  const pendCond = { ownerOpenid: owner, status: 'transferred', bookId: activeId || '__none__' };
  const [bookRes, todayRes, pendRes, pendCount, otherCount, joinRes] = await Promise.all([
    activeId ? db.collection('books').doc(activeId).get().catch(() => null) : null,
    records.aggregate()
      .match({ ownerOpenid: owner, status: 'paid', payDay: today, ...scope })
      .group({ _id: null, count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .end(),
    // 待确认份数与合计：计数 + 聚合（不受单次查询 100 条限制）
    records.aggregate().match(pendCond)
      .group({ _id: null, fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .end(),
    records.where(pendCond).count(),
    records.where(otherPendCond(ctx, activeId)).count(),
    // 主家：通过邀请卡申请加入、待同意的人数
    ctx.role === 'owner' ? db.collection('members').where({ aid: account._id, status: 'pending' }).count() : null
  ]);
  const b = bookRes && bookRes.data;
  const book = b && b.ownerOpenid === owner && b.statReady
    ? { _id: b._id, name: b.name, type: b.type, date: b.date || '', hostName: b.hostName || '', count: b.statCount || 0, sum: (b.statFen || 0) / 100 }
    : null;
  const t = (todayRes.list && todayRes.list[0]) || { count: 0, fen: 0 };
  const pendFen = Math.round(((pendRes.list && pendRes.list[0]) || { fen: 0 }).fen);
  // 返回给前端的主家信息去掉内部字段；只负责部分场次的人员与家人看不到收款码文件
  const { ownerOpenid, transferredFrom, transferPending, pendingPayCode, _openid, ...shown } = account;
  if (!can(ctx, 'info')) { delete shown.payCodeFileID; delete shown.payCodeBy; }
  return ok({
    account: { ...shown, hasPendingPayCode: !!pendingPayCode },
    role: ctx.role,
    restricted: !!ctx.bookIds,
    readonly: readonly(ctx),
    perms: ctx.perms || [],
    // 没有可记的礼簿：ended 记账人负责的礼簿都已结束（归档 / 删除 / 移交）；none 主家还没有当前礼簿
    noBook: activeId ? '' : (ctx.role === 'clerk' ? 'ended' : 'none'),
    // 机构模式下负责多场（或全部场次）的记账人：可切换自己正在记的一场，不影响别人
    mySwitch: ctx.role === 'clerk' && !!account.orgMode && (!ctx.bookIds || ctx.bookIds.length > 1),
    lastNotify,
    book,
    needBooks: !book,
    today: { count: t.count, sum: Math.round(t.fen) / 100 },
    pending: { count: pendCount.total, sum: pendFen / 100, other: otherCount.total },
    pendingMembers: joinRes ? joinRes.total : 0,
    joins
  });
}

/**
 * 我申请加入的进度（首页提示）：待主家同意的；7 天内已同意、但当前不是这个身份的（提示去切换）
 * 只返回主家称呼与状态
 */
async function myJoins(ctx) {
  const me = ctx.user && ctx.user.openid;
  if (!me) return [];
  try {
    const ms = (await db.collection('members').where({ memberOpenid: me, _openid: _.exists(false) }).limit(20).get()).data;
    const week = Date.now() - 7 * 24 * 3600 * 1000;
    const cur = ctx.account && ctx.account._id;
    const show = ms.filter(m => m.status === 'pending' || (m.approvedAt && new Date(m.approvedAt).getTime() > week && m.aid !== cur));
    if (!show.length) return [];
    const accs = (await db.collection('accounts').where({ _id: _.in(show.map(m => m.aid)) }).field({ accountName: true }).get()).data;
    const name = id => (accs.find(a => a._id === id) || {}).accountName || '主家';
    return show.map(m => ({ aid: m.aid, name: name(m.aid), role: m.role, pending: m.status === 'pending' }));
  } catch (e) { return []; }
}

/**
 * 机构版：多场次汇总。每场（礼簿）的份数、合计、待确认、现金 / 微信分项，以及每位礼台人员的登记与确认
 * event.month：'YYYY-MM' 只看该月办事日期的场次；空为全部
 */
async function orgSummary(ctx, event) {
  if (!ctx.account) return err('请先完善主家信息');
  const owner = ctx.ownerOpenid;
  const month = /^\d{4}-\d{2}$/.test(String(event.month || '')) ? event.month : '';
  let books = (await db.collection('books').where({ ownerOpenid: owner }).orderBy('date', 'desc').limit(1000).get()).data
    .filter(b => canBook(ctx, b._id));
  if (month) books = books.filter(b => String(b.date || '').startsWith(month));
  if (!books.length) return ok({ list: [], total: { count: 0, sum: 0, pending: 0 }, staff: [] });
  const ids = books.map(b => b._id);
  const fenOf = _.aggregate.sum(_.aggregate.multiply(['$amount', 100]));
  const [byBook, byStaff, members] = await Promise.all([
    records.aggregate()
      .match({ ownerOpenid: owner, bookId: _.in(ids), status: _.in(['paid', 'transferred']) })
      .group({ _id: { bookId: '$bookId', status: '$status', method: '$payMethod' }, count: _.aggregate.sum(1), fen: fenOf })
      .limit(1000).end(),
    records.aggregate()
      .match({ ownerOpenid: owner, bookId: _.in(ids), status: 'paid' })
      .group({ _id: { bookId: '$bookId', handler: '$handlerOpenid' }, name: _.aggregate.first('$handlerName'), count: _.aggregate.sum(1), fen: fenOf })
      .limit(1000).end(),
    db.collection('members').where({ aid: ctx.account._id }).limit(100).get()
  ]);
  members.data = members.data.filter(m => m.status !== 'pending'); // 待主家同意的不算
  const users = {};
  const openids = members.data.map(m => m.memberOpenid);
  if (openids.length) {
    (await db.collection('users').where({ openid: _.in(openids) }).field({ openid: true, nickname: true }).get())
      .data.forEach(u => { users[u.openid] = u.nickname; });
  }
  const row = {};
  books.forEach(b => {
    row[b._id] = {
      _id: b._id, name: b.name, type: b.type, date: b.date || '', hostName: b.hostName || '', archived: !!b.archived,
      count: 0, fen: 0, pending: 0, cashFen: 0, wechatFen: 0, staff: [],
      // 负责本场的礼台人员（未指定场次的人员负责全部）
      onDuty: members.data.filter(m => m.role !== 'viewer' && (m.allBooks || !m.bookIds || !m.bookIds.length || m.bookIds.includes(b._id)))
        .map(m => ({ name: users[m.memberOpenid] || '记账人', title: m.title || '' }))
    };
  });
  (byBook.list || []).forEach(g => {
    const r = row[g._id.bookId];
    if (!r) return;
    if (g._id.status === 'transferred') { r.pending += g.count; return; }
    r.count += g.count;
    r.fen += Math.round(g.fen);
    if (g._id.method === 'cash') r.cashFen += Math.round(g.fen); else r.wechatFen += Math.round(g.fen);
  });
  const staffTotal = {};
  (byStaff.list || []).forEach(g => {
    const r = row[g._id.bookId];
    const name = g.name || (g._id.handler ? users[g._id.handler] : '') || '主家（早期记录）';
    if (r) r.staff.push({ name, count: g.count, sum: Math.round(g.fen) / 100 });
    const k = g._id.handler || name;
    staffTotal[k] = staffTotal[k] || { name, count: 0, fen: 0 };
    staffTotal[k].count += g.count;
    staffTotal[k].fen += Math.round(g.fen);
  });
  const list = books.map(b => {
    const r = row[b._id];
    return { ...r, sum: r.fen / 100, cash: r.cashFen / 100, wechat: r.wechatFen / 100 };
  });
  return ok({
    list,
    total: {
      count: list.reduce((t, r) => t + r.count, 0),
      sum: list.reduce((t, r) => t + r.fen, 0) / 100,
      pending: list.reduce((t, r) => t + r.pending, 0)
    },
    staff: Object.values(staffTotal).map(x => ({ name: x.name, count: x.count, sum: x.fen / 100 })).sort((a, b) => b.sum - a.sum)
  });
}

/**
 * 一键对账：某本礼簿（默认当前礼簿）按状态、支付方式、记账人汇总；event.day 只看某天
 * 现金分两类：宾客自报现金（宾客登记后主家确认）、礼台登记现金（主家 / 记账人直接录入，payerOpenid 为空）
 */
async function reconcile(ctx, event) {
  const account = ctx.account;
  if (!account) return err('请先完善主家信息');
  const owner = ctx.ownerOpenid;
  let bookId = String(event.bookId || '') || workBook(ctx);
  if (ctx.bookIds && !canBook(ctx, bookId)) bookId = workBook(ctx);
  if (!bookId) return err('还没有礼簿');
  let book;
  try { book = (await db.collection('books').doc(bookId).get()).data; } catch (e) { return err('礼簿不存在'); }
  if (book.ownerOpenid !== owner || !canBook(ctx, bookId)) return err('礼簿不存在');

  const base = { ownerOpenid: owner, bookId };
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(event.day || ''))) base.payDay = event.day;
  const fenOf = _.aggregate.sum(_.aggregate.multiply(['$amount', 100]));
  const [byStatus, deskCash, diff, byHandler, deskWechat, mixedRes] = await Promise.all([
    records.aggregate().match(base)
      .group({ _id: { status: '$status', method: '$payMethod' }, count: _.aggregate.sum(1), fen: fenOf })
      .limit(100).end(),
    records.aggregate().match({ ...base, status: 'paid', payMethod: 'cash', payerOpenid: '' })
      .group({ _id: null, count: _.aggregate.sum(1), fen: fenOf }).end(),
    // 按实际到账入簿：宾客登记金额与实收不一致的
    records.aggregate().match({ ...base, status: 'paid', declaredAmount: _.exists(true) })
      .group({ _id: null, count: _.aggregate.sum(1), fen: fenOf, declaredFen: _.aggregate.sum(_.aggregate.multiply(['$declaredAmount', 100])) })
      .end(),
    records.aggregate().match({ ...base, status: 'paid' })
      .group({ _id: { handler: '$handlerOpenid', method: '$payMethod' }, name: _.aggregate.first('$handlerName'), count: _.aggregate.sum(1), fen: fenOf })
      .limit(200).end(),
    // 礼台登记的微信（宾客当面转账、礼台看到到账后登记）
    records.aggregate().match({ ...base, status: 'paid', payMethod: 'wechat', payerOpenid: '' })
      .group({ _id: null, count: _.aggregate.sum(1), fen: fenOf }).end(),
    // 「转账+现金」批次：按批次、支付方式分组
    records.aggregate().match({ ...base, status: 'paid', batchPay: 'mixed' })
      .group({ _id: { batchId: '$batchId', method: '$payMethod' }, fen: fenOf })
      .limit(10000).end()
  ]);

  const z = () => ({ count: 0, fen: 0 });
  const s = { paid: z(), wechat: z(), cash: z(), transferred: z(), pending: z(), rejected: z(), void: z(), cancelled: z() };
  (byStatus.list || []).forEach(g => {
    const st = g._id.status;
    const add = (k) => { s[k].count += g.count; s[k].fen += Math.round(g.fen); };
    if (st === 'paid') {
      add('paid');
      add(g._id.method === 'cash' ? 'cash' : 'wechat');
    } else if (s[st]) {
      add(st);
    }
  });
  const desk = (deskCash.list && deskCash.list[0]) || { count: 0, fen: 0 };
  const d = (diff.list && diff.list[0]) || { count: 0, fen: 0, declaredFen: 0 };
  const hs = {};
  (byHandler.list || []).forEach(g => {
    const k = g._id.handler || '_';
    hs[k] = hs[k] || { name: g.name || (g._id.handler ? '记账人' : '主家（早期记录）'), count: 0, fen: 0, cashCount: 0, cashFen: 0 };
    hs[k].count += g.count;
    hs[k].fen += Math.round(g.fen);
    if (g._id.method === 'cash') { hs[k].cashCount += g.count; hs[k].cashFen += Math.round(g.fen); }
  });
  const y = x => ({ count: x.count, sum: Math.round(x.fen) / 100 });
  const dw = (deskWechat.list && deskWechat.list[0]) || { count: 0, fen: 0 };
  const mx = { batches: new Set(), wechatFen: 0, cashFen: 0 };
  (mixedRes.list || []).forEach(g => {
    mx.batches.add(g._id.batchId);
    if (g._id.method === 'cash') mx.cashFen += Math.round(g.fen); else mx.wechatFen += Math.round(g.fen);
  });
  return ok({
    book: { _id: book._id, name: book.name, type: book.type, date: book.date || '', hostName: book.hostName || '' },
    day: base.payDay || '',
    paid: y(s.paid),
    wechat: y(s.wechat),
    cash: y(s.cash),
    deskCash: y(desk),
    guestCash: { count: s.cash.count - desk.count, sum: Math.round(s.cash.fen - desk.fen) / 100 },
    deskWechat: y(dw),
    guestWechat: { count: s.wechat.count - dw.count, sum: Math.round(s.wechat.fen - dw.fen) / 100 },
    // 转账+现金批次：批次数、其中转账部分与现金部分（已分别计入上面的微信 / 现金）
    mixed: { batches: mx.batches.size, wechat: mx.wechatFen / 100, cash: mx.cashFen / 100, sum: (mx.wechatFen + mx.cashFen) / 100 },
    transferred: y(s.transferred),
    pending: y(s.pending),
    rejected: y(s.rejected),
    void: y(s.void),
    diff: { count: d.count, declared: Math.round(d.declaredFen) / 100, actual: Math.round(d.fen) / 100, gap: Math.round(d.fen - d.declaredFen) / 100 },
    handlers: Object.values(hs).map(h => ({ name: h.name, count: h.count, sum: h.fen / 100, cashCount: h.cashCount, cashSum: h.cashFen / 100 }))
      .sort((a, b) => b.sum - a.sum)
  });
}

/** 云函数运行在 UTC，日期按北京时间（UTC+8） */
function bjDay(d) {
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/** 分页 + 全量汇总；按日/关键词筛选 */
async function list(openid, event, ctx) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || 20));

  // 列表显示：已确认 + 待确认（transferred/pending）；汇总只算已确认 paid
  const base = { ownerOpenid: openid };
  if (event.payDay) base.payDay = String(event.payDay).slice(0, 10);
  if (event.bookId) base.bookId = String(event.bookId).slice(0, 64);
  // 礼台人员只看负责的场次
  if (ctx.bookIds) {
    if (base.bookId && !canBook(ctx, base.bookId)) base.bookId = '__none__';
    else if (!base.bookId) base.bookId = _.in(ctx.bookIds);
  }
  if (event.relation) base.relation = String(event.relation).slice(0, 10);
  let kw = null;
  if (event.keyword) {
    kw = { payerName: db.RegExp({ regexp: escapeReg(String(event.keyword).slice(0, 20)), options: 'i' }) };
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
    list: listRes.data.map(strip),
    total: totalRes.total,          // 已确认笔数
    pendingCount: pendingRes.total, // 待确认笔数
    listTotal: listTotalRes.total,  // 列表总条数（分页用）
    sum: Math.round(totalFen) / 100, // 整数分累加后还原，避免浮点误差
    page,
    pageSize
  });
}

async function detail(openid, rid, ctx) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(rid || ''))) return err('参数错误');
  const rec = (await records.doc(rid).get()).data;
  if (!rec || rec.ownerOpenid !== openid || !canBook(ctx, rec.bookId)) return err('无权查看');
  return ok({ record: strip(rec) });
}

/** 打印成功回写：只允许收款方标记自己的账目（只负责部分场次的人员限于负责的场次） */
async function markPrinted(openid, rids, ctx) {
  if (!Array.isArray(rids) || rids.length === 0 || rids.length > 50) return err('参数错误');
  const ids = rids.map(String).filter(s => /^[a-zA-Z0-9_-]{1,64}$/.test(s));
  if (!ids.length) return err('参数错误');
  const cond = { ownerOpenid: openid, _id: _.in(ids) };
  if (ctx.bookIds) cond.bookId = _.in(ctx.bookIds);
  const res = await records.where(cond)
    .update({ data: { printed: true } });
  return ok({ updated: res.stats.updated });
}

/**
 * 待收款方确认的转账（"我的"页置顶 + 角标）
 * stalled：宾客登记后没点「我已完成转账」的（超过 STALL_MS 仍未点，或 24 小时内被自动取消的），
 * 宾客常常转完账直接回聊天，主家核对微信到账后可直接入簿
 */
const STALL_MS = 3 * 60 * 1000;
async function pending(openid, ctx) {
  // 只取当前礼簿（workBook）的待确认；确认接口同样限定当前礼簿，避免跨礼簿确认
  const cur = workBook(ctx);
  const bk = cur || '__none__';
  const cond = { ownerOpenid: openid, status: 'transferred', bookId: bk };
  const now = Date.now();
  const stallCond = _.or([
    { ownerOpenid: openid, status: 'pending', createdAt: _.lt(new Date(now - STALL_MS)), bookId: bk },
    { ownerOpenid: openid, status: 'cancelled', autoCancelled: true, stallDismissed: _.neq(true), createdAt: _.gt(new Date(now - 24 * 3600 * 1000)), bookId: bk }
  ]);
  const [res, cnt, stall, other, bookRes] = await Promise.all([
    records.where(cond).orderBy('createdAt', 'desc').limit(100).get(),
    records.where(cond).count(),
    records.where(stallCond).orderBy('createdAt', 'desc').limit(100).get(),
    records.where(otherPendCond(ctx, cur)).count(),
    cur ? db.collection('books').doc(cur).get().catch(() => null) : null
  ]);
  const b = bookRes && bookRes.data;
  const bookName = b && b.ownerOpenid === openid ? (b.hostName ? `${b.hostName} · ${b.name}` : b.name) : '';
  return ok({ list: res.data.map(strip), count: cnt.total, stalled: stall.data.map(strip), bookName, otherCount: other.total });
}

/** 其他礼簿（非当前礼簿，且在可见范围内）的待确认条件：只用来计数提示 */
function otherPendCond(ctx, cur) {
  const ids = ctx.bookIds ? ctx.bookIds.filter(id => id !== cur && id !== '__none__') : null;
  return {
    ownerOpenid: ctx.ownerOpenid, status: 'transferred',
    bookId: ids ? _.in(ids.length ? ids : ['__none__']) : _.neq(cur || '__none__')
  };
}

/** 待确认份数与合计（工作台轮询用，只做计数 + 聚合） */
async function pendingStat(openid, ctx) {
  if (!ctx.account) return ok({ count: 0, sum: 0 });
  const cur = workBook(ctx);
  const cond = { ownerOpenid: openid, status: 'transferred', bookId: cur || '__none__' };
  const [cnt, agg, other] = await Promise.all([
    records.where(cond).count(),
    records.aggregate().match(cond)
      .group({ _id: null, fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .end(),
    records.where(otherPendCond(ctx, cur)).count()
  ]);
  return ok({ count: cnt.total, sum: Math.round(((agg.list && agg.list[0]) || { fen: 0 }).fen) / 100, other: other.total });
}

/**
 * 礼簿（主家全部礼簿，受限记账人为负责的礼簿）里同名的人：按 微信身份 / 区分备注 / 指定的人 分组
 * 返回 { 姓名: [{ ref, tag, scanned, relation, count, lastDay }] }，只返回有记录的姓名
 * ref 为这一位的某条记录 id（礼台记账时回传，由服务端换成往来人 key），不把宾客 openid 交给前端
 */
async function nameCheck(ctx, names) {
  if (!ctx.account) return ok({ map: {} });
  const list = (Array.isArray(names) ? names : []).map(s => String(s || '').trim().slice(0, 20)).filter(Boolean).slice(0, 10);
  if (!list.length) return ok({ map: {} });
  const cond = { ownerOpenid: ctx.ownerOpenid, payerName: _.in(list), status: _.in(['paid', 'transferred', 'pending']) }; // 与宾客端口径一致
  if (ctx.bookIds) cond.bookId = _.in(ctx.bookIds);
  const res = await records.aggregate().match(cond)
    .group({
      _id: { name: '$payerName', openid: '$payerOpenid', tag: '$nameTag', pk: '$personKey' },
      count: _.aggregate.sum(1), relation: _.aggregate.first('$relation'), lastDay: _.aggregate.max('$payDay'), ref: _.aggregate.first('$_id')
    })
    .limit(500).end();
  const norm = s => String(s || '').replace(/[\s\u3000]/g, '');
  const map = {};
  (res.list || []).forEach(g => {
    const { name, openid, tag, pk } = g._id;
    const key = pk || (openid ? `o:${openid}:${norm(name)}` : `n:${norm(name)}${tag ? '#' + tag : ''}`);
    const arr = (map[name] = map[name] || []);
    const same = arr.find(x => x.key === key);
    if (same) { same.count += g.count; return; }
    arr.push({ key, ref: g.ref, tag: tag || '', scanned: !!openid, relation: g.relation || '', count: g.count, lastDay: g.lastDay || '' });
  });
  // 去掉内部 key（含宾客 openid）
  Object.keys(map).forEach(n => { map[n] = map[n].map(({ key, ...x }) => x); });
  return ok({ map });
}

/** 给宾客设区分备注：扫码宾客按微信身份改主家全部同名记录，礼台登记的只改这一条 */
async function setNameTag(ctx, rid, tag) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(rid || ''))) return err('参数错误');
  const t = String(tag || '').trim().replace(/[#:\s]/g, '').slice(0, 12);
  const rec = (await records.where({ _id: rid, ownerOpenid: ctx.ownerOpenid }).limit(1).get()).data[0];
  if (!rec || !canBook(ctx, rec.bookId)) return err('记录不存在');
  // 主家 / 记账人设的区分备注（nameTagBy=host）：只在主家这边显示，不印在给宾客的小票、回执上
  const data = { nameTag: t, nameTagBy: 'host' };
  if (rec.payerOpenid && !rec.personKey) {
    const cond = { ownerOpenid: ctx.ownerOpenid, payerOpenid: rec.payerOpenid, payerName: rec.payerName };
    if (ctx.bookIds) cond.bookId = _.in(ctx.bookIds); // 只负责部分礼簿：只改负责的礼簿里的
    await records.where(cond).update({ data });
  } else {
    await records.doc(rid).update({ data });
  }
  return ok({ tag: t });
}

/** 返回给前端的账目去掉宾客与经办人的 openid（前端用不到） */
// 返回给前端的记录：去掉各方 openid，以及含宾客 openid 的往来人标识
const strip = ({ payerOpenid, handlerOpenid, enteredBy, ownerOpenid, personKey, _openid, ...r }) => r;

/** 出现过的记账主题（导出筛选用） */
async function themes(openid, ctx) {
  // 只负责部分礼簿的记账人、家人共享：只列负责 / 共享的礼簿
  const res = await records.aggregate()
    .match({ ownerOpenid: openid, status: 'paid', ...(ctx.bookIds ? { bookId: _.in(ctx.bookIds) } : {}) })
    .group({ _id: '$themeName' })
    .limit(100)
    .end();
  return ok({ list: (res.list || []).map(t => t._id).filter(Boolean) });
}

const escapeReg = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
