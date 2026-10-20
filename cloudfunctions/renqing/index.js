// 云函数 renqing — 人情往来：我送出的礼（手动登记）+ 按姓名查双方往来
// 收到的礼来自 records（status=paid），送出的礼存 gifts_out
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const giftsOut = db.collection('gifts_out');
const records = db.collection('records');

const crypto = require('crypto');

/*
 * 往来人标识 o:<微信身份>:<姓名> 里含宾客（或主家）的 openid，不直接交给前端：
 * 出参里的 o: 标识确定性加密为 h:<密文>:<姓名>，入参再解密还原，云函数内部和数据库仍用 o: 标识
 */
const KEY_SECRET = crypto.createHash('sha256').update('huilj.person-key.v1').digest();
const KEY_IV = Buffer.alloc(16, 0); // 固定 IV：同一个人每次得到同一个标识，前端可用来比较
function hideKey(k) {
  const m = /^o:([\w-]{1,64}):(.*)$/.exec(k);
  if (!m) return k;
  const c = crypto.createCipheriv('aes-256-cbc', KEY_SECRET, KEY_IV);
  const enc = Buffer.concat([c.update(m[1], 'utf8'), c.final()]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `h:${enc}:${m[2]}`;
}
function showKey(k) {
  const m = /^h:([\w-]{1,128}):(.*)$/.exec(k);
  if (!m) return k;
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', KEY_SECRET, KEY_IV);
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const oid = Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
    return /^[\w-]{1,64}$/.test(oid) ? `o:${oid}:${m[2]}` : '';
  } catch (e) { return ''; }
}
/** 递归替换对象里的标识：出参 hideKey，入参 showKey */
function mapKeys(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map(x => mapKeys(x, fn));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = {};
    Object.keys(v).forEach(k => { o[k] = mapKeys(v[k], fn); });
    return o;
  }
  return v;
}

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
    event = mapKeys(event, showKey); // 前端传回的 h: 标识还原为 o:
    return mapKeys(await route(OPENID, event), hideKey); // 返回前把 o: 标识加密
  } catch (e) {
    console.error('renqing', event.action, e);
    return err('人情往来操作失败，请稍后重试');
  }
};

async function route(OPENID, event) {
  {
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
      // 同名区分：登记前查同名的人、合并为同一人 / 取消合并、把某条记录移到别的人
      case 'nameCheck': return await nameCheck(OPENID, event.name);
      case 'merge': return await merge(OPENID, String(event.from || ''), String(event.to || ''));
      case 'unmerge': return await unmerge(OPENID, String(event.from || ''));
      case 'moveEntry': return await moveEntry(OPENID, event);
      default: return err('未知 action');
    }
  }
}

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
      .field({ payerName: true, nameTag: true, personKey: true, payerOpenid: true, relation: true, amount: true, themeName: true, bookType: true, payDay: true, payMethod: true, remark: true, paidAt: true })
      .get()
  ]);
  return ok({
    // key：点开往来明细用（与往来对比的人一致）；不返回宾客 openid
    list: res.data.map(({ payerOpenid, personKey, ...r }) => ({
      ...r,
      key: KEY_RE.test(personKey || '') ? personKey : (payerOpenid ? `o:${payerOpenid}:${norm(r.payerName)}` : nameKey(r.payerName, r.nameTag))
    })),
    total: cnt.total,
    sum: Math.round(((sum.list && sum.list[0]) || { fen: 0 }).fen) / 100,
    page,
    pageSize
  });
}

