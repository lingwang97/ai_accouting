// 云函数 books — 礼簿管理（一个主家可有多本礼簿：婚礼、满月、乔迁……）
// 当前礼簿记在 accounts.activeBookId，宾客随礼时记入当前礼簿
// 每本礼簿各存一套电子回执 / 打印样式（receiptTpl / printTpl），避免喜事、白事样式串场
// 份数与合计存在礼簿上（statCount / statFen，确认收到时累加），列表无需每次全量统计
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const books = db.collection('books');
const accounts = db.collection('accounts');
const records = db.collection('records');
const { resolveCtx, canBook, restricted, readonly, can, workBook, soloBook } = require('./ctx.js');
const trash = require('./trash.js');

const TYPES = ['wedding', 'birthday', 'baby', 'house', 'funeral', 'other'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const RECEIPT_FIELDS = ['receiptNo', 'payee', 'payerName', 'relation', 'amountUpper', 'theme', 'remark', 'paidAt'];
const RECEIPT_STYLES = ['card', 'ticket', 'simple'];
const PRINT_FIELDS = ['title', 'divider', 'theme', 'payDay', 'time', 'payerName', 'relation', 'amount', 'remark', 'thanks'];

/** 幂等建集合（init 未跑完时自愈；同一实例只尝试一次） */
let colReady = false;
async function ensureCol(name) {
  if (colReady) return;
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
  colReady = true;
}

exports.main = async (event) => {
  // 预热：warmer 云函数按「系统设置」定时唤醒，保持实例常驻、减少冷启动；直接返回，不做任何读写
  if (event && (event.action === '__warm' || event.Type === 'Timer')) return { code: 0, msg: 'warm', data: null }; // Timer：兼容之前上传过的旧预热触发器
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return err('未获取到用户身份');
  try {
    await ensureCol('books');
    // 记账人代主家操作：礼簿属于主家
    const ctx = await resolveCtx(db, OPENID);
    const account = ctx.account;
    if (!account) return err('请先完善主家信息');
    const OWNER = ctx.ownerOpenid;
    // 记账人按权限：「管理礼簿」新建 / 修改 / 切换 / 归档，「回执与打印样式」改样式；只能操作负责的礼簿
    if (['save', 'setActive', 'archive'].includes(event.action) && !can(ctx, 'books')) return err('你没有管理礼簿的权限');
    if (event.action === 'recalc' && !can(ctx, 'books')) return err('你没有管理礼簿的权限');
    if (event.action === 'recalc' && !canBook(ctx, String(event.bookId || ''))) return err('礼簿不存在');
    if (event.action === 'saveTpl' && !can(ctx, 'style')) return err('你没有修改回执与打印样式的权限');
    if (event.action === 'save' && event.book && event.book._id && !canBook(ctx, String(event.book._id))) return err('礼簿不存在');
    if (event.action === 'save' && event.book && !event.book._id && ctx.bookIds) return err('你只负责部分礼簿，不能新建礼簿');
    if (['setActive', 'archive', 'saveTpl'].includes(event.action) && !canBook(ctx, String(event.bookId || ''))) return err('礼簿不存在');
    if (event.action === 'getTpl' && !event.bookId) event.bookId = workBook(ctx); // 未指定时为正在记的礼簿，同样校验负责场次
    if (['stats', 'getTpl'].includes(event.action) && event.bookId && !canBook(ctx, String(event.bookId))) return err('礼簿不存在');
    switch (event.action) {
      case 'list': return await list(OWNER, account, ctx);
      case 'save': return await save(OWNER, account, event.book, ctx, OPENID);
      // 机构模式的记账人「设为当前」只切换自己正在记的一场，不改主家的当前礼簿
      case 'setActive': return ctx.role === 'clerk' && account.orgMode ? await setMine(ctx, String(event.bookId || '')) : await setActive(OWNER, account, event.bookId);
      case 'setMine': return await setMine(ctx, String(event.bookId || ''));
      case 'archive': return await archive(OWNER, account, event.bookId, event.archived !== false, ctx);
      // 删除礼簿（移入回收站，15 天内可恢复）：只限主家本人，只能删已归档的；先预览再确认
      case 'removePreview': return ctx.role === 'owner' ? await removeBook(OWNER, account, String(event.bookId || ''), false) : err('只有主家本人可以删除礼簿');
      case 'remove': return ctx.role === 'owner' ? await removeBook(OWNER, account, String(event.bookId || ''), true) : err('只有主家本人可以删除礼簿');
      // 回收站（只限主家本人）
      case 'trashList': return ctx.role === 'owner' ? await trashList(OWNER) : err('只有主家本人可以查看回收站');
      case 'trashRestore': return ctx.role === 'owner' ? await trashOp(OWNER, String(event.bookId || ''), 'restore') : err('只有主家本人可以恢复');
      case 'trashPurge': return ctx.role === 'owner' ? await trashOp(OWNER, String(event.bookId || ''), 'purge', event.confirmName) : err('只有主家本人可以删除');
      case 'stats': return await stats(OWNER, event.bookId, ctx);
      case 'recalc': return await recalc(OWNER, String(event.bookId || ''));
      case 'getTpl': return await getTpl(OWNER, account, event.bookId);
      case 'saveTpl': return await saveTpl(OWNER, event.bookId, event.receiptTpl, event.printTpl);
      default: return err('未知 action');
    }
  } catch (e) {
    console.error('books', event.action, e);
    return err('礼簿操作失败，请稍后重试');
  }
};

/** 礼簿列表；首次使用自动建默认礼簿，未归入礼簿的旧账目随时归入默认礼簿 */
async function list(openid, account, ctx) {
  let res = await books.where({ ownerOpenid: openid }).orderBy('createdAt', 'desc').limit(1000).get();
  if (res.data.length === 0) {
    const book = await ensureDefaultBook(openid, account);
    await accounts.doc(account._id).update({ data: { activeBookId: book._id, forwardTo: '' } });
    account.activeBookId = book._id;
    res = { data: [book] };
  }

  // 没有礼簿的账目（旧版数据、或主家尚未建礼簿时收到的随礼）归入默认礼簿
  if (await migrateOrphans(openid, account)) {
    res = await books.where({ ownerOpenid: openid }).orderBy('createdAt', 'desc').limit(1000).get();
  }

  // 旧礼簿（尚无累计值）一次性补算
  let stale = false;
  for (const b of res.data.filter(x => !x.statReady)) {
    if (await backfillStats(openid, b._id)) stale = true;
  }
  if (stale) res = await books.where({ ownerOpenid: openid }).orderBy('createdAt', 'desc').limit(1000).get();

  const visible = res.data.filter(b => canBook(ctx, b._id)); // 礼台人员只看负责的场次
  const showPdf = can(ctx, 'export') || readonly(ctx); // 家人共享与导出权限一致可看；没有「对账与导出」的记账人不返回存档文件
  return ok({
    activeBookId: canBook(ctx, workBook(ctx)) ? workBook(ctx) : '', // 机构模式记账人：自己选的一场
    restricted: restricted(ctx),
    perms: ctx.perms || [],
    list: visible.map(b => ({
      _id: b._id, name: b.name, type: b.type, date: b.date, location: b.location,
      archived: b.archived, archivePdf: showPdf ? (b.archivePdf || null) : null, // 存档 PDF 视同导出文件，需「对账与导出」
      pdfTheme: (b.pdfTheme && b.pdfTheme.key) || '', // 传统礼簿 PDF 主题（空为默认红金）
      pdfCustom: (b.pdfTheme && b.pdfTheme.key === 'custom' && b.pdfTheme.custom) || null,
      pdfBase: (b.pdfTheme && b.pdfTheme.base) || '', // 自定义基于哪个预设修改（仅记录）
      pdfBack: (b.pdfTheme && b.pdfTheme.back) || null, // 传统礼簿尾页设置
      pdfBind: (b.pdfTheme && b.pdfTheme.bind) || '',  // 装订：none | single | double（空为默认不留边）
      hostName: b.hostName || '',             // 机构版：本场主家称呼
      hasPayCode: !!b.payCodeFileID,          // 机构版：本场单独设置了收款码
      pendingPayCode: !!b.pendingPayCode,     // 记账人提交的本场收款码待主家确认
      count: b.statCount || 0,
      sum: (b.statFen || 0) / 100
    }))
  });
}

/** 默认礼簿：固定 _id，并发首次进入不会重复创建 */
async function ensureDefaultBook(openid, account) {
  const defId = 'default_' + account._id;
  try {
    return (await books.doc(defId).get()).data;
  } catch (e) { /* 尚未创建 */ }
  const name = (account.theme && account.theme.name && account.theme.name !== '默认主题') ? account.theme.name : '我的礼簿';
  try {
    return await create(openid, { name, type: 'other', date: '', location: '' }, defId);
  } catch (e) {
    return (await books.doc(defId).get()).data; // 已被并发请求创建
  }
}

/**
 * 无礼簿的账目归入默认礼簿：只补 bookId / bookType，保留原 themeName（旧版主题仍可区分、筛选）
 * 归入的已入簿礼金累加到默认礼簿合计。返回是否有归入
 */
const orphanCheckedAt = new Map();
async function migrateOrphans(openid, account) {
  const last = orphanCheckedAt.get(openid) || 0;
  if (Date.now() - last < 5 * 60 * 1000) return false;
  orphanCheckedAt.set(openid, Date.now());
  const orphanCond = { ownerOpenid: openid, bookId: _.exists(false).or(_.eq('')) };
  const n = (await records.where(orphanCond).count()).total;
  if (!n) return false;
  const book = await ensureDefaultBook(openid, account);
  const ids = (await records.where(orphanCond).field({ _id: true }).limit(1000).get()).data.map(r => r._id);
  if (!ids.length) return false;
  await records.where({ ownerOpenid: openid, _id: _.in(ids) })
    .update({ data: { bookId: book._id, bookType: 'other' } });
  // 按刚归入的记录（固定 _id 集合）统计并累加，避免与并发确认重复计算
  const sums = await records.aggregate()
    .match({ ownerOpenid: openid, status: 'paid', _id: _.in(ids) })
    .group({ _id: null, count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
    .end();
  const t = (sums.list && sums.list[0]) || { count: 0, fen: 0 };
  if (t.count) {
    await books.doc(book._id).update({ data: { statCount: _.inc(t.count), statFen: _.inc(Math.round(t.fen)) } });
  }
  return true;
}

/**
 * 旧礼簿一次性补算份数与合计（并发安全、中途失败可重试）：
 *  先记下分界时间 since 并统计 since 之前入簿的礼金，再用「statReady 还不是 true」作条件、一次写入
 *  statReady + statSince + 统计结果；之后确认收到（paidAt ≥ statSince）由 payment 累加，两部分互不重叠。
 *  统计失败或写入前中断：statReady 仍为 false，下次打开礼簿列表会重新补算（不会出现「已标记就绪但合计为 0」）。
 *  并发的两个补算：只有先写入的一个生效（返回 true），另一个条件不满足（返回 false），不会重复累加。
 *  说明：统计开始到写入完成之间（通常不到 1 秒）确认入簿的礼金，因 statReady 尚为 false 不会被累加，
 *  这是一次性补算（旧数据 / 累加失败后）的极小窗口；如需绝对准确可在礼簿页再次触发补算。
 */
async function backfillStats(openid, bookId) {
  const since = new Date();
  const sums = await records.aggregate()
    .match(_.and([
      { ownerOpenid: openid, status: 'paid', bookId },
      _.or([{ paidAt: _.lt(since) }, { paidAt: _.exists(false) }])
    ]))
    .group({ _id: null, count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
    .end();
  const t = (sums.list && sums.list[0]) || { count: 0, fen: 0 };
  const mark = await books.where({ _id: bookId, ownerOpenid: openid, statReady: _.neq(true) })
    .update({ data: { statReady: true, statSince: since, statCount: t.count || 0, statFen: Math.round(t.fen || 0) } });
  return mark.stats.updated === 1;
}

async function create(openid, b, id) {
  const data = {
    ownerOpenid: openid, ...b, archived: false, createdAt: new Date(),
    // 新礼簿从零开始累加；statSince 为分界时间（见 backfillStats）
    statCount: 0, statFen: 0, statReady: true, statSince: new Date(0)
  };
  const added = await books.add({ data: id ? { _id: id, ...data } : data });
  return { _id: added._id, ...data };
}

/**
 * 新建或修改礼簿；新建时 input.setActive=true 才设为当前礼簿（还没有当前礼簿时总是设为当前）；
 * 机构模式的记账人新建时不改主家的当前礼簿，设为自己正在记的一场
 * 机构版本场收款码：记账人新上传的先存为待确认（pendingPayCode），主家在「主家信息」页采用后才生效
 */
async function save(openid, account, input, ctx, caller) {
  input = input || {};
  const b = {
    name: String(input.name || '').trim().slice(0, 20),
    type: TYPES.includes(input.type) ? input.type : 'other',
    date: DAY_RE.test(input.date || '') ? input.date : '',
    location: String(input.location || '').trim().slice(0, 30),
    // 机构版：本场主家称呼与收款码（宾客的钱直接转给本场主家；为空则用主家信息里的）
    hostName: String(input.hostName || '').trim().slice(0, 20),
    payCodeFileID: /^cloud:\/\//.test(String(input.payCodeFileID || '')) ? String(input.payCodeFileID).slice(0, 200) : ''
  };
  if (!b.name) return err('请填写礼簿名称');
  // 未传的机构版字段保持原值（个人模式编辑礼簿时不会清掉）
  if (input.hostName === undefined) delete b.hostName;
  if (input.payCodeFileID === undefined) delete b.payCodeFileID;

  const old = input._id ? await getBook(openid, String(input._id)) : null;
  if (input._id && !old) return err('礼簿不存在');
  let pendingCode = false;
  if (b.payCodeFileID && b.payCodeFileID !== ((old && old.payCodeFileID) || '')) {
    // 收款码关系到钱进谁的账户：只能用本人刚上传的图片
    if (!ownPayCode(b.payCodeFileID, caller)) return err('收款码图片无效，请重新上传');
    if (ctx.role !== 'owner') {
      b.pendingPayCode = { fileID: b.payCodeFileID, by: (ctx.member && ctx.member.displayName) || (ctx.user && ctx.user.nickname) || '记账人', byOpenid: caller, at: new Date() };
      delete b.payCodeFileID;
      pendingCode = true;
    }
  } else if (b.payCodeFileID !== undefined && ctx.role === 'owner' && old && old.pendingPayCode) {
    b.pendingPayCode = _.remove(); // 主家自己清除 / 保留原码：之前待确认的作废
  }
  if (b.payCodeFileID === '' && ctx.role !== 'owner') delete b.payCodeFileID; // 记账人不能清空本场收款码，保持原值
  if (pendingCode) {
    await accounts.doc(account._id).update({ data: { payCodeCheck: true, payCodeBy: b.pendingPayCode.by } });
  }

  if (input._id) {
    const res = await books.where({ _id: String(input._id), ownerOpenid: openid }).update({ data: b });
    if (res.stats.updated !== 1) return err('礼簿不存在');
    // 改名 / 改事由后同步到账目冗余字段，保证筛选与导出一致（未改时跳过，避免整本改写）
    if (b.name !== old.name || b.type !== old.type) {
      await records.where({ ownerOpenid: openid, bookId: String(input._id) })
        .update({ data: { themeName: b.name, bookType: b.type } });
    }
    if (account.activeBookId === input._id) await syncThemeName(account, b.name);
    const { pendingPayCode, ...shown } = b;
    return ok({ book: { _id: input._id, ...shown }, pendingPayCode: pendingCode });
  }
  const book = await create(openid, b);
  let active = account.activeBookId || '';
  if (ctx.role === 'clerk' && account.orgMode) {
    if (input.setActive === true && ctx.member) await db.collection('members').doc(ctx.member._id).update({ data: { curBookId: book._id } });
  } else if (input.setActive === true || !account.activeBookId) {
    await accounts.doc(account._id).update({ data: { activeBookId: book._id, forwardTo: '' } });
    await syncThemeName(account, book.name);
    active = book._id;
  }
  const { pendingPayCode, ...shown } = book;
  return ok({ book: shown, activeBookId: active, pendingPayCode: pendingCode });
}

/** 机构模式：记账人切换自己正在记的一场（members.curBookId），不改主家的当前礼簿、不影响其他人 */
async function setMine(ctx, bookId) {
  if (ctx.role !== 'clerk' || !ctx.member) return err('参数错误');
  if (!ctx.account.orgMode) return err('只有机构模式可以切换场次');
  if (!canBook(ctx, bookId)) return err('礼簿不存在');
  const book = await getBook(ctx.ownerOpenid, bookId);
  if (!book) return err('礼簿不存在');
  if (book.archived) return err('已归档的礼簿不能切换');
  await db.collection('members').doc(ctx.member._id).update({ data: { curBookId: book._id } });
  return ok({ activeBookId: book._id, book: safeBook(book) });
}

async function setActive(openid, account, bookId) {
  const book = await getBook(openid, bookId);
  if (!book) return err('礼簿不存在');
  if (book.archived) return err('已归档的礼簿不能设为当前礼簿');
  await accounts.doc(account._id).update({ data: { activeBookId: book._id, forwardTo: '' } });
  await syncThemeName(account, book.name);
  return ok({ activeBookId: book._id, book: safeBook(book) });
}

/**
 * 归档 / 取消归档。归档时：自己选了这一场的机构记账人清掉选择（回到默认的礼簿）；
 * 返回仍负责这本、之后没有礼簿可记的记账人姓名（前端提示主家重新安排）
 */
async function archive(openid, account, bookId, archived, ctx) {
  const book = await getBook(openid, bookId);
  if (!book) return err('礼簿不存在');
  if (archived && account.activeBookId === book._id) return err('当前礼簿不能归档，请先切换到其他礼簿');
  // 取消归档：存档 PDF 已过期（之后礼簿会变），清掉字段并删文件；删文件失败不阻断取消归档（登记行保留，清除数据时仍会回收）
  const stale = !archived && book.archived && book.archivePdf && book.archivePdf.fileID ? String(book.archivePdf.fileID) : '';
  await books.doc(book._id).update({ data: stale ? { archived, archivePdf: _.remove() } : { archived } });
  if (stale && stale.includes('/archives/')) {
    try {
      await cloud.deleteFile({ fileList: [stale] });
      await db.collection('exports').where({ ownerOpenid: openid, fileID: stale }).remove();
    } catch (e) { console.warn('取消归档：删除存档 PDF 失败', e.message); }
  }
  let affected = [];
  if (archived) {
    const members = db.collection('members');
    await members.where({ aid: account._id, curBookId: book._id }).update({ data: { curBookId: '' } });
    const ms = (await members.where({ aid: account._id, role: _.neq('viewer'), _openid: _.exists(false) }).limit(100).get()).data;
    affected = ms.filter(m => (account.orgMode
      ? !m.allBooks && Array.isArray(m.bookIds) && m.bookIds.length && m.bookIds.every(id => id === book._id)
      : soloBook(m, account) === book._id)).map(m => m.displayName || '记账人');
  }
  return ok({ archived, affected });
}

/**
 * 删除礼簿（移入回收站，见 trash.js）：只能删已归档的；confirm=false 只预览（份数、合计、各状态笔数、受影响的记账人）
 * 数据多时分批移动，返回 done=false 时前端再调用一次接着移
 */
async function removeBook(openid, account, bookId, confirm) {
  // 上次没移完：按回收站里的进度继续
  let t = null;
  try { t = (await db.collection('trash_books').doc(bookId).get()).data; } catch (e) { /* 不在回收站 */ }
  if (t && confirm && t.ownerOpenid === openid && t.trashStatus === 'moving') return ok({ done: await trash.moveToTrash(db, openid, bookId, null) });
  const book = await getBook(openid, bookId);
  if (!book) return err('礼簿不存在');
  if (!book.archived) return err('请先归档这本礼簿，再删除');
  if (account.activeBookId === book._id) return err('当前礼簿不能删除，请先切换到其他礼簿');
  const members = db.collection('members');
  const ms = (await members.where({ aid: account._id, role: _.neq('viewer'), _openid: _.exists(false) }).limit(100).get()).data;
  const affected = ms.filter(m => (account.orgMode
    ? !m.allBooks && Array.isArray(m.bookIds) && m.bookIds.length && m.bookIds.every(id => id === book._id)
    : soloBook(m, account) === book._id)).map(m => m.displayName || '记账人');
  const [paid, all] = await Promise.all([
    records.aggregate().match({ ownerOpenid: openid, bookId: book._id, status: 'paid' })
      .group({ _id: null, count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) }).end(),
    records.where({ ownerOpenid: openid, bookId: book._id }).count()
  ]);
  const st = (paid.list && paid.list[0]) || { count: 0, fen: 0 };
  const summary = { name: book.name, count: st.count, sum: Math.round(st.fen) / 100, total: all.total, affected };
  if (!confirm) return ok({ ...summary, days: trash.TRASH_DAYS });
  const done = await trash.moveToTrash(db, openid, book._id, book, {
    aid: account._id, count: summary.count, sum: summary.sum, files: trash.filesOf(book, account, ownPayCode)
  });
  // 自己选了这一场的机构记账人：清掉选择
  await members.where({ aid: account._id, curBookId: book._id }).update({ data: { curBookId: '' } });
  return ok({ done, affected });
}

/** 回收站列表（含删除中 / 恢复中的） */
async function trashList(openid) {
  let res = { data: [] };
  try {
    res = await db.collection('trash_books').where({ ownerOpenid: openid, _openid: _.exists(false) }).orderBy('deletedAt', 'desc').limit(100)
      .field({ name: true, type: true, hostName: true, count: true, sum: true, deletedAt: true, purgeAt: true, trashStatus: true }).get();
  } catch (e) { /* 集合还不存在 */ }
  return ok({ list: res.data, days: trash.TRASH_DAYS });
}

/** 回收站里的一本：恢复 / 彻底删除（须输入礼簿名称） */
async function trashOp(openid, bookId, op, confirmName) {
  let t;
  try { t = (await db.collection('trash_books').doc(bookId).get()).data; } catch (e) { return err('回收站里没有这本礼簿'); }
  if (t.ownerOpenid !== openid || t._openid) return err('回收站里没有这本礼簿');
  if (op === 'restore') {
    const r = await trash.restore(db, openid, bookId);
    return r.error ? err(r.error) : ok({ done: r.done });
  }
  if (t.trashStatus === 'restoring') return err('这本礼簿正在恢复，请稍后再试');
  if (String(confirmName || '').trim() !== t.name) return err('输入的礼簿名称不一致');
  if (t.trashStatus === 'moving') {
    // 先移完再删：本次没移完（记录很多）就不能删，否则剩余礼金记录会成孤儿
    const moved = await trash.moveToTrash(db, openid, bookId, null);
    if (!moved) return err('这本礼簿仍在删除中，请稍后再试');
  }
  await trash.purge(db, cloud, { ...t, _id: bookId });
  return ok({ purged: true });
}

/** 单本礼簿统计：合计、份数、按关系分组 */
async function stats(openid, bookId, ctx) {
  const book = await getBook(openid, bookId);
  if (!book) return err('礼簿不存在');
  const match = { ownerOpenid: openid, status: 'paid', bookId: book._id };
  const [total, byRel, byMethod] = await Promise.all([
    records.aggregate().match(match)
      .group({ _id: null, count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])), maxAmount: _.aggregate.max('$amount') })
      .end(),
    records.aggregate().match(match)
      .group({ _id: '$relation', count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .limit(100)
      .end(),
    records.aggregate().match(match)
      .group({ _id: '$payMethod', count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .limit(10)
      .end()
  ]);
  // 支付方式分项（旧数据无 payMethod 视为微信）
  const method = { wechat: { count: 0, sum: 0 }, cash: { count: 0, sum: 0 } };
  (byMethod.list || []).forEach(m => {
    const k = m._id === 'cash' ? 'cash' : 'wechat';
    method[k].count += m.count;
    method[k].sum = Math.round(method[k].sum * 100 + m.fen) / 100;
  });
  const t = (total.list && total.list[0]) || { count: 0, fen: 0, maxAmount: 0 };
  await checkDrift(openid, book, t.count || 0, Math.round(t.fen || 0)); // 本来就做了实时聚合，顺带核对累计合计
  return ok({
    book: { ...safeBook(book), archivePdf: ctx && (can(ctx, 'export') || readonly(ctx)) ? (book.archivePdf || null) : null },
    count: t.count,
    sum: Math.round(t.fen) / 100,
    maxAmount: t.maxAmount || 0,
    byMethod: method,
    byRelation: (byRel.list || [])
      .map(r => ({ relation: r._id || '未填写', count: r.count, sum: Math.round(r.fen) / 100 }))
      .sort((a, b) => b.sum - a.sum)
  });
}

/**
 * 核对礼簿累计合计（statCount / statFen）与实时聚合：不一致时重读一次礼簿再比（排除刚入簿的并发），
 * 仍不一致就把 statReady 置 false，下次打开礼簿列表自动重算。只在本来就做了聚合的接口里调用，失败不影响主流程。
 */
async function checkDrift(openid, book, count, fen) {
  try {
    if (!book || !book.statReady) return false;
    if ((book.statCount || 0) === count && (book.statFen || 0) === fen) return false;
    const fresh = (await books.doc(book._id).get()).data;
    if (!fresh || fresh.ownerOpenid !== openid || !fresh.statReady) return false;
    if ((fresh.statCount || 0) === count && (fresh.statFen || 0) === fen) return false;
    await books.where({ _id: book._id, ownerOpenid: openid, statReady: true }).update({ data: { statReady: false } });
    console.warn('礼簿合计与记录不一致，已标记重算', book._id, fresh.statCount, count, fresh.statFen, fen);
    return true;
  } catch (e) { console.warn('核对合计失败', e.message); return false; }
}

/** 重算合计：先置为待补算，再立即补算（并发安全：只有一个补算会写入，见 backfillStats） */
async function recalc(openid, bookId) {
  const book = await getBook(openid, bookId);
  if (!book) return err('礼簿不存在');
  await books.where({ _id: book._id, ownerOpenid: openid }).update({ data: { statReady: false } });
  let wrote = false;
  try {
    wrote = await backfillStats(openid, book._id);
  } catch (e) {
    // 补算失败：statReady 保持 false，下次打开礼簿列表会自动重试
    console.error('重算合计失败', e);
    return err('重算失败，请稍后再试（下次打开礼簿列表会自动重算）');
  }
  const fresh = await getBook(openid, book._id);
  return ok({ count: (fresh && fresh.statCount) || 0, sum: ((fresh && fresh.statFen) || 0) / 100, recalculated: wrote });
}

/** 返回给前端的礼簿：不带主家 openid、收款码文件路径和待确认收款码的提交人 */
function safeBook(b) {
  return {
    _id: b._id, name: b.name, type: b.type, date: b.date || '', location: b.location || '',
    archived: !!b.archived, archivePdf: null, hostName: b.hostName || '',
    hasPayCode: !!b.payCodeFileID, pendingPayCode: !!b.pendingPayCode,
    count: b.statCount || 0, sum: (b.statFen || 0) / 100
  };
}

/** 读取礼簿的回执 / 打印样式；未设置时返回 null，由前端按事由类型套用场景默认 */
async function getTpl(openid, account, bookId) {
  const book = await getBook(openid, bookId || account.activeBookId);
  if (!book) return err('礼簿不存在');
  // 旧版全局打印模板里的纸宽是硬件设置，作为默认值沿用
  let paperWidth = 32;
  try {
    const t = (await db.collection('print_templates').where({ ownerOpenid: openid }).limit(1).get()).data[0];
    if (t && t.paperWidth === 48) paperWidth = 48;
  } catch (e) { /* 无旧模板 */ }
  return ok({
    book: { _id: book._id, name: book.name, type: book.type },
    receiptTpl: book.receiptTpl || null,
    printTpl: book.printTpl || null,
    paperWidth
  });
}

/** 保存礼簿的回执 / 打印样式（两者可只传其一） */
async function saveTpl(openid, bookId, receiptTpl, printTpl) {
  const book = await getBook(openid, bookId);
  if (!book) return err('礼簿不存在');
  const data = {};
  if (receiptTpl) {
    const t = receiptTpl;
    data.receiptTpl = _.set({
      title: String(t.title || '礼金回执').slice(0, 20),
      color: /^#[0-9a-fA-F]{6}$/.test(t.color || '') ? t.color : '#C8161D',
      style: RECEIPT_STYLES.includes(t.style) ? t.style : 'card',
      fields: Array.isArray(t.fields) ? t.fields.filter(f => RECEIPT_FIELDS.includes(f)).slice(0, 10) : RECEIPT_FIELDS,
      showStamp: t.showStamp !== false,
      stamp: String(t.stamp || '').slice(0, 4),
      footer: String(t.footer || '').slice(0, 60)
    });
  }
  if (printTpl) {
    const t = printTpl;
    const fields = Array.isArray(t.fields) ? t.fields.filter(f => PRINT_FIELDS.includes(f)).slice(0, 12) : PRINT_FIELDS;
    if (fields.length === 0) return err('至少保留一个打印字段');
    data.printTpl = _.set({
      paperWidth: t.paperWidth === 48 ? 48 : 32,
      fields,
      title: String(t.title || '礼金回执').slice(0, 30),
      showDivider: t.showDivider !== false,
      thanks: String(t.thanks || '').slice(0, 40),
      promo: t.promo !== false // 小票底部推广语
    });
  }
  if (!Object.keys(data).length) return err('参数错误');
  await books.doc(book._id).update({ data });
  return ok({ saved: Object.keys(data) });
}

/** 是否为该用户本人上传到 paycodes/ 目录的收款码（与 account 云函数一致） */
function ownPayCode(fileID, openid) {
  const esc = String(openid || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return !!esc && new RegExp(`^cloud://[^/]+/paycodes/(book-)?${esc}-\\d+\\.(png|jpe?g|webp)$`, 'i').test(String(fileID || ''));
}

async function getBook(openid, bookId) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(bookId || ''))) return null;
  try {
    const b = (await books.doc(bookId).get()).data;
    return b && b.ownerOpenid === openid ? b : null;
  } catch (e) {
    return null;
  }
}

/** 旧字段 accounts.theme.name 与当前礼簿名保持一致（兼容旧页面与导出主题筛选） */
async function syncThemeName(account, name) {
  await accounts.doc(account._id).update({ data: { 'theme.name': name } });
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
