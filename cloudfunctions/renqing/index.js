// 云函数 renqing — 人情往来：我送出的礼（手动登记）+ 按姓名查双方往来
// 收到的礼来自 records（status=paid，含代随礼 proxyFor），送出的礼存 gifts_out
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const giftsOut = db.collection('gifts_out');
const records = db.collection('records');

const TYPES = ['wedding', 'birthday', 'baby', 'house', 'funeral', 'other'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 幂等建集合（init 未跑完时自愈；同一实例每个集合只尝试一次） */
const colReady = {};
async function ensureCol(name) {
  if (colReady[name]) return;
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
  colReady[name] = true;
}

exports.main = async (event) => {
  // 预热：warmer 云函数按「系统设置」定时唤醒，保持实例常驻、减少冷启动；直接返回，不做任何读写
  if (event && event.action === '__warm') return { code: 0, msg: 'warm', data: null };
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return err('未获取到用户身份');
  try {
    await ensureCol('gifts_out');
    switch (event.action) {
      case 'outList': return await outList(OPENID, event);
      case 'inList': return await inList(OPENID, event);
      case 'remindList': return await remindList(OPENID);
      case 'remindSave': return await remindSave(OPENID, event.remind, event.subscribed === true, event.envVersion);
      case 'remindDone': return await remindDone(OPENID, event.id, event.done !== false);
      case 'remindDelete': return await remindDelete(OPENID, event.id);
      case 'outSave': return await outSave(OPENID, event.gift);
      case 'outDelete': return await outDelete(OPENID, event.id);
      case 'query': return await query(OPENID, event.key || (event.name ? 'n:' + event.name : ''));
      case 'people': return await people(OPENID);
      default: return err('未知 action');
    }
  } catch (e) {
    return err('人情往来操作失败：' + e.message);
  }
};

/**
 * 我收到的礼：本人礼簿里已入簿的礼金（按入簿时间倒序，数据库分页），可按姓名搜索；附全部笔数与合计
 * 只算本人作为主家的礼簿（为别人记账的不算，与往来对比一致）
 */
async function inList(openid, event) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || 20));
  const cond = { ownerOpenid: openid, status: 'paid' };
  const kw = String(event.keyword || '').trim().slice(0, 20);
  if (kw) cond.payerName = db.RegExp({ regexp: kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
  const [cnt, sum, res] = await Promise.all([
    records.where(cond).count(),
    records.aggregate().match(cond)
      .group({ _id: null, fen: _.aggregate.sum(_.aggregate.multiply(['$amount', 100])) }).end(),
    records.where(cond).orderBy('paidAt', 'desc').skip((page - 1) * pageSize).limit(pageSize)
      .field({ payerName: true, relation: true, amount: true, themeName: true, bookType: true, payDay: true, payMethod: true, remark: true, proxyFor: true, paidAt: true })
      .get()
  ]);
  return ok({
    list: res.data,
    total: cnt.total,
    sum: Math.round(((sum.list && sum.list[0]) || { fen: 0 }).fen) / 100,
    page,
    pageSize
  });
}

// —— 亲友办事提醒（手动添加）：到提醒日在「往来」顶部提示，订阅过的由 warmer 定时推送服务通知 ——
const REMIND_DAYS = [0, 1, 3, 7]; // 提前几天提醒
const reminders = db.collection('reminders');

/** 未处理的提醒（按办事日期升序，最近的在前）+ 最近处理过的 */
async function remindList(openid) {
  await ensureCol('reminders');
  const [todo, done] = await Promise.all([
    reminders.where({ ownerOpenid: openid, done: false }).orderBy('date', 'asc').limit(100).get(),
    reminders.where({ ownerOpenid: openid, done: true }).orderBy('date', 'desc').limit(20).get()
  ]);
  return ok({ list: todo.data, done: done.data });
}

/** 新增 / 修改提醒；subscribed=true 表示用户刚同意了订阅消息（本条可推送一次） */
async function remindSave(openid, r, subscribed, envVersion) {
  await ensureCol('reminders');
  r = r || {};
  const data = {
    name: String(r.name || '').trim().slice(0, 20),
    personKey: String(r.personKey || '').slice(0, 120),
    eventType: TYPES.includes(r.eventType) ? r.eventType : 'other',
    event: String(r.event || '').trim().slice(0, 20),
    date: DAY_RE.test(r.date || '') ? r.date : '',
    before: REMIND_DAYS.includes(Number(r.before)) ? Number(r.before) : 1,
    note: String(r.note || '').trim().slice(0, 50),
    updatedAt: new Date()
  };
  if (!data.name) return err('请填写对方姓名');
  if (!data.date) return err('请选择办事日期');
  data.notifyDay = shiftDay(data.date, -data.before); // 提醒日（北京时间）
  data.pushed = false;  // 修改后重新推送
  if (subscribed) data.subscribed = true;
  // 推送打开的小程序版本跟随订阅时的版本（开发版 / 体验版测试时能打开）
  if (['develop', 'trial', 'release'].includes(envVersion)) data.envVersion = envVersion;
  if (r._id) {
    const res = await reminders.where({ _id: String(r._id), ownerOpenid: openid }).update({ data });
    if (!res.stats.updated) return err('提醒不存在');
    return ok({ _id: r._id, ...data });
  }
  const n = await reminders.where({ ownerOpenid: openid, done: false }).count();
  if (n.total >= 200) return err('未处理的提醒太多，请先处理一些');
  const added = await reminders.add({ data: { ownerOpenid: openid, ...data, done: false, subscribed: !!subscribed, createdAt: new Date() } });
  return ok({ _id: added._id, ...data });
}

async function remindDone(openid, id, done) {
  const res = await reminders.where({ _id: String(id || ''), ownerOpenid: openid }).update({ data: { done, doneAt: done ? new Date() : null } });
  if (!res.stats.updated) return err('提醒不存在');
  return ok({ done });
}

async function remindDelete(openid, id) {
  const res = await reminders.where({ _id: String(id || ''), ownerOpenid: openid }).remove();
  if (!res.stats.removed) return err('提醒不存在');
  return ok({ removed: 1 });
}

/** YYYY-MM-DD 加减天数 */
function shiftDay(day, n) {
  const t = new Date(day + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 我送出的礼：手动登记 + 用慧礼记扫码随礼且主家已确认入簿的（自动），合并分页 */
async function outList(openid, event) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || 20));
  const [manual, auto] = await Promise.all([
    fetchAll(giftsOut, { ownerOpenid: openid }, {
      toName: true, toKey: true, relation: true, event: true, eventType: true, amount: true, date: true, remark: true, createdAt: true
    }),
    autoGiven(openid)
  ]);
  let all = manual.concat(auto);
  const kw = String(event.keyword || '').trim().slice(0, 20);
  if (kw) all = all.filter(g => String(g.toName).includes(kw));
  all.sort((a, b) => String(b.date).localeCompare(String(a.date)) || (new Date(b.createdAt) - new Date(a.createdAt)));
  const fen = all.reduce((t, g) => t + Math.round(g.amount * 100), 0);
  return ok({
    list: all.slice((page - 1) * pageSize, page * pageSize),
    total: all.length,
    sum: fen / 100,
    page,
    pageSize
  });
}

