// namecheck.js — 礼簿里同名的宾客（records.nameCheck 与 payment.cashEntry 共用，v3.66.0）
// 由 tools/sync_shared.py 复制到 records、payment，改这里后运行同步
const { COUNTED } = require('./status.js');
const { canBook, workBook } = require('./ctx.js');

/**
 * 礼簿（主家全部礼簿，受限记账人为负责的礼簿）里同名的人：按 微信身份 / 区分备注 / 指定的人 分组
 * 返回 { 姓名: [{ ref, tag, scanned, relation, count, inBook, lastDay }] }，只返回有记录的姓名
 * ref 为这一位的某条记录 id（礼台记账时回传，由服务端换成往来人 key），不把宾客 openid 交给前端
 * inBook：这一位在「本场」礼簿里的条数。本场 = 本次要记入的礼簿：传入的 bookId（须是自己可记的），否则 workBook(ctx)
 */
async function nameCheckMap(db, ctx, names, bookIdIn) {
  if (!ctx.account) return {};
  const _ = db.command;
  const list = (Array.isArray(names) ? names : []).map(s => String(s || '').trim().slice(0, 20)).filter(Boolean).slice(0, 10);
  if (!list.length) return {};
  const cond = { ownerOpenid: ctx.ownerOpenid, payerName: _.in(list), status: _.in(COUNTED.slice()) }; // 与宾客端口径一致
  if (ctx.bookIds) cond.bookId = _.in(ctx.bookIds);
  let curBook = String(bookIdIn || '').slice(0, 64);
  if (!curBook || !canBook(ctx, curBook)) curBook = workBook(ctx) || '';
  const res = await db.collection('records').aggregate().match(cond)
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
  return map;
}

module.exports = { nameCheckMap };