// —— 亲友办事提醒（手动添加）：到提醒日在「往来」顶部提示，订阅过的由 warmer 定时推送服务通知 ——
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

    note: String(r.note || '').trim().slice(0, 50),
    location: String(r.location || '').trim().slice(0, 30), // 办事地点（推送的「详细地址」）
    updatedAt: new Date()
  };
  if (!data.name) return err('请填写对方姓名');
  if (!data.date) return err('请选择办事日期');
  // 提醒时间：remindAt 'YYYY-MM-DD HH:mm'（北京时间），具体到哪天几点；不能早于现在
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(String(r.remindAt || ''));
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) return err('请选择提醒时间');
  const at = new Date(`${m[1]}T${m[2]}:${m[3]}:00+08:00`);
  if (isNaN(at.getTime())) return err('请选择提醒时间');
  if (at.getTime() < Date.now() - 60 * 1000) return err('提醒时间已过，请重新选择');
  if (m[1] > data.date) return err('提醒时间不能晚于办事日期'); // 推送只发办事当天及以前的提醒
  data.remindAt = at;
  data.remindStr = `${m[1]} ${m[2]}:${m[3]}`;
  data.notifyDay = m[1]; // 提醒日（北京时间，兼容旧逻辑）
  data.before = _.remove();
  data.pushTries = 0;
  data.pushed = false;  // 修改后重新推送
  // 每条订阅只能推送一次：修改时按这次是否同意了订阅（拒绝了就只在小程序里提醒）
  data.subscribed = !!subscribed;
  // 推送打开的小程序版本跟随订阅时的版本（开发版 / 体验版测试时能打开）
  if (['develop', 'trial', 'release'].includes(envVersion)) data.envVersion = envVersion;
  if (r._id) {
    const res = await reminders.where({ _id: String(r._id), ownerOpenid: openid }).update({ data });
    if (!res.stats.updated) return err('提醒不存在');
    return ok({ _id: r._id, ...data });
  }
  const n = await reminders.where({ ownerOpenid: openid, done: false }).count();
  if (n.total >= 200) return err('未处理的提醒太多，请先处理一些');
  const { before, ...fresh } = data; // 新建时没有旧的「提前天数」字段可删
  const added = await reminders.add({ data: { ownerOpenid: openid, ...fresh, done: false, subscribed: !!subscribed, createdAt: new Date() } });
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
    list: all.slice((page - 1) * pageSize, page * pageSize).map(({ ownerOpenid, ...g }) => g), // 不把主家的 openid 给前端
    total: all.length,
    sum: fen / 100,
    page,
    pageSize
  });
}

/**
 * 自动"送出的礼"：我作为宾客扫码随礼、主家已确认入簿的记录
 */