/**
 * 自动"送出的礼"：我作为宾客扫码随礼、主家已确认入簿的记录
 * 金额只算我自己的部分（代随礼填了金额的，那部分是被代人的礼）
 */
async function autoGiven(openid) {
  const recs = await fetchAll(records, { payerOpenid: openid, status: 'paid' }, {
    aid: true, ownerOpenid: true, amount: true, proxyItems: true, proxyFor: true,
    relation: true, remark: true, themeName: true, bookType: true, payDay: true, paidAt: true, createdAt: true,
    batchIdx: true
  });
  // 主家自己"模拟宾客随礼"的测试数据不算；批次录入只算第一位（扫码人本人），其余是别人的礼
  const mine = recs.filter(r => r.ownerOpenid !== openid && !(r.batchIdx > 0));
  const aids = [...new Set(mine.map(r => r.aid))];
  const names = {};
  for (let i = 0; i < aids.length; i += 100) {
    const res = await db.collection('accounts').where({ _id: _.in(aids.slice(i, i + 100)) })
      .field({ accountName: true }).get();
    res.data.forEach(a => { names[a._id] = a.accountName; });
  }
  return mine.map(r => {
    const proxyFen = (r.proxyItems || []).reduce((t, x) => t + Math.round((x.amount || 0) * 100), 0);
    const toName = names[r.aid] || '主家';
    return {
      _id: 'auto_' + r._id,
      rid: r._id,
      auto: true,
      toName,
      toKey: `o:${r.ownerOpenid}:${norm(toName)}`,
      ownerOpenid: r.ownerOpenid,
      relation: r.relation || '',
      event: r.themeName || '',
      eventType: r.bookType || 'other',
      amount: (Math.round(r.amount * 100) - proxyFen) / 100,
      date: r.payDay,
      remark: r.proxyFor ? `含代随礼：${r.proxyFor}` : (r.remark || ''),
      createdAt: r.paidAt || r.createdAt
    };
  });
}

