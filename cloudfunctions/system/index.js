// 云函数 system — 系统设置（管理员）与付费订阅接口（预留）
//   plan         任何登录用户：当前套餐（记账人跟随所服务的主家），并返回自己是否管理员
//   adminGet     管理员：预热配置、上次预热结果、套餐定义
//   adminSetWarmup 管理员：保存预热配置
//   adminSetPlan 管理员：给某位主家开通 / 延期 / 取消套餐（以后接支付回调时由支付流程调用同一逻辑）
//   ads          任何人：广告位配置（前端据此决定是否展示，宾客也会调用）
//   adminSetAds  管理员：保存广告位配置
//   adminPreflight / adminPreflightFix 管理员：上线前检查（v3.72.2 起逐项 ✓/✗/！并给出怎么修）与建缺失集合
//   adminChecklist / adminCheckItem 管理员：上线前手动清单（勾选状态存 settings.launch_checklist）
//   adminIndexes 管理员：一键创建数据库索引（调用云开发 HTTP API updateIndex，需在本函数环境变量配置 WX_APPSECRET）
const cloud = require('wx-server-sdk');
const { ok, err, failOf } = require('./common.js');
const { ownPayCode } = require('./paycode.js'); // 收款码归属（tools/cloud-shared/paycode.js）
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { resolveCtx } = require('./ctx.js');
const P = require('./plans.js');
const Purge = require('./purge.js');