async function autoGiven(openid) {
  const recs = await fetchAll(records, { payerOpenid: openid, status: 'paid' }, {
    aid: true, ownerOpenid: true, amount: true,
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
      amount: r.amount,
      date: r.payDay,
      remark: r.remark || '',
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
    // 从往来明细页登记、或登记时选了同名的某一位：带上对方身份（o: 微信身份 / n: 姓名#区分备注），避免同名混淆
    toKey: KEY_RE.test(String(g.toKey || '')) ? String(g.toKey) : '',
    toTag: cleanTag(g.toTag),
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
 *  - 礼台登记、手动送礼登记的人只有姓名：按姓名（+ 区分备注）归为一人，同名的可提示合并
 */
const MAX_ROWS = 3000;
const norm = s => String(s || '').replace(/[\s\u3000]/g, '');

let truncated = false; // 本次统计是否因超过 MAX_ROWS 被截断（每次调用前重置）
async function fetchAll(col, cond, fields) {
  const out = [];
  while (out.length < MAX_ROWS) {
    const res = await col.where(cond).field(fields).orderBy('_id', 'asc').skip(out.length).limit(100).get(); // 固定顺序，翻页不重不漏
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  if (out.length >= MAX_ROWS) truncated = true;
  return out;
}

/** 汇总全部往来，返回 { persons: Map<key, person> } */
async function buildPersons(openid) {
  let aliases = {};
  const [recs, gifts, auto] = await Promise.all([
    fetchAll(records, { ownerOpenid: openid, status: 'paid' }, {
      payerOpenid: true, payerName: true, amount: true, nameTag: true, personKey: true,
      relation: true, remark: true, themeName: true, bookType: true, payDay: true, createdAt: true
    }),
    fetchAll(giftsOut, { ownerOpenid: openid }, {
      toName: true, toKey: true, toTag: true, relation: true, event: true, eventType: true, amount: true, date: true, remark: true
    }),
    autoGiven(openid),
    aliasMap(openid)
  ]).then(([a, b, c, d]) => { aliases = d; return [a, b, c]; });

  // 一个人 = 微信身份（o:openid:姓名）或 姓名 + 区分备注（n:姓名#备注）；主家合并过的按合并后的人归集
  const persons = new Map();
  const get = (key, name, tag) => {
    key = resolveAlias(aliases, key);
    if (!persons.has(key)) {
      persons.set(key, { key, name, tag: '', relation: '', received: [], given: [], merged: [] });
    }
    const p = persons.get(key);
    if (tag && !p.tag) p.tag = tag;
    return p;
  };
  const pending = []; // 只有姓名（未区分）的条目

  for (const r of recs) {
    const base = {
      _id: r._id, date: r.payDay, event: r.themeName || '', eventType: r.bookType || 'other',
      relation: r.relation || '', remark: r.remark || ''
    };
    const payerEntry = { ...base, amount: r.amount, counted: true };
    payerEntry.movable = true; // 本人礼簿的记录：可以移到同名的另一个人
    const pk = KEY_RE.test(r.personKey || '') ? r.personKey : '';
    if (pk || r.payerOpenid || r.nameTag) {
      const payer = get(pk || (r.payerOpenid ? `o:${r.payerOpenid}:${norm(r.payerName)}` : nameKey(r.payerName, r.nameTag)), r.payerName, r.nameTag);
      if (r.relation) payer.relation = r.relation;
      payer.received.push(payerEntry);
    } else {
      // 礼台登记、没有区分备注的：按姓名归为一人（不再自动并入同名的扫码宾客，改为提示合并）
      pending.push({ name: r.payerName, entry: payerEntry, side: 'received' });
    }
  }
  for (const g of gifts) {
    const entry = {
      _id: g._id, date: g.date, event: g.event, eventType: g.eventType,
      relation: g.relation, remark: g.remark, amount: g.amount, counted: true, movable: true
    };
    if (KEY_RE.test(g.toKey || '') || g.toTag) {
      get(KEY_RE.test(g.toKey || '') ? g.toKey : nameKey(g.toName, g.toTag), g.toName, g.toTag).given.push(entry);
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

  // 只有姓名的条目：归到"姓名"这个人（主家可在往来明细里合并 / 移动）
  for (const x of pending) get(nameKey(x.name, ''), x.name)[x.side].push(x.entry);
  // 记下被合并进来的人（可取消合并）
  Object.keys(aliases).forEach(from => {
    const p = persons.get(resolveAlias(aliases, from));
    if (p) p.merged.push(from);
  });

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
    p.label = labelOf(p);
  }
  return persons;
}

// —— 同名区分 ——
const KEY_RE = /^(o:[\w-]{1,64}:|n:)[^\s]{1,40}$/;
const cleanTag = s => String(s || '').trim().replace(/[#:\s]/g, '').slice(0, 12);
const nameKey = (name, tag) => `n:${norm(name)}${cleanTag(tag) ? '#' + cleanTag(tag) : ''}`;
/** 显示名：同名时带区分备注；扫码宾客没有备注时标"扫码" */
const labelOf = p => p.name + (p.tag ? `（${p.tag}）` : (p.dup ? (p.key.startsWith('o:') ? '（扫码）' : '（未区分）') : ''));

function resolveAlias(aliases, key) {
  for (let i = 0; i < 5 && aliases[key]; i++) key = aliases[key];
  return key;
}

async function aliasMap(openid) {
  await ensureCol('person_alias');
  const res = await db.collection('person_alias').where({ ownerOpenid: openid }).limit(1000).get();
  const map = {};
  res.data.forEach(a => { map[a.from] = a.to; });
  return map;
}

/** 同名的人（登记送礼前选择是哪一位） */
async function nameCheck(openid, name) {
  const n = norm(String(name || '').slice(0, 20));
  if (!n) return ok({ list: [] });
  const persons = await buildPersons(openid);
  const list = [...persons.values()].filter(p => norm(p.name) === n)
    .map(p => ({ key: p.key, label: p.label, tag: p.tag, relation: p.relation, inSum: p.inSum, outSum: p.outSum, scanned: p.key.startsWith('o:') }));
  return ok({ list });
}

/** 合并为同一人：from 的往来都算到 to 名下（只能合并同名的人） */
async function merge(openid, from, to) {
  if (!KEY_RE.test(from) || !KEY_RE.test(to) || from === to) return err('参数错误');
  const persons = await buildPersons(openid);
  const a = persons.get(from);
  const b = persons.get(to);
  if (!a || !b) return err('往来人不存在');
  if (norm(a.name) !== norm(b.name)) return err('只能合并同名的人');
  const col = db.collection('person_alias');
  // 已合并到 from 的，一并改到 to
  await col.where({ ownerOpenid: openid, to: from }).update({ data: { to } });
  await col.where({ ownerOpenid: openid, from }).remove();
  await col.add({ data: { ownerOpenid: openid, from, to, createdAt: new Date() } });
  return ok({ key: to });
}

async function unmerge(openid, from) {
  await ensureCol('person_alias');
  const res = await db.collection('person_alias').where({ ownerOpenid: openid, from }).remove();
  if (!res.stats.removed) return err('没有合并记录');
  return ok({ key: from });
}

/**
 * 把一条记录移到别的人：to 为已有的人（同名），或 tag 为新的区分备注（新的一位）
 * side=received：本人礼簿的礼金（改 personKey / nameTag）；side=given：手动登记的送礼（改 toKey / toTag）
 */
async function moveEntry(openid, e) {
  const id = String(e.id || '');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return err('这条记录不能移动');
  const to = String(e.to || '');
  const tag = cleanTag(e.tag);
  if (!KEY_RE.test(to) && !tag) return err('请选择移到哪一位，或填写区分备注');
  if (e.side === 'given') {
    const g = (await giftsOut.where({ _id: id, ownerOpenid: openid }).limit(1).get()).data[0];
    if (!g) return err('记录不存在');
    const data = KEY_RE.test(to) ? { toKey: to, toTag: to.startsWith('n:') ? cleanTag(to.split('#')[1]) : '' } : { toKey: nameKey(g.toName, tag), toTag: tag };
    await giftsOut.doc(id).update({ data });
    return ok({ key: data.toKey });
  }
  const r = (await records.where({ _id: id, ownerOpenid: openid }).limit(1).get()).data[0];
  if (!r) return err('记录不存在');
  const data = KEY_RE.test(to) ? { personKey: to, nameTag: to.startsWith('n:') ? cleanTag(to.split('#')[1]) : (r.nameTag || ''), nameTagBy: 'host' } : { personKey: nameKey(r.payerName, tag), nameTag: tag, nameTagBy: 'host' };
  await records.doc(id).update({ data });
  return ok({ key: data.personKey });
}

/** 往来人名单（按往来次数排序，最多 300 人） */
async function people(openid) {
  truncated = false;
  const persons = await buildPersons(openid);
  const list = [...persons.values()]
    .map(({ received, given, ...p }) => p)
    .sort((a, b) => (b.inCount + b.outCount) - (a.inCount + a.outCount))
    .slice(0, 300);
  return ok({ list, truncated }); // truncated：记录超过 3000 条，统计不全
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
  // 同名的其他人：提示"可能是同一人"，可合并；移动记录时可选
  const same = [...persons.values()].filter(x => x.key !== p.key && norm(x.name) === norm(p.name))
    .map(x => ({ key: x.key, label: x.label }));
  return ok({
    key: p.key,
    name: p.name,
    label: p.label || p.name,
    tag: p.tag || '',
    same,
    merged: p.merged || [],
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