/** 新增 / 修改送礼记录 */
async function outSave(openid, g) {
  g = g || {};
  const amount = Math.round(Number(g.amount) * 100) / 100;
  const data = {
    toName: String(g.toName || '').trim().slice(0, 20),
    // 从往来明细页登记时带上对方身份，避免同名混淆
    toKey: /^o:[\w-]*:.{1,20}$/.test(String(g.toKey || '')) ? String(g.toKey) : '',
    relation: String(g.relation || '').trim().slice(0, 10),
    event: String(g.event || '').trim().slice(0, 30),
    eventType: TYPES.includes(g.eventType) ? g.eventType : 'other',
    amount,
    date: DAY_RE.test(g.date || '') ? g.date : '',
    remark: String(g.remark || '').trim().slice(0, 50),
    updatedAt: new Date()
  };
  if (!data.toName) return err('请填写对方姓名');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return err('请填写正确金额');
  if (!data.date) return err('请选择送礼日期');

  if (g._id) {
    const res = await giftsOut.where({ _id: String(g._id), ownerOpenid: openid }).update({ data });
    if (res.stats.updated !== 1) return err('记录不存在');
    return ok({ gift: { _id: g._id, ...data } });
  }
  const added = await giftsOut.add({ data: { ownerOpenid: openid, ...data, createdAt: new Date() } });
  return ok({ gift: { _id: added._id, ...data } });
}

async function outDelete(openid, id) {
  const res = await giftsOut.where({ _id: String(id || ''), ownerOpenid: openid }).remove();
  if (res.stats.removed !== 1) return err('记录不存在');
  return ok({ removed: 1 });
}

/*
 * 人情往来的"人"：
 *  - 宾客随礼时有微信身份，按「微信身份 + 姓名(去空格)」识别：同名不同人会分开，"张伟/张 伟"会合并
 *  - 代随礼名单里的人、手动送礼登记的人只有姓名：若只有一位同名宾客则并入该宾客，否则单独成一人
 *  - 代随礼填了每人金额的，计入被代的人；未填金额的，金额含在代随礼人的礼金里，仅作记录不计入合计
 */
const MAX_ROWS = 3000;
const norm = s => String(s || '').replace(/[\s\u3000]/g, '');

