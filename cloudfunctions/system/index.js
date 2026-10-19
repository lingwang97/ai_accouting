// 云函数 system — 系统设置（管理员）与付费订阅接口（预留）
//   plan         任何登录用户：当前套餐（记账人跟随所服务的主家），并返回自己是否管理员
//   adminGet     管理员：预热配置、上次预热结果、套餐定义
//   adminSetWarmup 管理员：保存预热配置
//   adminSetPlan 管理员：给某位主家开通 / 延期 / 取消套餐（以后接支付回调时由支付流程调用同一逻辑）
//   ads          任何人：广告位配置（前端据此决定是否展示，宾客也会调用）
//   adminSetAds  管理员：保存广告位配置
//   adminIndexes 管理员：一键创建数据库索引（调用云开发 HTTP API updateIndex，需在本函数环境变量配置 WX_APPSECRET）
const cloud = require('wx-server-sdk');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { resolveCtx } = require('./ctx.js');
const P = require('./plans.js');
const Purge = require('./purge.js');

exports.main = async (event) => {
  if (event && event.action === '__warm') return { code: 0, msg: 'warm', data: null };
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return err('未获取到用户身份');
  try {
    switch (event.action) {
      case 'plan': return await myPlan(OPENID);
      case 'ads': return ok(P.normalizeAds(await P.readSetting(db, 'ads', P.DEFAULT_ADS)));
      case 'adminSetAds': return await guard(OPENID, () => adminSetAds(event.ads));
      case 'adminGet': return await guard(OPENID, adminGet);
      case 'adminSetWarmup': return await guard(OPENID, () => adminSetWarmup(event.warmup));
      case 'adminSetPlan': return await guard(OPENID, () => setPlan(event.ownerOpenid, event.plan, event.days, 'admin'));
      case 'adminFindHosts': return await guard(OPENID, () => findHosts(event.keyword));
      case 'adminIndexes': return await guard(OPENID, () => ensureIndexes());
      // 数据清除：按账户（预览 / 备份 / 执行）、按礼簿、无主数据；操作日志
      case 'adminPurgePreview': return await guard(OPENID, () => purgePreview(OPENID, String(event.ownerOpenid || ''), event.guestRecords === true));
      case 'adminBackup': return await guard(OPENID, () => adminBackup(String(event.ownerOpenid || '')));
      case 'adminPurge': return await guard(OPENID, () => adminPurge(OPENID, event));
      case 'adminBookPreview': return await guard(OPENID, () => bookPreview(String(event.keyword || event.bookId || '')));
      case 'adminPurgeBook': return await guard(OPENID, () => purgeBook(OPENID, String(event.bookId || ''), event.confirmName));
      case 'adminOrphanPreview': return await guard(OPENID, () => orphans(OPENID, false));
      case 'adminOrphanPurge': return await guard(OPENID, () => orphans(OPENID, true));
      case 'adminLogs': return await guard(OPENID, () => adminLogs());
      default: return err('未知 action');
    }
  } catch (e) {
    console.error('system', event.action, e);
    return err('操作失败，请稍后重试');
  }
};

async function guard(openid, fn) {
  if (!(await P.isAdmin(db, openid))) return err('无管理员权限');
  return fn();
}

/** 当前套餐：数据属于主家，记账人按主家的套餐 */
async function myPlan(openid) {
  const ctx = await resolveCtx(db, openid);
  const plan = await P.planOf(db, ctx.ownerOpenid);
  return ok({ ...plan, isAdmin: await P.isAdmin(db, openid) });
}

async function adminGet() {
  const [warmup, status, plans, ads] = await Promise.all([
    P.readSetting(db, 'warmup', P.DEFAULT_WARMUP),
    P.readSetting(db, 'warmup_status', {}),
    P.readSetting(db, 'plans', P.DEFAULT_PLANS),
    P.readSetting(db, 'ads', P.DEFAULT_ADS)
  ]);
  return ok({
    warmup: P.normalizeWarmup(warmup), status, plans, warmable: P.WARMABLE,
    ads: P.normalizeAds(ads), adSlots: P.AD_SLOTS
  });
}

async function adminSetAds(a) {
  const raw = a || {};
  if (raw.bannerUnit && !/^adunit-[a-zA-Z0-9]{4,40}$/.test(String(raw.bannerUnit))) return err('广告单元 ID 格式不正确（应为 adunit- 开头）');
  const ads = P.normalizeAds(raw);
  if (ads.enabled && !ads.bannerUnit) return err('开启广告前请先填写广告单元 ID');
  await P.writeSetting(db, 'ads', ads);
  return ok({ ads });
}

