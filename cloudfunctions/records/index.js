// 云函数 records — 账目列表 / 汇总 / 打印标记（文档 §5、§8）
const cloud = require('wx-server-sdk');
const { ok, err, bjDay, bjHour } = require('./common.js');
const { REC, MEMBER, PENDING_TTL, STALL_MS, STALL_KEEP_MS, UNREJECT_MS, LISTED, COUNTED } = require('./status.js');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const records = db.collection('records');
const { resolveCtx, canBook, readonly, can, workBook } = require('./ctx.js');

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
        return await pending(OWNER, ctx, event.withRejected === true);
      case 'pendingStat':
        return await pendingStat(OWNER, ctx, OPENID, event.withExtra === true);
      case 'themes':
        return await themes(OWNER, ctx);
      // 同名区分：礼台记账前查礼簿里同名的人；给某位宾客设区分备注
      case 'nameCheck':
        if (!can(ctx, 'desk')) return err('无权查询');
        return await nameCheck(ctx, event.names, event.bookId);
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
  // 失败只记日志：这是顺带的维护写操作，不能拖垮列表 / 工作台 / 待确认等读接口（下一分钟会重试）
  try {
    await records.where({
      ownerOpenid: openid,
      status: REC.PENDING,
      batchPay: _.neq('mixed'),
      createdAt: _.lt(new Date(Date.now() - PENDING_TTL))
    }).update({ data: { status: REC.CANCELLED, autoCancelled: true } });
  } catch (e) { console.warn('自动取消超时未转账记录失败', e.message); }
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
  const pendCond = { ownerOpenid: owner, status: REC.TRANSFERRED, bookId: activeId || '__none__' };
  const [bookRes, todayRes, pendRes, pendCount, otherCount, todayBookRes, joinRes] = await Promise.all([
    activeId ? db.collection('books').doc(activeId).get().catch(() => null) : null,
    records.aggregate()
      .match({ ownerOpenid: owner, status: REC.PAID, payDay: today, ...scope })
      .group({ _id: null, count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .end(),
    // 待确认份数与合计：计数 + 聚合（不受单次查询 100 条限制）
    records.aggregate().match(pendCond)
      .group({ _id: null, fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .end(),
    records.where(pendCond).count(),
    records.where(otherPendCond(ctx, activeId)).count(),
    // 当前礼簿的今日入簿份数：前端据此判断「今日新增」是否与礼簿合计重复
    activeId ? records.where({ ownerOpenid: owner, status: REC.PAID, payDay: today, bookId: activeId }).count() : null,
    // 主家：通过邀请卡申请加入、待同意的人数
    ctx.role === 'owner' ? db.collection('members').where({ aid: account._id, status: MEMBER.PENDING }).count() : null
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
  else if (ctx.role === 'clerk' && shown.payCodeFileID) shown.payCodeFileID = '@current'; // 路径含主家 openid，占位值见 account.KEEP_CODE
  return ok({
    account: { ...shown, hasPayCode: !!account.payCodeFileID, hasPendingPayCode: !!pendingPayCode },
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
    today: { count: t.count, sum: Math.round(t.fen) / 100, book: todayBookRes ? todayBookRes.total : 0 },
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
    const show = ms.filter(m => m.status === MEMBER.PENDING || (m.approvedAt && new Date(m.approvedAt).getTime() > week && m.aid !== cur));
    if (!show.length) return [];
    const accs = (await db.collection('accounts').where({ _id: _.in(show.map(m => m.aid)) }).field({ accountName: true }).get()).data;
    const name = id => (accs.find(a => a._id === id) || {}).accountName || '主家';
    return show.map(m => ({ aid: m.aid, name: name(m.aid), role: m.role, pending: m.status === MEMBER.PENDING }));
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
  // 按礼簿分批聚合（每批 50 本）：每本最多 4 组（状态 × 方式）/ 若干记账人，单批分组数远低于 limit，场次很多时不会被截断
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const [byBookParts, byStaffParts, members] = await Promise.all([
    Promise.all(chunks.map(c => records.aggregate()
      .match({ ownerOpenid: owner, bookId: _.in(c), status: _.in([REC.PAID, REC.TRANSFERRED]) })
      .group({ _id: { bookId: '$bookId', status: '$status', method: '$payMethod' }, count: _.aggregate.sum(1), fen: fenOf })
      .limit(1000).end())),
    Promise.all(chunks.map(c => records.aggregate()
      .match({ ownerOpenid: owner, bookId: _.in(c), status: REC.PAID })
      .group({ _id: { bookId: '$bookId', handler: '$handlerOpenid' }, name: _.aggregate.first('$handlerName'), count: _.aggregate.sum(1), fen: fenOf })
      .limit(1000).end())),
    db.collection('members').where({ aid: ctx.account._id }).limit(100).get()
  ]);
  const byBook = { list: byBookParts.flatMap(r => r.list || []) };
  const byStaff = { list: byStaffParts.flatMap(r => r.list || []) };
  members.data = members.data.filter(m => m.status !== MEMBER.PENDING); // 待主家同意的不算
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
    if (g._id.status === REC.TRANSFERRED) { r.pending += g.count; return; }
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
  const [byStatus, deskCash, diff, byHandler, deskWechat, mixedRes, mixedBatches] = await Promise.all([
    records.aggregate().match(base)
      .group({ _id: { status: '$status', method: '$payMethod' }, count: _.aggregate.sum(1), fen: fenOf })
      .limit(100).end(),
    records.aggregate().match({ ...base, status: REC.PAID, payMethod: 'cash', payerOpenid: '' })
      .group({ _id: null, count: _.aggregate.sum(1), fen: fenOf }).end(),
    // 按实际到账入簿：宾客登记金额与实收不一致的
    records.aggregate().match({ ...base, status: REC.PAID, declaredAmount: _.exists(true) })
      .group({ _id: null, count: _.aggregate.sum(1), fen: fenOf, declaredFen: _.aggregate.sum(_.aggregate.multiply(['$declaredAmount', 100])) })
      .end(),
    records.aggregate().match({ ...base, status: REC.PAID })
      .group({ _id: { handler: '$handlerOpenid', method: '$payMethod' }, name: _.aggregate.first('$handlerName'), count: _.aggregate.sum(1), fen: fenOf })
      .limit(200).end(),
    // 礼台登记的微信（宾客当面转账、礼台看到到账后登记）
    records.aggregate().match({ ...base, status: REC.PAID, payMethod: 'wechat', payerOpenid: '' })
      .group({ _id: null, count: _.aggregate.sum(1), fen: fenOf }).end(),
    // 「转账+现金」批次：按支付方式汇总金额（分组数固定很少），批次数另用 count 取，不依赖聚合 limit 上限
    records.aggregate().match({ ...base, status: REC.PAID, batchPay: 'mixed' })
      .group({ _id: '$payMethod', fen: fenOf }).limit(10).end(),
    records.aggregate().match({ ...base, status: REC.PAID, batchPay: 'mixed' })
      .group({ _id: '$batchId' }).count('n').end()
  ]);

  const z = () => ({ count: 0, fen: 0 });
  const s = { paid: z(), wechat: z(), cash: z(), transferred: z(), pending: z(), rejected: z(), void: z(), cancelled: z() };
  (byStatus.list || []).forEach(g => {
    const st = g._id.status;
    const add = (k) => { s[k].count += g.count; s[k].fen += Math.round(g.fen); };
    if (st === REC.PAID) {
      add('paid');
      add(g._id.method === 'cash' ? 'cash' : 'wechat');
    } else if (s[st]) {
      add(st);
    }
  });
  // 全部入簿（未按日筛选）时顺带核对礼簿累计合计，不一致则标记重算（下次礼簿列表自动补算）
  if (!base.payDay) await checkStatDrift(owner, book, s.paid.count, s.paid.fen);
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
  const mx = { batches: ((mixedBatches.list && mixedBatches.list[0]) || {}).n || 0, wechatFen: 0, cashFen: 0 };
  (mixedRes.list || []).forEach(g => {
    if (g._id === 'cash') mx.cashFen += Math.round(g.fen); else mx.wechatFen += Math.round(g.fen);
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
    mixed: { batches: mx.batches, wechat: mx.wechatFen / 100, cash: mx.cashFen / 100, sum: (mx.wechatFen + mx.cashFen) / 100 },
    transferred: y(s.transferred),
    pending: y(s.pending),
    rejected: y(s.rejected),
    void: y(s.void),
    diff: { count: d.count, declared: Math.round(d.declaredFen) / 100, actual: Math.round(d.fen) / 100, gap: Math.round(d.fen - d.declaredFen) / 100 },
    handlers: Object.values(hs).map(h => ({ name: h.name, count: h.count, sum: h.fen / 100, cashCount: h.cashCount, cashSum: h.cashFen / 100 }))
      .sort((a, b) => b.sum - a.sum)
  });
}

/** 核对礼簿 statCount / statFen 与实时聚合：重读一次排除并发入簿，仍不一致才置 statReady=false；失败不影响对账 */
async function checkStatDrift(owner, book, count, fen) {
  try {
    if (!book || !book.statReady) return;
    if ((book.statCount || 0) === count && (book.statFen || 0) === fen) return;
    const bk = db.collection('books');
    const fresh = (await bk.doc(book._id).get()).data;
    if (!fresh || fresh.ownerOpenid !== owner || !fresh.statReady) return;
    if ((fresh.statCount || 0) === count && (fresh.statFen || 0) === fen) return;
    await bk.where({ _id: book._id, ownerOpenid: owner, statReady: true }).update({ data: { statReady: false } });
    console.warn('礼簿合计与记录不一致，已标记重算', book._id);
  } catch (e) { console.warn('核对合计失败', e.message); }
}

/** 分页 + 全量汇总；按日/关键词筛选 */
const DUP_MAX = 100;
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
  const paidCond = withKw({ ...base, status: REC.PAID });
  // 状态筛选只影响列表行与 listTotal；顶部合计 / 笔数 / 待确认数仍是整本口径
  // confirm = 待确认页同口径（status 'transferred'，行内有确认按钮）；paid = 已入簿；其余 = 全部
  const stFilter = event.status === 'confirm' ? [REC.TRANSFERRED] : event.status === 'paid' ? [REC.PAID] : LISTED.slice();
  const listCond = withKw({ ...base, status: _.in(stFilter) });
  const pendingCond = withKw({ ...base, status: REC.TRANSFERRED });

  // 排序白名单，非法值回落到时间倒序；都带 _id 作第二键，同时间 / 同金额翻页不重不漏
  const sortKey = ['time_desc', 'time_asc', 'amount_desc', 'amount_asc', 'name', 'dup'].includes(event.sort) ? event.sort : 'time_desc';

  // 只看重名：同样的条件（礼簿 / 状态 / 关系 / 搜索）下按姓名分组计数，取出现 2 次及以上的名字再查列表
  // 名字上限 DUP_MAX 个（_.in 不宜过长）；超出只取前面的并返回 dupTruncated
  let dupCount = null, dupTruncated = false, dupNames = [];
  if (sortKey === 'dup') {
    const g = await records.aggregate().match(listCond)
      .group({ _id: '$payerName', n: _.aggregate.sum(1) })
      .match({ n: _.gte(2) })
      .limit(DUP_MAX + 1)
      .end();
    dupNames = (g.list || []).filter(x => x._id).slice(0, DUP_MAX);
    dupTruncated = (g.list || []).length > DUP_MAX;
    dupCount = {};
    dupNames.forEach(x => { dupCount[x._id] = x.n; });
  }
  const pageCond = sortKey !== 'dup' ? listCond
    : _.and([listCond, dupNames.length ? { payerName: _.in(dupNames.map(x => x._id)) } : { _id: '__none__' }]);
  let listQ = records.where(pageCond);
  if (sortKey === 'amount_desc') listQ = listQ.orderBy('amount', 'desc').orderBy('_id', 'desc');
  else if (sortKey === 'amount_asc') listQ = listQ.orderBy('amount', 'asc').orderBy('_id', 'asc');
  // 按姓名 / 重名：按字符编码排序（不是拼音），同名的挨在一起，同名内按时间
  else if (sortKey === 'name' || sortKey === 'dup') listQ = listQ.orderBy('payerName', 'asc').orderBy('createdAt', 'asc').orderBy('_id', 'asc');
  else if (sortKey === 'time_asc') listQ = listQ.orderBy('createdAt', 'asc').orderBy('_id', 'asc');
  else listQ = listQ.orderBy('createdAt', 'desc').orderBy('_id', 'desc');

  const [totalRes, pendingRes, listTotalRes, sumRes, listRes] = await Promise.all([
    records.where(paidCond).count(),
    records.where(pendingCond).count(),
    records.where(pageCond).count(),
    // 汇总用聚合避免拉全量
    records.aggregate().match(paidCond)
      .group({ _id: null, totalFen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .end(),
    // statOnly：轮询只要合计与计数，不取列表行
    event.statOnly ? { data: [] } : listQ
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()
  ]);

  const totalFen = (sumRes.list && sumRes.list[0] && sumRes.list[0].totalFen) || 0;
  return ok({
    list: listRes.data.map(r => { const o = strip(r); if (dupCount) o.dupN = dupCount[r.payerName] || 0; return o; }),
    dupTruncated,
    total: totalRes.total,          // 已确认笔数
    pendingCount: pendingRes.total, // 待确认笔数
    workBookId: workBook(ctx) || '', // 当前礼簿：只有这一本的待确认可在列表里直接确认
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
/** 「宾客未点完成」条件（pending 与 pendingStat 共用，口径必须一致） */
function stallCondOf(openid, bk, now) {
  return _.or([
    { ownerOpenid: openid, status: REC.PENDING, createdAt: _.lt(new Date(now - STALL_MS)), bookId: bk },
    { ownerOpenid: openid, status: REC.CANCELLED, autoCancelled: true, stallDismissed: _.neq(true), createdAt: _.gt(new Date(now - STALL_KEEP_MS)), bookId: bk }
  ]);
}
/** 「最近标记未收到」条件 */
function rejectedCondOf(openid, cur, now) {
  return { ownerOpenid: openid, status: REC.REJECTED, bookId: cur, rejectedAt: _.gt(new Date(now - UNREJECT_MS)) };
}
async function pending(openid, ctx, withRejected) {
  // 只取当前礼簿（workBook）的待确认；确认接口同样限定当前礼簿，避免跨礼簿确认
  const cur = workBook(ctx);
  const bk = cur || '__none__';
  const cond = { ownerOpenid: openid, status: REC.TRANSFERRED, bookId: bk };
  const now = Date.now();
  const stallCond = stallCondOf(openid, bk, now);
  const [res, cnt, stall, other, bookRes, rejRes] = await Promise.all([
    records.where(cond).orderBy('createdAt', 'desc').limit(100).get(),
    records.where(cond).count(),
    records.where(stallCond).orderBy('createdAt', 'desc').limit(100).get(),
    records.where(otherPendCond(ctx, cur)).count(),
    cur ? db.collection('books').doc(cur).get().catch(() => null) : null,
    // 最近 24 小时内标记「未收到」的（可撤销）：只有待确认页请求时才查，需要确认收礼权限
    withRejected && cur && can(ctx, 'confirm')
      ? records.where(rejectedCondOf(openid, cur, now)).orderBy('rejectedAt', 'desc').limit(50).get().catch(() => null)
      : null
  ]);
  const b = bookRes && bookRes.data;
  const bookName = b && b.ownerOpenid === openid ? (b.hostName ? `${b.hostName} · ${b.name}` : b.name) : '';
  return ok({ list: res.data.map(strip), count: cnt.total, stalled: stall.data.map(strip), bookName, otherCount: other.total, rejected: rejRes ? rejRes.data.map(strip) : [] });
}

/**
 * 其他礼簿（非当前礼簿，且在可见范围内）的待确认条件：只用来计数提示
 * 不计没有 bookId（缺字段或空串）的旧数据：它们不属于任何礼簿，切换后也看不到，会由 books.list 归入默认礼簿
 */
function otherPendCond(ctx, cur) {
  const ids = ctx.bookIds ? ctx.bookIds.filter(id => id !== cur && id !== '__none__') : null;
  return {
    ownerOpenid: ctx.ownerOpenid, status: REC.TRANSFERRED,
    bookId: ids ? _.in(ids.length ? ids : ['__none__']) : _.exists(true).and(_.nin([cur || '__none__', '']))
  };
}

/** 待确认份数与合计（工作台轮询用，只做计数 + 聚合） */
// withExtra（待确认页轮询）：另返回 stall / rej 两个分组的条数，页面据此判断是否需要重拉完整列表（旧前端不传，行为不变）
async function pendingStat(openid, ctx, selfOpenid, withExtra) {
  if (!ctx.account) return ok({ count: 0, sum: 0, remindDue: await remindDue(selfOpenid) });
  const cur = workBook(ctx);
  const cond = { ownerOpenid: openid, status: REC.TRANSFERRED, bookId: cur || '__none__' };
  const now = Date.now();
  const [cnt, agg, other, due, stall, rej] = await Promise.all([
    records.where(cond).count(),
    records.aggregate().match(cond)
      .group({ _id: null, fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .end(),
    records.where(otherPendCond(ctx, cur)).count(),
    remindDue(selfOpenid),
    withExtra && cur ? records.where(stallCondOf(openid, cur, now)).count().catch(() => null) : null,
    withExtra && cur && can(ctx, 'confirm') ? records.where(rejectedCondOf(openid, cur, now)).count().catch(() => null) : null
  ]);
  const out = { count: cnt.total, sum: Math.round(((agg.list && agg.list[0]) || { fen: 0 }).fen) / 100, other: other.total, remindDue: due };
  if (withExtra) { out.stall = stall ? stall.total : -1; out.rej = rej ? rej.total : -1; } // -1：未查询 / 无权限，页面不据此刷新
  return ok(out);
}

/**
 * 往来页「待回礼」红点：本人（登录微信，不随记账人身份变）是否有到期未处理的办事提醒。
 * 口径与 pages/renqing 的 hot / past 一致：未处理，且（办事日已过，或办事日未过且已到提醒时间）。
 * 旧提醒无 remindAt：按提醒日（notifyDay，缺省办事日）9:00。日期按北京时间。失败返回 false，不影响待确认计数。
 */
async function remindDue(openid) {
  try {
    if (!openid) return false;
    const nowD = new Date(); // 日期 / 小时按北京时间
    const today = bjDay(nowD), hour = bjHour(nowD);
    const or = [
      { date: _.lt(today) },
      { date: _.gte(today), remindAt: _.lte(new Date()) },
      { date: _.gte(today), remindAt: _.exists(false), notifyDay: _.lt(today) }
    ];
    if (hour >= 9) {
      or.push({ date: _.gte(today), remindAt: _.exists(false), notifyDay: today });
      or.push({ date: today, remindAt: _.exists(false), notifyDay: _.exists(false) });
    }
    // 条件必须放在同一个 where 里：连续调用 where 时后一个会覆盖前一个（曾因此丢掉 ownerOpenid / done，算到了别人的提醒）
    const r = await db.collection('reminders').where(_.and([{ ownerOpenid: openid, done: false }, _.or(or)])).count();
    return r.total > 0;
  } catch (e) { return false; }
}

/**
 * 礼簿（主家全部礼簿，受限记账人为负责的礼簿）里同名的人：按 微信身份 / 区分备注 / 指定的人 分组
 * 返回 { 姓名: [{ ref, tag, scanned, relation, count, lastDay }] }，只返回有记录的姓名
 * ref 为这一位的某条记录 id（礼台记账时回传，由服务端换成往来人 key），不把宾客 openid 交给前端
 * inBook：这一位在「本场」礼簿里的条数（v3.50.0）。本场 = 本次要记入的礼簿，取法与 payment.cashEntry 一致：
 * 传入的 bookId（须是自己可记的），否则 workBook(ctx)；旧前端不传 bookId 时按 workBook 算，也不读 inBook
 */
async function nameCheck(ctx, names, bookIdIn) {
  if (!ctx.account) return ok({ map: {} });
  const list = (Array.isArray(names) ? names : []).map(s => String(s || '').trim().slice(0, 20)).filter(Boolean).slice(0, 10);
  if (!list.length) return ok({ map: {} });
  const cond = { ownerOpenid: ctx.ownerOpenid, payerName: _.in(list), status: _.in(COUNTED.slice()) }; // 与宾客端口径一致
  if (ctx.bookIds) cond.bookId = _.in(ctx.bookIds);
  let curBook = String(bookIdIn || '').slice(0, 64);
  if (!curBook || !canBook(ctx, curBook)) curBook = workBook(ctx) || '';
  const res = await records.aggregate().match(cond)
    .group({
      _id: { name: '$payerName', openid: '$payerOpenid', tag: '$nameTag', pk: '$personKey', bk: '$bookId' },
      count: _.aggregate.sum(1), relation: _.aggregate.first('$relation'), lastDay: _.aggregate.max('$payDay'), ref: _.aggregate.first('$_id')
    })
    .limit(500).end();
  const norm = s => String(s || '').replace(/[\s\u3000]/g, '');
  const map = {};
  (res.list || []).forEach(g => {
    const { name, openid, tag, pk, bk } = g._id;
    const here = curBook && bk === curBook ? g.count : 0;
    const key = pk || (openid ? `o:${openid}:${norm(name)}` : `n:${norm(name)}${tag ? '#' + tag : ''}`);
    const arr = (map[name] = map[name] || []);
    const same = arr.find(x => x.key === key);
    if (same) {
      same.count += g.count; same.inBook += here;
      if ((g.lastDay || '') > same.lastDay) same.lastDay = g.lastDay;
      if (!same.relation && g.relation) same.relation = g.relation;
      if (here) same.ref = g.ref; // 本场有记录时 ref 取本场的，往来人标识更贴近当前
      return;
    }
    arr.push({ key, ref: g.ref, tag: tag || '', scanned: !!openid, relation: g.relation || '', count: g.count, inBook: here, lastDay: g.lastDay || '' });
  });
  // 去掉内部 key（含宾客 openid）
  Object.keys(map).forEach(n => { map[n] = map[n].map(({ key, ...x }) => x); });
  return ok({ map });
}

/** 给宾客设区分备注：扫码宾客按微信身份改主家全部同名记录，礼台登记的只改这一条 */
async function setNameTag(ctx, rid, tag) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(rid || ''))) return err('参数错误');
  const t = String(tag || '').replace(/[\x00-\x1f\x7f]/g, '').trim().replace(/[#:\s]/g, '').slice(0, 12);
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
const strip = ({ payerOpenid, handlerOpenid, enteredBy, ownerOpenid, personKey, rcptToken, rcptQrKey, rcptQrFileID, claimedOpenid, claimedAt, _openid, ...r }) => (claimedOpenid ? { ...r, claimed: true } : r); // 小票二维码 token 与认领人不返回前端

/** 出现过的记账主题（导出筛选用） */
async function themes(openid, ctx) {
  // 只负责部分礼簿的记账人、家人共享：只列负责 / 共享的礼簿
  const res = await records.aggregate()
    .match({ ownerOpenid: openid, status: REC.PAID, ...(ctx.bookIds ? { bookId: _.in(ctx.bookIds) } : {}) })
    .group({ _id: '$themeName' })
    .limit(1000)
    .end();
  return ok({ list: (res.list || []).map(t => t._id).filter(Boolean) });
}

const escapeReg = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