async function fetchAll(col, cond, fields) {
  const out = [];
  while (out.length < MAX_ROWS) {
    const res = await col.where(cond).field(fields).skip(out.length).limit(100).get();
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out;
}

/** 汇总全部往来，返回 { persons: Map<key, person> } */
async function buildPersons(openid) {
  const [recs, gifts, auto] = await Promise.all([
    fetchAll(records, { ownerOpenid: openid, status: 'paid' }, {
      payerOpenid: true, payerName: true, amount: true, proxyFor: true, proxyItems: true,
      relation: true, remark: true, themeName: true, bookType: true, payDay: true, createdAt: true
    }),
    fetchAll(giftsOut, { ownerOpenid: openid }, {
      toName: true, toKey: true, relation: true, event: true, eventType: true, amount: true, date: true, remark: true
    }),
    autoGiven(openid)
  ]);

  const persons = new Map();
  const get = (key, name) => {
    if (!persons.has(key)) {
      persons.set(key, { key, name, relation: '', received: [], given: [] });
    }
    return persons.get(key);
  };
  const pending = []; // 只有姓名的条目，待并入同名宾客

  for (const r of recs) {
    const base = {
      _id: r._id, date: r.payDay, event: r.themeName || '', eventType: r.bookType || 'other',
      relation: r.relation || '', remark: r.remark || ''
    };
    const items = (r.proxyItems && r.proxyItems.length)
      ? r.proxyItems
      : String(r.proxyFor || '').split(/[、,，\s]+/).filter(Boolean).map(name => ({ name, amount: null }));
    const knownFen = items.reduce((t, x) => t + Math.round((x.amount || 0) * 100), 0);
    const unknownNames = items.filter(x => !(x.amount > 0)).map(x => x.name);

    const payerEntry = {
      ...base,
      amount: (Math.round(r.amount * 100) - knownFen) / 100,
      counted: true,
      withProxy: unknownNames.join('、') // 含代随礼（未拆分金额）的人
    };
    if (r.payerOpenid) {
      const payer = get(`o:${r.payerOpenid}:${norm(r.payerName)}`, r.payerName);
      if (r.relation) payer.relation = r.relation;
      payer.received.push(payerEntry);
    } else {
      // 主家代登记的现金礼没有宾客微信身份：按姓名归并
      pending.push({ name: r.payerName, entry: payerEntry, side: 'received' });
    }
    for (const x of items) {
      pending.push({
        name: x.name,
        entry: {
          ...base, _id: `${r._id}:${x.name}`, relation: '',
          amount: x.amount > 0 ? x.amount : 0,
          counted: x.amount > 0,
          viaProxy: r.payerName
        },
        side: 'received'
      });
    }
  }
  for (const g of gifts) {
    const entry = {
      _id: g._id, date: g.date, event: g.event, eventType: g.eventType,
      relation: g.relation, remark: g.remark, amount: g.amount, counted: true
    };
    if (g.toKey && g.toKey.startsWith('o:')) {
      const p = get(g.toKey, g.toName);
      p.given.push(entry);
    } else {
      pending.push({ name: g.toName, entry, side: 'given' });
    }
  }

  // 自动送礼：对方（主家）若也随过礼给我，按微信身份并入同一人
  for (const g of auto) {
    const entry = {
      _id: g._id, rid: g.rid, auto: true, date: g.date, event: g.event, eventType: g.eventType,
      relation: g.relation, remark: g.remark, amount: g.amount, counted: true
    };
    const same = [...persons.values()].find(p => p.key.startsWith(`o:${g.ownerOpenid}:`));
    (same || get(g.toKey, g.toName)).given.push(entry);
  }

  // 只有姓名的条目：同名宾客唯一时并入，否则归到"姓名"这个人
  const byName = {};
  for (const p of persons.values()) {
    const n = norm(p.name);
    (byName[n] = byName[n] || []).push(p);
  }
  for (const x of pending) {
    const n = norm(x.name);
    const same = byName[n] || [];
    const p = same.length === 1 ? same[0] : get(`n:${n}`, x.name);
    p[x.side].push(x.entry);
  }

  // 统计 + 同名标记
  const counts = {};
  for (const p of persons.values()) counts[norm(p.name)] = (counts[norm(p.name)] || 0) + 1;
  const fen = list => list.filter(e => e.counted).reduce((t, e) => t + Math.round(e.amount * 100), 0);
  for (const p of persons.values()) {
    const inFen = fen(p.received);
    const outFen = fen(p.given);
    Object.assign(p, {
      inCount: p.received.length,
      inSum: inFen / 100,
      outCount: p.given.length,
      outSum: outFen / 100,
      balance: (inFen - outFen) / 100, // 正数：收多于送，日后宜回礼
      dup: counts[norm(p.name)] > 1
    });
  }
  return persons;
}

/** 往来人名单（按往来次数排序，最多 300 人） */
async function people(openid) {
  const persons = await buildPersons(openid);
  const list = [...persons.values()]
    .map(({ received, given, ...p }) => p)
    .sort((a, b) => (b.inCount + b.outCount) - (a.inCount + a.outCount))
    .slice(0, 300);
  return ok({ list });
}

/** 某人的往来明细：key 来自名单；只输入姓名时传 n:姓名 */
async function query(openid, key) {
  key = String(key || '').slice(0, 120);
  if (!key) return err('请输入姓名');
  const persons = await buildPersons(openid);
  let p = persons.get(key);
  if (!p && key.startsWith('n:')) {
    // 按姓名查：唯一同名宾客时直接返回该宾客
    const n = norm(key.slice(2));
    const same = [...persons.values()].filter(x => norm(x.name) === n);
    p = same.length === 1 ? same[0] : null;
    if (!p) p = { key, name: key.slice(2), relation: '', received: [], given: [], inSum: 0, outSum: 0, balance: 0, dup: same.length > 1 };
  }
  if (!p) return err('未找到该往来人');
  const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
  return ok({
    key: p.key,
    name: p.name,
    relation: p.relation,
    dup: p.dup,
    received: p.received.sort(byDate),
    given: p.given.sort(byDate),
    receivedSum: p.inSum,
    givenSum: p.outSum,
    balance: p.balance
  });
}

const escapeReg = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