exports.main = async (event, context) => {
  // 上线前检查（v3.72.2）：返回本函数内存 / 超时，带一次性凭据时探测云调用权限，见 meta.js
  if (event && event.action === '__meta') return await require('./meta.js').handle(cloud, event, context, []);
  if (event && event.action === '__warm') return { code: 0, msg: 'warm', data: null };
  // 内部 action：只给 payment 云函数调用，不在前端 request.js 里出现；自带一次性凭据校验（见 internalWxaCode）
  if (event && event.action === '_wxaCode') return await internalWxaCode(event);
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return err('未获取到用户身份');
  try {
    switch (event.action) {
      case 'plan': return await myPlan(OPENID);
      case 'ads': return ok(P.normalizeAds(await P.readSetting(db, 'ads', P.DEFAULT_ADS)));
      case 'adminSetAds': return await guard(OPENID, () => adminSetAds(event.ads));
      case 'adminGet': return await guard(OPENID, adminGet);
      case 'adminSetWarmup': return await guard(OPENID, () => adminSetWarmup(event.warmup));
      case 'adminSetPlan': return await guard(OPENID, () => setPlan(OPENID, event.ownerOpenid, event.plan, event, 'admin'));
      case 'adminFindHosts': return await guard(OPENID, () => findHosts(event.keyword));
      case 'adminIndexes': return await guard(OPENID, () => ensureIndexes());
      case 'adminPreflight': return await guard(OPENID, () => preflight(false, OPENID, context));
      case 'adminPreflightFix': return await guard(OPENID, () => preflight(true, OPENID, context));
      case 'adminChecklist': return await guard(OPENID, async () => ok({ list: await checklist() }));
      case 'adminCheckItem': return await guard(OPENID, () => checkItem(OPENID, String(event.key || ''), event.done === true));
      // 数据清除：按账户（预览 / 备份 / 执行）、按礼簿、无主数据；操作日志
      case 'adminPurgePreview': return await guard(OPENID, () => purgePreview(OPENID, String(event.ownerOpenid || ''), event.guestRecords === true));
      case 'adminBackup': return await guard(OPENID, () => adminBackup(OPENID, String(event.ownerOpenid || '')));
      case 'adminPurge': return await guard(OPENID, () => adminPurge(OPENID, event));
      case 'adminBookPreview': return await guard(OPENID, () => bookPreview(String(event.keyword || event.bookId || '')));
      case 'adminPurgeBook': return await guard(OPENID, () => purgeBook(OPENID, String(event.bookId || ''), event.confirmName));
      case 'adminOrphanPreview': return await guard(OPENID, () => orphans(OPENID, false));
      case 'adminOrphanPurge': return await guard(OPENID, () => orphans(OPENID, true));
      case 'adminLogs': return await guard(OPENID, () => adminLogs());
      // 清除全部测试数据（只在尚未标记正式上线时可用）；标记正式上线（不可撤销）
      case 'adminWipePreview': return await guard(OPENID, () => wipeAll(OPENID, false, event));
      case 'adminWipeAll': return await guard(OPENID, () => wipeAll(OPENID, true, event));
      case 'adminMarkLaunched': return await guard(OPENID, () => markLaunched(OPENID, event.confirm === true));
      default: return err('未知 action');
    }
  } catch (e) {
    console.error('system', event.action, e);
    return failOf(e, '操作失败，请稍后重试');
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
  const launch = await P.readSetting(db, 'launch', { launched: false });
  const [list, last] = await Promise.all([checklist(), readRaw('preflight_last')]);
  return ok({
    warmup: P.normalizeWarmup(warmup), status, plans, warmable: P.WARMABLE,
    ads: P.normalizeAds(ads), adSlots: P.AD_SLOTS,
    launched: launch.launched === true, // 已标记正式上线：不再提供「清除全部测试数据」
    // 上线前检查摘要（v3.72.2）：手动清单与上次自动检查的待处理数，管理员页顶部提醒
    checklist: list,
    preflightLast: last ? { at: last.at || null, bad: last.bad || 0, warn: last.warn || 0 } : null
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

/** 北京时间 YYYY-MM-DD 当天 23:59:59 对应的时间点；格式或日期不合法返回 null */
function bjEndOfDay(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const chk = new Date(Date.UTC(y, mo - 1, d));
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return new Date(Date.UTC(y, mo - 1, d, 23, 59, 59) - 8 * 3600 * 1000);
}

/** 在北京时间日历上加 n 个月（31 号加 1 个月落在月末，如 1/31 → 2/28），保持当天的时分秒 */
function addMonthsBj(base, n) {
  const t = new Date(base.getTime() + 8 * 3600 * 1000);
  const day = t.getUTCDate();
  t.setUTCDate(1);
  t.setUTCMonth(t.getUTCMonth() + n);
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return new Date(t.getTime() - 8 * 3600 * 1000);
}

/**
 * 开通 / 延期 / 缩短 / 取消套餐（v3.67.0）
 * o.mode：
 *   'add'   在当前到期时间（同套餐且未过期）或现在的基础上加 o.days 天，或 o.months 个月（日历月）；缺省按 o.days（默认 30 天，兼容旧调用）
 *   'until' 直接指定到期日 o.until（YYYY-MM-DD，北京时间当天 23:59:59），可延长也可缩短；必须晚于现在
 *   plan='free'（或 mode='cancel'）：取消，无到期日
 * 到期日最晚为 5 年后。每次都写 admin_logs（旧 / 新套餐与到期、模式、主家名）。
 */
async function setPlan(admin, ownerOpenid, plan, o, source) {
  o = o || {};
  ownerOpenid = String(ownerOpenid || '').trim();
  if (!/^[a-zA-Z0-9_-]{10,64}$/.test(ownerOpenid)) return err('openid 不正确');
  const plans = await P.readSetting(db, 'plans', P.DEFAULT_PLANS);
  if (!plans[plan]) return err('套餐不存在');
  const cancel = plan === 'free' || o.mode === 'cancel';
  const mode = cancel ? 'cancel' : o.mode === 'until' ? 'until' : 'add';
  const now = new Date();
  const maxAt = new Date(now.getTime() + 5 * 366 * 24 * 3600 * 1000);
  try { await db.createCollection('subscriptions'); } catch (e) { /* 已存在 */ }
  const col = db.collection('subscriptions');
  let cur = null;
  try { cur = (await col.doc(ownerOpenid).get()).data; } catch (e) { /* 无订阅 */ }
  const before = await P.planOf(db, ownerOpenid);
  let expiresAt = null;
  if (mode === 'until') {
    expiresAt = bjEndOfDay(o.until);
    if (!expiresAt) return err('到期日格式不正确');
    if (expiresAt <= now) return err('到期日不能是过去，要停用请选「取消」');
    if (expiresAt > maxAt) return err('到期日最晚为 5 年后');
  } else if (mode === 'add') {
    const base = cur && cur.plan === plan && cur.expiresAt && new Date(cur.expiresAt) > now ? new Date(cur.expiresAt) : now;
    if (Number(o.months) > 0) {
      expiresAt = addMonthsBj(base, Math.min(60, Math.floor(Number(o.months))));
    } else {
      const n = Math.max(1, Math.min(3660, Math.floor(Number(o.days)) || 30));
      expiresAt = new Date(base.getTime() + n * 24 * 3600 * 1000);
    }
    if (expiresAt > maxAt) return err('到期日最晚为 5 年后');
  }
  await col.doc(ownerOpenid).set({ data: { plan: cancel ? 'free' : plan, expiresAt, source, updatedAt: now } });
  // 读回确认已生效
  const after = await P.planOf(db, ownerOpenid);
  let name = '';
  try { name = String(((await db.collection('accounts').where({ ownerOpenid }).limit(1).get()).data[0] || {}).accountName || ''); } catch (e) { /* 无主家信息 */ }
  await log(admin, 'setPlan', {
    name, ownerOpenid, mode,
    oldPlan: before.plan, oldExpiresAt: before.expiresAt || null,
    newPlan: after.plan, newExpiresAt: after.expiresAt || null
  });
  return ok({
    ownerOpenid, plan: after.plan, planName: after.name, expiresAt: after.expiresAt,
    oldPlan: before.plan, oldPlanName: before.name, oldExpiresAt: before.expiresAt || null, mode
  });
}

// —— 数据清除（管理员） ——
const _ = db.command;
const OPENID_RE = /^[a-zA-Z0-9_-]{10,64}$/;


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
async function adminBackup(admin, ownerOpenid) {
  const t = await target(ownerOpenid);
  if (t.error) return err(t.error);
  const token = require('crypto').randomBytes(24).toString('hex'); // 一次性口令：不可预测
  await P.writeSetting(db, 'admin_backup', { token, ownerOpenid, exp: Date.now() + 2 * 60 * 1000 });
  const res = await cloud.callFunction({ name: 'export', data: { action: 'adminBackup', ownerOpenid, token } });
  const r = res.result || {};
  if (r.code !== 0) return err(r.msg || '备份失败');
  // 记下备份（清除时核对 backupId，确认确实备份过这个账户）
  const logged = await log(admin, 'backup', { ownerOpenid, name: t.name, fileID: r.data.fileID });
  return ok({ ...r.data, backupId: logged });
}

/** 执行清除：需输入该账户名称确认、并已备份（或确认不需要备份） */
async function adminPurge(admin, e) {
  const ownerOpenid = String(e.ownerOpenid || '');
  const t = await target(ownerOpenid);
  if (t.error) return err(t.error);
  if (String(e.confirmName || '').trim() !== t.name) return err('输入的名称与该账户不一致');
  // 必须是 24 小时内为这个账户做过的备份，或明确选择不需要备份
  if (e.skipBackup !== true) {
    let b = null;
    try { b = (await db.collection('admin_logs').doc(String(e.backupId || '')).get()).data; } catch (x) { /* 无 */ }
    if (!b || b.action !== 'backup' || b.ownerOpenid !== ownerOpenid || Date.now() - new Date(b.at).getTime() > 24 * 3600 * 1000) {
      return err('请先备份，或确认不需要备份');
    }
  }
  let res;
  try {
    res = await Purge.run(db, cloud, ownerOpenid, { guestRecords: e.guestRecords === true, subscription: true, ownPayCode });
  } catch (x) {
    console.error('adminPurge 失败', x.errCode, x.message);
    return err('清除未完成（可能超时），已删除的部分不会恢复，请再点一次继续清除');
  }
  await log(admin, 'purgeAccount', { ownerOpenid, name: t.name, guestRecords: e.guestRecords === true, skipBackup: e.skipBackup === true, removed: res.removed, files: res.files });
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
  // 默认礼簿（id 超过 32 字符）的礼簿码文件用短码命名（见 ctx.shortCodeOf）
  if (prefix && bookId.length > 32) {
    const code = 'k' + require('crypto').createHash('md5').update(bookId).digest('hex').slice(0, 24);
    ['develop', 'trial', 'release'].forEach(env => files.push(`${prefix}/qrcodes/${code}-${env}.png`));
  }
  files.push(...(await Purge.qrCacheFiles(db, 'records', { ownerOpenid: book.ownerOpenid, bookId }))); // 小票二维码缓存（v3.59.1）
  for (let i = 0; i < files.length; i += 50) {
    try { await cloud.deleteFile({ fileList: files.slice(i, i + 50) }); } catch (e) { /* 忽略 */ }
  }
  let records = 0;
  for (let i = 0; i < 200; i++) {
    const r = await db.collection('records').where({ ownerOpenid: book.ownerOpenid, bookId }).remove();
    records += r.stats.removed;
    if (!r.stats.removed) break;
  }
  if (book.archivePdf && book.archivePdf.fileID) await db.collection('exports').where({ fileID: book.archivePdf.fileID }).remove();
  await db.collection('books').doc(bookId).remove();
  if (acc && acc.activeBookId === bookId) await db.collection('accounts').doc(acc._id).update({ data: { activeBookId: '' } });
  // 自己选了这一场的机构记账人：清掉选择（只负责这本的记账人在工作台会提示「负责的礼簿已结束」）
  if (acc) await db.collection('members').where({ aid: acc._id, curBookId: bookId }).update({ data: { curBookId: '' } });
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
  // 正在整体移交（中途超时、尚未续跑完）的原主家：数据还挂在他名下，不算无主
  const moving = (await safe(async () => (await db.collection('accounts').where({ transferPending: _.exists(true) }).field({ transferPending: true }).limit(1000).get()).data))
    .map(a => a.transferPending && a.transferPending.from).filter(Boolean);
  const noHost = (await missing(hostOwners, 'accounts', 'ownerOpenid')).filter(o => !moving.includes(o));
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
      if (col === 'records') { // 无主礼金记录的小票二维码缓存（v3.59.1）
        const qf = await Purge.qrCacheFiles(db, 'records', cond);
        for (let i = 0; i < qf.length; i += 50) {
          try { await cloud.deleteFile({ fileList: qf.slice(i, i + 50) }); files += Math.min(50, qf.length - i); } catch (e) { /* 忽略 */ }
        }
      }
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

// —— 清除全部测试数据（上线前一次性使用） ——
const WIPE_TEXT = '清除全部测试数据';

/**
 * 清除全部测试数据：所有账户的礼簿、礼金、主家信息、用户、人员关系、邀请、送礼、提醒、样式、同名合并、导出 / 存档、订阅
 * 保留：settings（管理员、预热、广告、模板等系统设置）、操作日志；默认保留管理员自己的数据（keepAdmins）
 * 只在尚未标记正式上线时可用；doIt=false 只统计。数据多时分批删除，单次约 20 秒后返回 done=false，前端再调用继续
 */
async function wipeAll(admin, doIt, e) {
  const launch = await P.readSetting(db, 'launch', { launched: false });
  if (launch.launched === true) return err('已标记正式上线，不能再清除全部数据');
  if (doIt && String(e.confirmText || '').trim() !== WIPE_TEXT) return err(`请输入「${WIPE_TEXT}」确认`);
  const keep = e.keepAdmins !== false;
  const admins = keep ? ((await P.readSetting(db, 'admins', { openids: [] })).openids || []) : [];
  const not = admins.length ? _.nin(admins) : null;
  const targets = [
    ['礼金记录', 'records', not ? { ownerOpenid: not } : null],
    ['礼簿', 'books', not ? { ownerOpenid: not } : null],
    ['主家信息', 'accounts', not ? { ownerOpenid: _.nin(admins.concat(admins.map(a => 'merged:' + a))) } : null],
    ['用户', 'users', not ? { openid: not } : null],
    ['记账人 / 家人', 'members', not ? { ownerOpenid: not, memberOpenid: not } : null],
    ['邀请卡', 'invites', not ? { ownerOpenid: not } : null],
    ['送礼记录', 'gifts_out', not ? { ownerOpenid: not } : null],
    ['办事提醒', 'reminders', not ? { ownerOpenid: not } : null],
    ['回收站礼金记录', 'trash_records', not ? { ownerOpenid: not } : null],
    ['回收站礼簿', 'trash_books', not ? { ownerOpenid: not } : null],
    ['打印样式', 'print_templates', not ? { ownerOpenid: not } : null],
    ['同名合并', 'person_alias', not ? { ownerOpenid: not } : null],
    ['套餐订阅', 'subscriptions', not ? { _id: not } : null],
    ['导出 / 存档', 'exports', not ? { ownerOpenid: not } : null]
  ];
  // 不保留管理员时用恒真条件（where({}) 不能直接 remove）
  const condOf = c => c || { _id: _.exists(true) };
  if (!doIt) {
    const rows = [];
    for (const [label, col, c] of targets) {
      let count = 0;
      try { count = (await db.collection(col).where(condOf(c)).count()).total; } catch (x) { /* 集合不存在 */ }
      if (count) rows.push({ label, count });
    }
    return ok({ rows, keepAdmins: keep, adminCount: admins.length });
  }
  const start = Date.now();
  const timeUp = () => Date.now() - start > 20 * 1000; // 函数超时为 30 秒，留出写日志的时间
  const removed = [];
  let files = 0;
  let done = true;
  for (const [label, col, c] of targets) {
    let count = 0;
    for (let i = 0; i < 500; i++) {
      if (timeUp()) { done = false; break; }
      if (col === 'exports' || col === 'accounts' || col === 'books' || col === 'trash_books') {
        // 先删文件：导出 / 存档文件、收款码、礼簿存档与本场收款码
        let rows = [];
        try { rows = (await db.collection(col).where(condOf(c)).limit(50).get()).data; } catch (x) { break; }
        if (!rows.length) break;
        const ids = [];
        rows.forEach(r => {
          if (col === 'exports' && !r._openid) ids.push(r.fileID);
          if (col === 'accounts') { ids.push(r.payCodeFileID); if (r.pendingPayCode) ids.push(r.pendingPayCode.fileID); }
          if (col === 'books') { ids.push(r.payCodeFileID); if (r.archivePdf) ids.push(r.archivePdf.fileID); }
          if (col === 'trash_books') (r.files || []).forEach(f => ids.push(f));
        });
        const list = ids.filter(Boolean);
        if (list.length) { try { await cloud.deleteFile({ fileList: list }); files += list.length; } catch (x) { /* 忽略 */ } }
        const res = await db.collection(col).where({ _id: _.in(rows.map(r => r._id)) }).remove();
        count += res.stats.removed;
        if (rows.length < 50) break;
      } else {
        let res;
        try { res = await db.collection(col).where(condOf(c)).remove(); } catch (x) { break; }
        count += res.stats.removed;
        if (!res.stats.removed) break;
      }
    }
    if (count) removed.push({ label, count });
    if (!done) break;
  }
  await log(admin, 'wipeAll', { name: '全部测试数据', keepAdmins: keep, removed, files, done });
  return ok({ removed, files, done });
}

/** 标记正式上线：之后「清除全部测试数据」永久不可用（只能在云开发控制台删除 settings.launch 撤销） */
async function markLaunched(admin, confirm) {
  if (!confirm) return err('参数错误');
  await P.writeSetting(db, 'launch', { launched: true, at: new Date(), by: admin });
  await log(admin, 'markLaunched', { name: '标记正式上线' });
  return ok({ launched: true });
}

/** 操作日志 */
async function log(admin, action, detail) {
  try { await db.createCollection('admin_logs'); } catch (e) { /* 已存在 */ }
  const added = await db.collection('admin_logs').add({ data: { admin, action, ...detail, at: new Date() } });
  return added._id;
}

async function adminLogs() {
  try {
    const res = await db.collection('admin_logs').where({ action: _.neq('backup') }).orderBy('at', 'desc').limit(50).get();
    return ok({ list: res.data });
  } catch (e) {
    return ok({ list: [] });
  }
}

// —— 上线前检查 ——
// 必需集合（与 init 云函数的 COLLECTIONS 一致，另加 sys_config：往来人标识密钥，不属于任何用户，注销 / 清除测试数据都不会动它）
const REQUIRED_COLS = require('./collections.js').COLLECTIONS;

/**
 * 上线前检查（v3.72.2 起逐项返回）：items = [{ group, label, status: ok|bad|warn|manual, text, fix }]
 * 只返回状态，不返回任何密钥内容；fix=true 时顺带创建缺失集合（索引请用「一键创建索引」）。
 * 集合的客户端权限云函数查不到，由管理员页在手机上逐个试读（前端检测）；控制台里才能看到的项目列为手动清单。
 */
// 期望配置：与各云函数 config.json 一致（tests/v3722.test.js 校验）
const EXPECT_TIMEOUT = { account: 60, system: 60, warmer: 60, export: 60, payment: 20, records: 20, books: 20, renqing: 20, qrcode: 20, login: 10 };
const EXPECT_MEMORY = { export: 1024 };
const MSG = 'security.msgSecCheck', IMG = 'security.imgSecCheck', SUB = 'subscribeMessage.send', WXA = 'wxacode.getUnlimited';
const EXPECT_APIS = { account: [MSG, IMG], books: [MSG, IMG], login: [MSG, IMG], payment: [MSG, IMG, SUB, WXA], qrcode: [WXA], warmer: [SUB] };
const META_FUNCS = ['account', 'books', 'export', 'login', 'payment', 'qrcode', 'records', 'renqing', 'warmer'];
const WARMER_STALE_MS = 20 * 60 * 1000;      // warmer 每 5 分钟触发、同一实例 10 分钟最多写一次心跳
const CLEANUP_STALE_MS = 26 * 3600 * 1000;   // export cleanup 每天 3:00

/** 读 settings 原始文档（不合并默认值；带 _openid 的伪造文档视为不存在） */
async function readRaw(id) {
  try {
    const d = (await db.collection('settings').doc(id).get()).data;
    return d && !d._openid ? d : null;
  } catch (e) { return null; }
}

const agoText = t => {
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  return m < 60 ? `${Math.max(0, m)} 分钟前` : m < 48 * 60 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};

/** 调用云函数，超时 / 不存在返回 { error } */
async function callFn(name, data, ms) {
  try {
    const r = await Promise.race([
      cloud.callFunction({ name, data }),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), ms))
    ]);
    return { result: r && r.result };
  } catch (e) {
    const m = String((e && (e.errMsg || e.message)) || e);
    return { error: m, missing: /FUNCTION_NOT_FOUND|function not found|-501000|not exist|不存在/i.test(m) };
  }
}

async function preflight(fix, admin, context) {
  const items = [];
  const add = (group, label, status, text, fixText) => items.push({ group, label, status, text, fix: fixText || '' });

  // —— 数据库：集合、索引 ——
  const cols = await Promise.all(REQUIRED_COLS.map(async name => {
    const has = async () => { try { await db.collection(name).count(); return true; } catch (e) { return false; } };
    let exists = await has();
    let created = false;
    if (!exists && fix) {
      try { await db.createCollection(name); } catch (e) { /* 并发 / 已存在 */ }
      exists = await has();
      created = exists;
    }
    return { name, exists, created };
  }));
  const missing = cols.filter(c => !c.exists).map(c => c.name);
  add('数据库', `必需集合（${cols.length} 个）`, missing.length ? 'bad' : 'ok', missing.length ? '缺 ' + missing.join('、') : '已齐全', '点「一键创建缺失集合」');

  const idx = await readRaw('index_status');
  const okNames = new Set((idx && idx.okNames) || []);
  const idxMissing = INDEXES.filter(([c, n]) => !okNames.has(c + '.' + n)).map(([c, n]) => c + '.' + n);
  if (!idx) add('数据库', `索引（${INDEXES.length} 条）`, 'warn', '还没有运行过一键建索引', '展开「数据库索引」点「一键创建 / 检查索引」');
  else add('数据库', `索引（${INDEXES.length} 条）`, idxMissing.length ? 'bad' : 'ok',
    idxMissing.length ? `缺 ${idxMissing.length} 条：${idxMissing.slice(0, 6).join('、')}${idxMissing.length > 6 ? '…' : ''}` : `已齐全（${agoText(idx.at)}检查）`,
    '展开「数据库索引」重新点一次，按失败原因处理');

  // —— 密钥与系统配置 ——
  const secret = process.env.WX_APPSECRET;
  if (!secret) add('配置', 'WX_APPSECRET（system 环境变量）', 'bad', '未配置：不能建索引，小程序码备用通道不可用', '云开发控制台 → 云函数 → system → 配置 → 环境变量添加 WX_APPSECRET');
  else {
    let tk;
    try { tk = await getAccessToken(false); } catch (e) { tk = { reason: 'net' }; }
    add('配置', 'WX_APPSECRET（system 环境变量）', tk.reason ? 'bad' : 'ok', tk.reason ? `已配置，但换取 access_token 失败（${tk.reason}）` : '已配置，可换取 access_token',
      '核对 AppSecret（小程序后台重置过要同步更新环境变量）');
  }

  const fonts = await fontStatus();
  add('配置', '导出字体（云存储）', fonts.ready ? 'ok' : 'bad', fonts.ready ? '已就绪' : '未上传：' + fonts.fonts.filter(f => !f.uploaded).map(f => f.label).join('、'), '点「上传导出字体」（需先部署 fontsetup）');

  // 往来人标识密钥：只读来源状态与创建时间，不读 secret
  let keyDoc = null, keyState = null;
  try { keyDoc = (await db.collection('sys_config').doc('person_key').field({ createdAt: true, _openid: true }).get()).data; } catch (e) { /* 未生成 */ }
  try { keyState = (await db.collection('sys_config').doc('person_key_state').get()).data; } catch (e) { /* 无 */ }
  const src = keyState && !keyState._openid ? String(keyState.source || '') : '';
  if ((keyDoc && keyDoc._openid) || src === 'forged') add('配置', '往来人标识密钥', 'bad', '密钥文档是客户端伪造的（带 _openid），往来已停用', '云开发控制台 → sys_config 删除 person_key 文档，并把集合权限设为「所有用户不可读写」');
  else if (src === 'env') add('配置', '往来人标识密钥', 'warn', '来自 renqing 环境变量 PERSON_KEY_SECRET', '保持不变：改动或删除会让已存的往来人标识全部失配');
  else if (src === 'default') add('配置', '往来人标识密钥', 'bad', '曾用内置默认值兜底（数据库读不到）', '查看 renqing 日志排查 sys_config 读取失败');
  else if (keyDoc) add('配置', '往来人标识密钥', 'ok', '已自动生成并保存在数据库' + (keyDoc.createdAt ? '（' + agoText(keyDoc.createdAt) + '）' : '') + '，未设环境变量', '不要再给 renqing 设置 PERSON_KEY_SECRET');
  else add('配置', '往来人标识密钥', 'warn', '尚未生成', '打开一次「人情往来」页会自动生成');

  // 套餐定义：settings.plans 文档存在时会覆盖代码默认值，缺的功能项按「开放」处理
  const plansDoc = await readRaw('plans');
  if (!plansDoc) add('配置', '套餐定义（settings.plans）', 'ok', '未单独设置，使用代码默认套餐', '');
  else {
    const lack = [];
    Object.keys(P.DEFAULT_PLANS).forEach(k => {
      const f = (plansDoc[k] && plansDoc[k].features) || null;
      if (!f) { lack.push(`${k}（整个套餐）`); return; }
      const miss = Object.keys(P.DEFAULT_PLANS[k].features).filter(x => !(x in f));
      if (miss.length) lack.push(`${k}：${miss.join('、')}`);
    });
    add('配置', '套餐定义（settings.plans）', lack.length ? 'warn' : 'ok', lack.length ? '缺字段 ' + lack.join('；') : '免费版 / 专业版字段齐全',
      '云数据库 settings.plans 补齐缺的字段（缺项按「不限制」处理），或删除该文档改用代码默认');
  }

  const admins = ((await P.readSetting(db, 'admins', { openids: [] })).openids || []).length;
  add('配置', '管理员人数', admins > 2 ? 'warn' : 'ok', `${admins} 人`, admins > 2 ? '上线前精简到 1～2 人（settings.admins）' : '');

  // —— 定时任务 ——
  const warmup = P.normalizeWarmup(await P.readSetting(db, 'warmup', P.DEFAULT_WARMUP));
  const MODE = { always: '始终预热', paid: '有付费用户或高峰模式时', peak: '仅高峰模式时' };
  add('定时任务', '预热设置', warmup.enabled && warmup.mode === 'always' ? 'ok' : 'warn',
    warmup.enabled ? `${MODE[warmup.mode]} · 每 ${warmup.intervalMin} 分钟 · ${warmup.functions.join('、') || '未选函数'}` : '已关闭',
    '上线初期还没有付费用户，建议选「始终预热」，至少勾选 login、records、payment');
  const beat = await readRaw('warmer_beat');
  const beatOk = beat && Date.now() - new Date(beat.at).getTime() < WARMER_STALE_MS;
  add('定时任务', 'warmer 触发器（每 5 分钟）', beatOk ? 'ok' : 'bad', beat ? `最近运行：${agoText(beat.at)}` : '没有运行记录',
    '开发者工具右键 cloudfunctions/warmer/config.json →「上传触发器」；部署 v3.72.2 后约 10 分钟内会有记录');
  const cb = await readRaw('export_cleanup_beat');
  const cbOk = cb && Date.now() - new Date(cb.at).getTime() < CLEANUP_STALE_MS;
  add('定时任务', 'export 清理触发器（每天 3:00）', cbOk ? 'ok' : 'warn', cb ? `最近运行：${agoText(cb.at)}` : '还没有运行记录（部署后要等到次日 3:00）',
    '开发者工具右键 cloudfunctions/export/config.json →「上传触发器」');

  // —— 云函数：内存 / 超时 / 云调用权限（各函数 __meta 自报；带一次性凭据才探测权限） ——
  const nonce = 'metanonce_' + require('crypto').randomBytes(12).toString('hex');
  try { await db.collection('settings').add({ data: { _id: nonce, kind: 'metaprobe', createdAt: Date.now(), openid: admin } }); } catch (e) { console.warn('写入探测凭据失败', e.message); }
  const [metas, oldFns] = await Promise.all([
    Promise.all(META_FUNCS.map(name => callFn(name, { action: '__meta', nonce }, 25000))),
    Promise.all(['printtpl', 'fontsetup'].map(name => callFn(name, { action: '__warm' }, 15000)))
  ]);
  try { await db.collection('settings').doc(nonce).remove(); } catch (e) { /* warmer 会清理 */ }
  const meta = {};
  META_FUNCS.forEach((name, i) => { meta[name] = metas[i]; });
  meta.system = { result: { code: 0, data: require('./meta.js').runtimeOf(context) } };
  const PERM_TXT = { ok: '已开通', denied: '未开通', timeout: '超时未知' };
  const manualRuntime = [];
  Object.keys(EXPECT_TIMEOUT).forEach(name => {
    const m = meta[name];
    const d = m && m.result && m.result.code === 0 ? m.result.data : null;
    if (!d) {
      add('云函数', name, 'bad', m && m.missing ? '云函数不存在' : '没有响应（未部署 v3.72.2 或调用失败）', `重新部署 ${name}`);
      return;
    }
    const probs = [];
    let unknown = false;
    if (!d.timeout) unknown = true;
    else if (d.timeout < EXPECT_TIMEOUT[name]) probs.push(`超时 ${d.timeout} 秒（应为 ${EXPECT_TIMEOUT[name]}）`);
    if (EXPECT_MEMORY[name]) {
      if (!d.memory) unknown = true;
      else if (d.memory < EXPECT_MEMORY[name]) probs.push(`内存 ${d.memory}MB（应为 ${EXPECT_MEMORY[name]}MB）`);
    }
    const apis = EXPECT_APIS[name] || [];
    const perms = d.perms || {};
    const deniedApis = apis.filter(a => perms[a] === 'denied');
    const odd = apis.filter(a => perms[a] && perms[a] !== 'ok' && perms[a] !== 'denied');
    if (deniedApis.length) probs.push('云调用未开通：' + deniedApis.join('、'));
    if (apis.length && !d.perms) unknown = true;
    const conf = [d.timeout ? `超时 ${d.timeout}s` : '', d.memory ? `内存 ${d.memory}MB` : ''].filter(Boolean).join(' · ');
    const permTxt = apis.length && d.perms ? apis.map(a => a.split('.')[1] + (PERM_TXT[perms[a]] || perms[a])).join('，') : '';
    if (unknown) manualRuntime.push(name);
    add('云函数', name, probs.length ? 'bad' : (odd.length || unknown ? 'warn' : 'ok'),
      probs.length ? probs.join('；') : [conf || '配置读不到', permTxt].filter(Boolean).join('；') + (odd.length ? '（部分探测结果未知）' : ''),
      probs.length || unknown ? `云开发控制台 → 云函数 → ${name}：版本与配置改超时${EXPECT_MEMORY[name] ? ' / 内存 ' + EXPECT_MEMORY[name] + 'MB' : ''}；权限配置 → 云调用开启 ${apis.join('、') || '（无）'}` : '');
  });
  ['printtpl', 'fontsetup'].forEach((name, i) => {
    const r = oldFns[i];
    const gone = r.error && r.missing;
    const fontsNote = name === 'fontsetup' && !fonts.ready ? '（字体还没上传，先别删）' : '';
    add('云函数', `旧函数 ${name}`, gone ? 'ok' : (name === 'fontsetup' && !fonts.ready ? 'ok' : 'warn'), gone ? '已删除' : '仍存在' + fontsNote,
      gone || fontsNote ? '' : `云开发控制台 → 云函数 → 删除 ${name}`);
  });

  // —— 上线 ——
  const launch = await P.readSetting(db, 'launch', { launched: false });
  if (launch.launched === true) add('上线', '正式上线标记', 'ok', '已标记' + (launch.at ? '（' + agoText(launch.at) + '）' : ''), '');
  else {
    let rows = [];
    // 上线前全部清除（含管理员数据，v3.78.6）：统计口径与「清除全部测试数据」默认一致
    try { const w = await wipeAll(admin, false, { keepAdmins: false }); rows = (w.data && w.data.rows) || []; } catch (e) { /* 统计失败 */ }
    const n = rows.reduce((t, r) => t + r.count, 0);
    add('上线', '正式上线标记', 'warn', n ? `未标记；还有测试数据 ${n} 条（${rows.slice(0, 3).map(r => r.label + ' ' + r.count).join('、')}…）` : '未标记',
      n ? '上线前先「清除全部测试数据」，再「标记正式上线」' : '确认无误后点「标记正式上线」');
  }

  const bad = items.filter(x => x.status === 'bad').length;
  const warn = items.filter(x => x.status === 'warn').length;
  try { await P.writeSetting(db, 'preflight_last', { at: new Date(), bad, warn }); } catch (e) { /* 仅摘要 */ }
  if (fix) await log('admin', 'preflightFix', { name: '上线前检查修复', created: cols.filter(c => c.created).map(c => c.name), missing });
  return ok({ items, bad, warn, cols, missing, fonts, manualRuntime, permCols: REQUIRED_COLS, launched: launch.launched === true });
}

// —— 上线前手动清单（云函数查不到的控制台 / 后台 / 真机项目），勾选状态存 settings.launch_checklist ——
const LAUNCH_ITEMS = [
  { key: 'minlib', label: '小程序后台最低基础库设为 2.21.2', fix: '设置 → 基本设置 → 基础库最低版本设置' },
  { key: 'category', label: '服务类目为「工具 > 记账」，不选金融 / 支付', fix: '设置 → 基本设置 → 服务类目' },
  { key: 'privacy', label: '隐私保护指引逐项填写（照片、相册、蓝牙、摄像头、剪切板、头像）', fix: '见 docs/提审与隐私说明.md 第二节' },
  { key: 'tmpl', label: '订阅消息模板与 config.js 四个模板 ID 及关键词一致', fix: '小程序后台 → 订阅消息 → 我的模板：主家新礼金 NOTIFY_TMPL_ID（thing1/thing4/amount7/time9/thing3）；宾客入簿 GUEST_NOTIFY_TMPL_ID（thing6/amount3/time1/thing8/thing5）；宾客未收到 GUEST_REJECT_TMPL_ID（thing4/time1/amount2/thing3）；亲友办事提醒 REMIND_TMPL_ID（thing2/thing10/time11/thing12/thing4）' },
  { key: 'alarm', label: '云开发告警、数据库自动回档已开启', fix: '云开发控制台 → 运维 / 数据库 → 备份与回档' },
  { key: 'storage', label: '云存储权限保持「所有用户可读，仅创建者可读写」', fix: '云开发控制台 → 存储 → 权限设置' },
  { key: 'colperm', label: '19 个集合权限均为「所有用户不可读写」', fix: '云开发控制台 → 数据库 → 各集合 → 数据权限（本页「检测集合权限」可自动核对）' },
  { key: 'e2e', label: '真机全链路：建礼簿 → 第二个微信扫码随礼 → 确认 → 回执 → 导出', fix: '用正式版或体验版走一遍' },
  { key: 'printer', label: '58mm、80mm 打印机各打印一张小票', fix: '我的 → 打印机' },
  { key: 'paycode', label: '收款码上传后用微信扫一扫能识别', fix: '主家信息页上传手机原图后，扫礼簿码进入随礼页扫码' },
  { key: 'wipe', label: '已清除全部测试数据并标记正式上线', fix: '本页「数据清除」' }
];

async function checklist() {
  const doc = (await readRaw('launch_checklist')) || {};
  const st = doc.items || {};
  const by = [...new Set(LAUNCH_ITEMS.map(i => st[i.key] && st[i.key].done && st[i.key].by).filter(Boolean))];
  const names = {};
  if (by.length) {
    try {
      (await db.collection('users').where({ openid: _.in(by) }).field({ openid: true, nickname: true }).get()).data.forEach(u => { names[u.openid] = u.nickname || '管理员'; });
    } catch (e) { /* 只是显示名 */ }
  }
  return LAUNCH_ITEMS.map(i => {
    const x = st[i.key] || {};
    return { key: i.key, label: i.label, fix: i.fix, done: x.done === true, byName: x.done ? (names[x.by] || '管理员') : '', at: x.done ? (x.at || null) : null };
  });
}

async function checkItem(admin, key, done) {
  if (!LAUNCH_ITEMS.some(i => i.key === key)) return err('参数错误');
  const doc = (await readRaw('launch_checklist')) || {};
  const items = { ...(doc.items || {}) };
  items[key] = done ? { done: true, by: admin, at: new Date() } : { done: false };
  await P.writeSetting(db, 'launch_checklist', { items });
  return ok({ list: await checklist() });
}

/** 导出字体是否已上传到云存储并登记（settings.export_fonts，由 fontsetup 云函数写入；不返回 fileID） */
async function fontStatus() {
  const LABEL = { sans: '黑体', serif: '宋体', brush: '毛笔字体' };
  let fonts = {};
  try {
    const d = (await db.collection('settings').doc('export_fonts').get()).data;
    if (d && !d._openid && d.fonts) fonts = d.fonts;
  } catch (e) { /* 未登记 */ }
  const list = Object.keys(LABEL).map(key => ({ key, label: LABEL[key], uploaded: !!(fonts[key] && fonts[key].fileID) }));
  return { ready: list.every(f => f.uploaded), fonts: list };
}

// —— 数据库索引 ——
// 共 31 条，docs/提审与隐私说明.md 第三节第 1 条的表按本清单生成（改这里要同步）；direction "1" 升序、"-1" 降序
const INDEXES = [
  ['records', 'owner_status_time', [['ownerOpenid', 1], ['status', 1], ['createdAt', -1]]],
  ['records', 'owner_status_amount', [['ownerOpenid', 1], ['status', 1], ['amount', -1]]], // 礼簿页按金额排序
  ['records', 'owner_day_status', [['ownerOpenid', 1], ['payDay', 1], ['status', 1]]],
  ['records', 'owner_book_status', [['ownerOpenid', 1], ['bookId', 1], ['status', 1]]],
  ['records', 'owner_book_time', [['ownerOpenid', 1], ['bookId', 1], ['createdAt', -1]]], // 礼簿页按礼簿筛选（默认排序）
  ['records', 'owner_book_name', [['ownerOpenid', 1], ['bookId', 1], ['payerName', 1]]], // 礼簿页按姓名排序 / 只看重名
  ['records', 'owner_book_amount', [['ownerOpenid', 1], ['bookId', 1], ['amount', -1]]], // 礼簿页按礼簿 + 金额排序
  ['records', 'payer_status_paid', [['payerOpenid', 1], ['status', 1], ['paidAt', -1]]],
  ['records', 'payer_time', [['payerOpenid', 1], ['createdAt', -1]]],
  ['records', 'payer_status_time', [['payerOpenid', 1], ['status', 1], ['createdAt', -1]]], // 我的随礼记录「等待主家确认」（v3.66.0）
  ['records', 'payer_status_rejected', [['payerOpenid', 1], ['status', 1], ['rejectedAt', -1]]], // 我的随礼记录「主家未确认收到」（v3.73.0）
  ['records', 'claimed_status_paid', [['claimedOpenid', 1], ['status', 1], ['paidAt', -1]]], // 我的随礼记录（小票二维码认领）
  ['records', 'rcpt_token', [['rcptToken', 1]]], // 扫小票二维码按 token 查回执
  ['records', 'batch', [['batchId', 1]]],
  ['records', 'owner_status_appeal', [['ownerOpenid', 1], ['status', 1], ['appealStatus', 1]]], // 宾客申诉跨礼簿计数 / 列表（v3.77.0）
  ['records', 'guest_retry', [['guestNotify', 1], ['status', 1], ['paidAt', -1]]], // warmer 补发宾客入簿通知（v3.68.1）
  ['records', 'owner_payer', [['ownerOpenid', 1], ['payerName', 1]]], // 往来按姓名查询 / nameCheck
  ['trash_records', 'owner_book', [['ownerOpenid', 1], ['bookId', 1]]],
  ['trash_books', 'status_purge', [['trashStatus', 1], ['purgeAt', 1]]], // warmer 到期清除 / 续跑未完成
  ['person_alias', 'owner', [['ownerOpenid', 1]]],
  ['members', 'member', [['memberOpenid', 1]]],
  ['members', 'aid', [['aid', 1]]],
  ['accounts', 'owner', [['ownerOpenid', 1]]],
  ['accounts', 'peak', [['peakUntil', -1]]], // warmer 判断是否有人开着高峰模式（v3.69.0）
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
  // 记下本次结果（v3.72.2），上线前检查据此列出缺失的索引
  try {
    await P.writeSetting(db, 'index_status', {
      at: new Date(), okNames: results.filter(x => x.ok).map(x => x.col + '.' + x.name),
      failed: results.filter(x => !x.ok).map(x => ({ col: x.col, name: x.name, msg: x.msg }))
    });
  } catch (e) { console.warn('记录索引结果失败', e.message); }
  return ok({ env, results, created: results.filter(x => x.ok && !x.existed).length, failed: results.filter(x => !x.ok).length });
}

// —— 内部 action `_wxaCode`：用 AppSecret 走 HTTPS 接口（getwxacodeunlimit）取小程序码图片（payment 的云调用权限缺失时的备用通道）——
// （v3.57.1 的 `_urlLink` 已删除：URL Link 只开放给大陆非个人主体，个人主体报 85407。）
// 为什么不用「没有 OPENID / SOURCE」判断：云函数之间 callFunction 时，被调用方的 getWXContext 可能沿用最初调用者的 OPENID，
// SOURCE 的取值也没有可依赖的文档约定，据此判断可能把合法调用挡在外面，也可能被客户端直接调用绕过。
// 所以改用一次性凭据：payment 先往 settings 集合写 urlnonce_xxx（该集合客户端不可读写，且带 _openid 的伪造文档会被忽略），
// 这里读到、未过期（60 秒）、没有 _openid 才放行，并立即删除。客户端拿不到也伪造不出这个凭据。
// 只允许固定页面，scene 只允许小程序码合法字符且 ≤32 位，防止被拿来批量生成任意码。
const WXA_PAGES = ['pages/receipt/receipt', 'pages/index/index'];
let tokenCache = null; // { token, exp } 实例内缓存 access_token（stable_token 有效期 2 小时，这里只缓存 90 分钟）

async function internalWxaCode(event) {
  const fail = reason => ({ code: 0, msg: 'ok', data: { image: '', reason } });
  const id = String(event.nonce || '');
  if (!/^urlnonce_[0-9a-f]{24}$/.test(id)) return err('无权调用');
  let doc = null;
  try { doc = (await db.collection('settings').doc(id).get()).data; } catch (e) { /* 不存在 */ }
  if (!doc || doc._openid || doc.kind !== 'urllink' || Date.now() - Number(doc.createdAt || 0) > 60000) return err('无权调用');
  try { await db.collection('settings').doc(id).remove(); } catch (e) { /* 忽略 */ }
  const page = String(event.page || '');
  const scene = String(event.scene || '');
  if (!WXA_PAGES.includes(page) || !/^[A-Za-z0-9=_.-]{1,32}$/.test(scene)) return fail('bad-param');
  const env = ['develop', 'trial', 'release'].includes(event.envVersion) ? event.envVersion : 'release';
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tk = await getAccessToken(attempt > 0);
      if (tk.reason) return fail(tk.reason);
      // 280 = 官方允许的最小宽度；纯黑白（不自动配色、黑色线条、不透明底），热敏打印二值化后最清晰；check_path=false：未发布 / 体验版也能生成
      const r = await postRaw(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${tk.token}`, {
        scene, page, width: 280, check_path: false, env_version: env,
        auto_color: false, line_color: { r: 0, g: 0, b: 0 }, is_hyaline: false
      });
      if (r.image) return { code: 0, msg: 'ok', data: { image: r.image.toString('base64') } };
      if ((r.errcode === 40001 || r.errcode === 42001) && attempt === 0) { tokenCache = null; continue; } // access_token 失效：强制刷新后重试一次
      return fail('http:' + r.errcode);
    }
  } catch (e) {
    console.error('system._wxaCode', e && e.message);
    return fail('net:' + String((e && e.message) || 'err').slice(0, 20));
  }
  return fail('http:retry');
}

/** 取 access_token（stable_token）；force 时强制刷新。失败返回 { reason }，reason 不含密钥 */
async function getAccessToken(force) {
  const secret = process.env.WX_APPSECRET;
  if (!secret) return { reason: 'secret-missing' };
  if (!force && tokenCache && tokenCache.exp > Date.now()) return { token: tokenCache.token };
  const { APPID } = cloud.getWXContext();
  const tk = await postJSON('https://api.weixin.qq.com/cgi-bin/stable_token', { grant_type: 'client_credential', appid: APPID, secret, force_refresh: !!force });
  if (!tk.access_token) return { reason: 'token:' + tk.errcode }; // 如 40125 AppSecret 不正确（含被重置过）、40013 AppID 无效
  tokenCache = { token: tk.access_token, exp: Date.now() + 90 * 60 * 1000 };
  return { token: tk.access_token };
}

/** POST JSON，返回 { image: Buffer } 或 { errcode, errmsg }（getwxacodeunlimit 成功时直接返回图片二进制） */
function postRaw(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 8000 }, res => {
      const bufs = [];
      res.on('data', c => bufs.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const buf = Buffer.concat(bufs);
        const isImg = (buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xff && buf[1] === 0xd8);
        if (isImg) return resolve({ image: buf });
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(new Error('返回解析失败')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(data);
  });
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