async function adminSetWarmup(w) {
  const warmup = P.normalizeWarmup(w || {});
  await P.writeSetting(db, 'warmup', warmup);
  return ok({ warmup });
}

/** 按主家称呼 / 机构名称 / openid 搜索主家，附当前套餐（开通时直接选，不用手填 openid） */
async function findHosts(keyword) {
  const k = String(keyword || '').trim().slice(0, 30);
  if (!k) return err('请输入主家称呼');
  const _ = db.command;
  const reg = db.RegExp({ regexp: k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
  const res = await db.collection('accounts')
    .where(_.or([{ accountName: reg }, { orgName: reg }, { ownerOpenid: k }]))
    .field({ accountName: true, orgName: true, ownerOpenid: true, orgMode: true })
    .limit(20).get();
  const list = await Promise.all(res.data
    .filter(a => !String(a.ownerOpenid || '').startsWith('merged:')) // 已合并的别名
    .map(async a => {
      const plan = await P.planOf(db, a.ownerOpenid);
      return {
        ownerOpenid: a.ownerOpenid,
        accountName: a.accountName,
        orgName: a.orgName || '',
        orgMode: !!a.orgMode,
        plan: plan.plan,
        planName: plan.name,
        expiresAt: plan.expiresAt
      };
    }));
  return ok({ list });
}

/**
 * 开通 / 延期 / 取消套餐（订阅接口预留）
 * days > 0：在当前到期时间（未过期）或现在的基础上延长；plan='free' 为取消
 */
async function setPlan(ownerOpenid, plan, days, source) {
  ownerOpenid = String(ownerOpenid || '').trim();
  if (!/^[a-zA-Z0-9_-]{10,64}$/.test(ownerOpenid)) return err('openid 不正确');
  const plans = await P.readSetting(db, 'plans', P.DEFAULT_PLANS);
  if (!plans[plan]) return err('套餐不存在');
  try { await db.createCollection('subscriptions'); } catch (e) { /* 已存在 */ }
  const col = db.collection('subscriptions');
  let cur = null;
  try { cur = (await col.doc(ownerOpenid).get()).data; } catch (e) { /* 无订阅 */ }
  let expiresAt = null;
  if (plan !== 'free') {
    const n = Math.max(1, Math.min(3660, Number(days) || 30));
    const base = cur && cur.plan === plan && cur.expiresAt && new Date(cur.expiresAt) > new Date()
      ? new Date(cur.expiresAt) : new Date();
    expiresAt = new Date(base.getTime() + n * 24 * 3600 * 1000);
  }
  await col.doc(ownerOpenid).set({ data: { plan, expiresAt, source, updatedAt: new Date() } });
  // 读回确认已生效
  const now = await P.planOf(db, ownerOpenid);
  return ok({ ownerOpenid, plan: now.plan, planName: now.name, expiresAt: now.expiresAt });
}

// —— 数据清除（管理员） ——
const _ = db.command;
const OPENID_RE = /^[a-zA-Z0-9_-]{10,64}$/;

/** 是否为该用户本人上传到 paycodes/ 目录的收款码（与 account 云函数一致） */
function ownPayCode(fileID, openid) {
  const esc = String(openid || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return !!esc && new RegExp(`^cloud://[^/]+/paycodes/(book-)?${esc}-\\d+\\.(png|jpe?g|webp)$`, 'i').test(String(fileID || ''));
}

/** 被清除账户的显示信息（确认时输入的名称：主家称呼；没有主家信息时用微信昵称） */
async function target(ownerOpenid) {
  if (!OPENID_RE.test(ownerOpenid)) return { error: '账户不正确' };
  if (await P.isAdmin(db, ownerOpenid)) return { error: '不能清除管理员账户' };
  const acc = (await db.collection('accounts').where({ ownerOpenid }).limit(1).get()).data[0] || null;
  const user = (await db.collection('users').where({ openid: ownerOpenid }).limit(1).get()).data[0] || null;
  if (!acc && !user) return { error: '账户不存在或已清除' };
  return { acc, user, name: (acc && acc.accountName) || (user && user.nickname) || '' };
}

async function purgePreview(admin, ownerOpenid, guestRecords) {
  const t = await target(ownerOpenid);
  if (t.error) return err(t.error);
  const rows = await Purge.preview(db, ownerOpenid, { guestRecords, subscription: true });
  const guest = guestRecords ? 0 : (await db.collection('records').where({ payerOpenid: ownerOpenid }).count()).total;
  return ok({ name: t.name, orgName: (t.acc && t.acc.orgName) || '', rows, guestRecordsCount: guest });
}

/**
 * 清除前备份：调用 export 云函数生成该账户的全量 Excel（保留 7 天，管理员可下载）
 * export 通过一次性口令确认是管理员发起的（settings.admin_backup，2 分钟内有效）
 */
async function adminBackup(ownerOpenid) {
  const t = await target(ownerOpenid);
  if (t.error) return err(t.error);
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  await P.writeSetting(db, 'admin_backup', { token, ownerOpenid, exp: Date.now() + 2 * 60 * 1000 });
  const res = await cloud.callFunction({ name: 'export', data: { action: 'adminBackup', ownerOpenid, token } });
  const r = res.result || {};
  if (r.code !== 0) return err(r.msg || '备份失败');
  return ok(r.data);
}

/** 执行清除：需输入该账户名称确认、并已备份（或确认不需要备份） */
async function adminPurge(admin, e) {
  const ownerOpenid = String(e.ownerOpenid || '');
  const t = await target(ownerOpenid);
  if (t.error) return err(t.error);
  if (String(e.confirmName || '').trim() !== t.name) return err('输入的名称与该账户不一致');
  if (e.backedUp !== true) return err('请先备份，或确认不需要备份');
  const res = await Purge.run(db, cloud, ownerOpenid, { guestRecords: e.guestRecords === true, subscription: true, ownPayCode });
  await log(admin, 'purgeAccount', { ownerOpenid, name: t.name, guestRecords: e.guestRecords === true, removed: res.removed, files: res.files });
  return ok(res);
}

/** 按礼簿清除：搜索礼簿（名称 / 主家称呼 / 礼簿 id），返回礼簿与礼金条数 */
async function bookPreview(keyword) {
  const k = keyword.trim().slice(0, 30);
  if (!k) return err('请输入礼簿名称或主家称呼');
  const reg = db.RegExp({ regexp: k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
  let books = (await db.collection('books').where(_.or([{ _id: k }, { name: reg }, { hostName: reg }])).limit(20).get()).data;
  if (books.length < 20) {
    const accs = (await db.collection('accounts').where({ accountName: reg }).field({ ownerOpenid: true }).limit(10).get()).data;
    if (accs.length) {
      const more = (await db.collection('books').where({ ownerOpenid: _.in(accs.map(a => a.ownerOpenid)) }).limit(20).get()).data;
      books = books.concat(more.filter(b => !books.some(x => x._id === b._id))).slice(0, 20);
    }
  }
  const owners = [...new Set(books.map(b => b.ownerOpenid))];
  const names = {};
  if (owners.length) {
    (await db.collection('accounts').where({ ownerOpenid: _.in(owners) }).field({ ownerOpenid: true, accountName: true }).get())
      .data.forEach(a => { names[a.ownerOpenid] = a.accountName; });
  }
  const list = await Promise.all(books.map(async b => ({
    _id: b._id, name: b.name, hostName: b.hostName || '', date: b.date || '', archived: !!b.archived,
    accountName: names[b.ownerOpenid] || '（无主家信息）',
    count: (await db.collection('records').where({ ownerOpenid: b.ownerOpenid, bookId: b._id }).count()).total
  })));
  return ok({ list });
}

/** 删除一本礼簿及其礼金记录、存档与礼簿码文件；需输入礼簿名称确认 */
async function purgeBook(admin, bookId, confirmName) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(bookId)) return err('参数错误');
  let book;
  try { book = (await db.collection('books').doc(bookId).get()).data; } catch (e) { return err('礼簿不存在'); }
  if (String(confirmName || '').trim() !== book.name) return err('输入的礼簿名称不一致');
  const files = [];
  if (book.archivePdf && book.archivePdf.fileID) files.push(book.archivePdf.fileID);
  if (ownPayCode(book.payCodeFileID, book.ownerOpenid)) files.push(book.payCodeFileID);
  const acc = (await db.collection('accounts').where({ ownerOpenid: book.ownerOpenid }).limit(1).get()).data[0];
  const prefix = acc && acc.payCodeFileID ? acc.payCodeFileID.split('/paycodes/')[0] : '';
  if (prefix) ['develop', 'trial', 'release'].forEach(env => files.push(`${prefix}/qrcodes/${bookId}-${env}.png`));
  try { if (files.length) await cloud.deleteFile({ fileList: files }); } catch (e) { /* 忽略 */ }
  let records = 0;
  for (let i = 0; i < 200; i++) {
    const r = await db.collection('records').where({ ownerOpenid: book.ownerOpenid, bookId }).remove();
    records += r.stats.removed;
    if (!r.stats.removed) break;
  }
  if (book.archivePdf && book.archivePdf.fileID) await db.collection('exports').where({ fileID: book.archivePdf.fileID }).remove();
  await db.collection('books').doc(bookId).remove();
  if (acc && acc.activeBookId === bookId) await db.collection('accounts').doc(acc._id).update({ data: { activeBookId: '' } });
  const removed = [{ label: '礼簿', count: 1 }, { label: '礼金记录', count: records }];
  await log(admin, 'purgeBook', { bookId, name: book.name, ownerOpenid: book.ownerOpenid, removed });
  return ok({ removed });
}

/**
 * 无主数据：主家信息已不存在的礼簿 / 礼金 / 导出文件，加入的主家已不存在的人员关系，过期 30 天以上的邀请卡，
 * 用户信息已不存在的送礼记录 / 提醒 / 同名合并。doIt=false 只统计
 */
async function orphans(admin, doIt) {
  const ownersOf = async (col, field) => {
    const res = await db.collection(col).aggregate().group({ _id: '$' + field }).limit(1000).end();
    return (res.list || []).map(x => x._id).filter(x => x && !String(x).startsWith('merged:'));
  };
  const missing = async (ids, col, field) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const have = (await db.collection(col).where({ [field]: _.in(part) }).field({ [field]: true }).limit(1000).get()).data.map(x => x[field]);
      part.forEach(id => { if (!have.includes(id)) out.push(id); });
    }
    return out;
  };
  const safe = async fn => { try { return await fn(); } catch (e) { return []; } };
  // 主家已不存在
  const hostOwners = [...new Set((await safe(() => ownersOf('books', 'ownerOpenid'))).concat(await safe(() => ownersOf('records', 'ownerOpenid'))))];
  const noHost = await missing(hostOwners, 'accounts', 'ownerOpenid');
  // 用户已不存在（个人数据）
  const personal = [...new Set((await safe(() => ownersOf('gifts_out', 'ownerOpenid')))
    .concat(await safe(() => ownersOf('reminders', 'ownerOpenid')), await safe(() => ownersOf('person_alias', 'ownerOpenid'))))];
  const noUser = await missing(personal, 'users', 'openid');
  // 人员关系：所属主家信息已不存在
  const aids = await safe(() => ownersOf('members', 'aid'));
  const noAcc = await missing(aids, 'accounts', '_id');
  const expired = { expiresAt: _.lt(new Date(Date.now() - 30 * 24 * 3600 * 1000)) };

  const items = [
    ['无主礼簿', 'books', noHost.length ? { ownerOpenid: _.in(noHost) } : null],
    ['无主礼金记录', 'records', noHost.length ? { ownerOpenid: _.in(noHost) } : null],
    ['无主导出 / 存档登记', 'exports', noHost.length ? { ownerOpenid: _.in(noHost) } : null],
    ['已注销用户的送礼记录', 'gifts_out', noUser.length ? { ownerOpenid: _.in(noUser) } : null],
    ['已注销用户的提醒', 'reminders', noUser.length ? { ownerOpenid: _.in(noUser) } : null],
    ['已注销用户的同名合并', 'person_alias', noUser.length ? { ownerOpenid: _.in(noUser) } : null],
    ['主家已不存在的人员关系', 'members', noAcc.length ? { aid: _.in(noAcc) } : null],
    ['过期 30 天以上的邀请卡', 'invites', expired]
  ].filter(x => x[2]);
  const rows = [];
  let files = 0;
  for (const [label, col, cond] of items) {
    let count = 0;
    if (!doIt) {
      try { count = (await db.collection(col).where(cond).count()).total; } catch (e) { count = 0; }
    } else if (col === 'exports') {
      for (let i = 0; i < 100; i++) {
        const rs = (await db.collection('exports').where(cond).limit(50).get()).data;
        if (!rs.length) break;
        try { await cloud.deleteFile({ fileList: rs.filter(r => !r._openid).map(r => r.fileID) }); files += rs.length; } catch (e) { /* 忽略 */ }
        await db.collection('exports').where({ _id: _.in(rs.map(r => r._id)) }).remove();
        count += rs.length;
      }
    } else {
      for (let i = 0; i < 200; i++) {
        let r;
        try { r = await db.collection(col).where(cond).remove(); } catch (e) { break; }
        count += r.stats.removed;
        if (!r.stats.removed) break;
      }
    }
    if (count) rows.push({ label, count });
  }
  if (doIt) await log(admin, 'purgeOrphans', { removed: rows, files });
  return ok({ rows, files });
}

/** 操作日志 */
async function log(admin, action, detail) {
  try { await db.createCollection('admin_logs'); } catch (e) { /* 已存在 */ }
  await db.collection('admin_logs').add({ data: { admin, action, ...detail, at: new Date() } });
}

async function adminLogs() {
  try {
    const res = await db.collection('admin_logs').orderBy('at', 'desc').limit(50).get();
    return ok({ list: res.data });
  } catch (e) {
    return ok({ list: [] });
  }
}

// —— 数据库索引 ——
// 与 docs/提审与隐私说明.md 第 1 条一致；direction "1" 升序、"-1" 降序
const INDEXES = [
  ['records', 'owner_status_time', [['ownerOpenid', 1], ['status', 1], ['createdAt', -1]]],
  ['records', 'owner_day_status', [['ownerOpenid', 1], ['payDay', 1], ['status', 1]]],
  ['records', 'owner_book_status', [['ownerOpenid', 1], ['bookId', 1], ['status', 1]]],
  ['records', 'payer_status_paid', [['payerOpenid', 1], ['status', 1], ['paidAt', -1]]],
  ['records', 'payer_time', [['payerOpenid', 1], ['createdAt', -1]]],
  ['records', 'batch', [['batchId', 1]]],
  ['members', 'member', [['memberOpenid', 1]]],
  ['members', 'aid', [['aid', 1]]],
  ['accounts', 'owner', [['ownerOpenid', 1]]],
  ['users', 'openid', [['openid', 1]]],
  ['books', 'owner_time', [['ownerOpenid', 1], ['createdAt', -1]]],
  ['gifts_out', 'owner_name', [['ownerOpenid', 1], ['toName', 1]]],
  ['gifts_out', 'owner_date', [['ownerOpenid', 1], ['date', -1]]],
  ['exports', 'owner_file', [['ownerOpenid', 1], ['fileID', 1]]],
  ['exports', 'keep_time', [['keep', 1], ['createdAt', 1]]],
  ['reminders', 'owner_done_date', [['ownerOpenid', 1], ['done', 1], ['date', 1]]],
  ['reminders', 'push', [['pushed', 1], ['notifyDay', 1]]]
];

/**
 * 一键创建索引：逐条调用 updateIndex（一条失败不影响其他）；已存在的视为成功
 * access_token 用小程序 AppSecret 换取（stable_token），AppSecret 放在本云函数的环境变量 WX_APPSECRET，不写进代码
 */
async function ensureIndexes() {
  const secret = process.env.WX_APPSECRET;
  if (!secret) return err('未配置 AppSecret：云开发控制台 → 云函数 → system → 配置 → 环境变量，添加 WX_APPSECRET');
  const { APPID, ENV } = cloud.getWXContext(); // ENV：当前云环境 ID
  const env = ENV || process.env.TCB_ENV || '';
  if (!env) return err('未获取到云环境 ID');
  const tk = await postJSON('https://api.weixin.qq.com/cgi-bin/stable_token', { grant_type: 'client_credential', appid: APPID, secret });
  if (!tk.access_token) return err(`获取 access_token 失败（${tk.errcode} ${tk.errmsg || ''}），请核对 AppSecret`);

  // 并行创建（串行 15 次请求最坏会超过函数超时）
  const results = await Promise.all(INDEXES.map(async ([col, name, keys]) => {
    try { await db.createCollection(col); } catch (e) { /* 已存在 */ }
    const r = await postJSON(`https://api.weixin.qq.com/tcb/updateindex?access_token=${tk.access_token}`, {
      env,
      collection_name: col,
      create_indexes: [{ name, unique: false, keys: keys.map(([k, d]) => ({ name: k, direction: String(d) })) }],
      drop_indexes: []
    }).catch(e => ({ errcode: -1, errmsg: e.message }));
    const exists = r.errcode !== 0 && /exist|duplicate|already/i.test(r.errmsg || '');
    return { col, name, ok: r.errcode === 0 || exists, existed: exists, msg: r.errcode === 0 || exists ? '' : `${r.errcode} ${r.errmsg || ''}` };
  }));
  return ok({ env, results, created: results.filter(x => x.ok && !x.existed).length, failed: results.filter(x => !x.ok).length });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 8000 }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('返回解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(data);
  });
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
