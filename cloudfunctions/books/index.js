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

const TYPES = ['wedding', 'birthday', 'baby', 'house', 'funeral', 'other'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const RECEIPT_FIELDS = ['receiptNo', 'payee', 'payerName', 'relation', 'proxyFor', 'amountUpper', 'theme', 'remark', 'paidAt'];
const RECEIPT_STYLES = ['card', 'ticket', 'simple'];
const PRINT_FIELDS = ['title', 'divider', 'theme', 'payDay', 'time', 'payerName', 'relation', 'proxyFor', 'amount', 'remark', 'thanks'];

/** 幂等建集合（init 未跑完时自愈；同一实例只尝试一次） */
let colReady = false;
async function ensureCol(name) {
  if (colReady) return;
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
  colReady = true;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    await ensureCol('books');
    const account = (await accounts.where({ ownerOpenid: OPENID }).limit(1).get()).data[0];
    if (!account) return err('请先完善主家信息');
    switch (event.action) {
      case 'list': return await list(OPENID, account);
      case 'save': return await save(OPENID, account, event.book);
      case 'setActive': return await setActive(OPENID, account, event.bookId);
      case 'archive': return await archive(OPENID, account, event.bookId, event.archived !== false);
      case 'stats': return await stats(OPENID, event.bookId);
      case 'getTpl': return await getTpl(OPENID, account, event.bookId);
      case 'saveTpl': return await saveTpl(OPENID, event.bookId, event.receiptTpl, event.printTpl);
      default: return err('未知 action');
    }
  } catch (e) {
    return err('礼簿操作失败：' + e.message);
  }
};

/** 礼簿列表；首次使用自动建默认礼簿，未归入礼簿的旧账目随时归入默认礼簿 */
async function list(openid, account) {
  let res = await books.where({ ownerOpenid: openid }).orderBy('createdAt', 'desc').limit(100).get();
  if (res.data.length === 0) {
    const book = await ensureDefaultBook(openid, account);
    await accounts.doc(account._id).update({ data: { activeBookId: book._id } });
    account.activeBookId = book._id;
    res = { data: [book] };
  }

  // 没有礼簿的账目（旧版数据、或主家尚未建礼簿时收到的随礼）归入默认礼簿
  if (await migrateOrphans(openid, account)) {
    res = await books.where({ ownerOpenid: openid }).orderBy('createdAt', 'desc').limit(100).get();
  }

  // 旧礼簿（尚无累计值）一次性补算
  let stale = false;
  for (const b of res.data.filter(x => !x.statReady)) {
    if (await backfillStats(openid, b._id)) stale = true;
  }
  if (stale) res = await books.where({ ownerOpenid: openid }).orderBy('createdAt', 'desc').limit(100).get();

  return ok({
    activeBookId: account.activeBookId || '',
    list: res.data.map(b => ({
      _id: b._id, name: b.name, type: b.type, date: b.date, location: b.location,
      archived: b.archived, archivePdf: b.archivePdf || null,
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
async function migrateOrphans(openid, account) {
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
 * 旧礼簿一次性补算份数与合计（并发安全）：
 *  先原子地标记 statReady 并记下分界时间 statSince，之后确认收到（paidAt ≥ statSince）由 payment 累加；
 *  再把分界之前入簿的礼金统计后累加上去，两部分互不重叠
 */
async function backfillStats(openid, bookId) {
  const since = new Date();
  const mark = await books.where({ _id: bookId, ownerOpenid: openid, statReady: _.neq(true) })
    .update({ data: { statReady: true, statSince: since, statCount: 0, statFen: 0 } });
  if (mark.stats.updated !== 1) return false; // 已被其他请求补算
  const sums = await records.aggregate()
    .match(_.and([
      { ownerOpenid: openid, status: 'paid', bookId },
      _.or([{ paidAt: _.lt(since) }, { paidAt: _.exists(false) }])
    ]))
    .group({ _id: null, count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
    .end();
  const t = (sums.list && sums.list[0]) || { count: 0, fen: 0 };
  if (t.count) {
    await books.doc(bookId).update({ data: { statCount: _.inc(t.count), statFen: _.inc(Math.round(t.fen)) } });
  }
  return true;
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

/** 新建或修改礼簿；新建的礼簿自动设为当前礼簿 */
async function save(openid, account, input) {
  input = input || {};
  const b = {
    name: String(input.name || '').trim().slice(0, 20),
    type: TYPES.includes(input.type) ? input.type : 'other',
    date: DAY_RE.test(input.date || '') ? input.date : '',
    location: String(input.location || '').trim().slice(0, 30)
  };
  if (!b.name) return err('请填写礼簿名称');

  if (input._id) {
    const res = await books.where({ _id: String(input._id), ownerOpenid: openid }).update({ data: b });
    if (res.stats.updated !== 1) return err('礼簿不存在');
    // 改名后同步到账目冗余字段，保证筛选与导出一致
    await records.where({ ownerOpenid: openid, bookId: String(input._id) })
      .update({ data: { themeName: b.name, bookType: b.type } });
    if (account.activeBookId === input._id) await syncThemeName(account, b.name);
    return ok({ book: { _id: input._id, ...b } });
  }
  const book = await create(openid, b);
  await accounts.doc(account._id).update({ data: { activeBookId: book._id } });
  await syncThemeName(account, book.name);
  return ok({ book, activeBookId: book._id });
}

async function setActive(openid, account, bookId) {
  const book = await getBook(openid, bookId);
  if (!book) return err('礼簿不存在');
  if (book.archived) return err('已归档的礼簿不能设为当前礼簿');
  await accounts.doc(account._id).update({ data: { activeBookId: book._id } });
  await syncThemeName(account, book.name);
  return ok({ activeBookId: book._id, book });
}

async function archive(openid, account, bookId, archived) {
  const book = await getBook(openid, bookId);
  if (!book) return err('礼簿不存在');
  if (archived && account.activeBookId === book._id) return err('当前礼簿不能归档，请先切换到其他礼簿');
  await books.doc(book._id).update({ data: { archived } });
  return ok({ archived });
}

/** 单本礼簿统计：合计、份数、按关系分组 */
async function stats(openid, bookId) {
  const book = await getBook(openid, bookId);
  if (!book) return err('礼簿不存在');
  const match = { ownerOpenid: openid, status: 'paid', bookId: book._id };
  const [total, byRel] = await Promise.all([
    records.aggregate().match(match)
      .group({ _id: null, count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])), maxAmount: _.aggregate.max('$amount') })
      .end(),
    records.aggregate().match(match)
      .group({ _id: '$relation', count: _.aggregate.sum(1), fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) })
      .limit(100)
      .end()
  ]);
  const t = (total.list && total.list[0]) || { count: 0, fen: 0, maxAmount: 0 };
  return ok({
    book,
    count: t.count,
    sum: Math.round(t.fen) / 100,
    maxAmount: t.maxAmount || 0,
    byRelation: (byRel.list || [])
      .map(r => ({ relation: r._id || '未填写', count: r.count, sum: Math.round(r.fen) / 100 }))
      .sort((a, b) => b.sum - a.sum)
  });
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
      thanks: String(t.thanks || '').slice(0, 40)
    });
  }
  if (!Object.keys(data).length) return err('参数错误');
  await books.doc(book._id).update({ data });
  return ok({ saved: Object.keys(data) });
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
