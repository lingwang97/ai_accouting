// 云函数 account — 主家信息、记账人（邀请 / 移除 / 身份切换）、移交主家、清除数据
// 数据始终属于主家；记账人与主家权限相同，只有"清除数据"和"人情往来"按本人身份处理
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const accounts = db.collection('accounts');
const members = db.collection('members');
const invites = db.collection('invites');
const { resolveCtx, restricted, readonly, trusted, can, PERMS, ALL_PERMS, DEFAULT_PERMS, cleanPerms } = require('./ctx.js');
const P = require('./plans.js');
const Purge = require('./purge.js');
const TITLES = ['', '礼台', '收银', '主管']; // 机构版礼台人员岗位
const INVITE_TTL = 7 * 24 * 3600 * 1000; // 邀请 7 天内有效
const INVITE_USES = 5;  // 记账人 / 家人共享邀请卡：每张最多几人使用（默认）
const INVITE_USES_MAX = 10;
const PAY_MODES = ['longpress', 'screen'];

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
    await ensureCol('accounts');
    await ensureCol('members');
    await ensureCol('invites');
    switch (event.action) {
      case 'get':
        return await getMine(OPENID, event.withPayCode === true);
      case 'save':
        return await save(OPENID, event);
      case 'createInvite':
        return await createInvite(OPENID, event.type, event);
      case 'inviteInfo':
        return await inviteInfo(event.token);
      case 'acceptInvite':
        return await acceptInvite(OPENID, event.token, event.displayName);
      case 'pendingMembers':
        return await pendingMembers(OPENID);
      case 'approveMember':
        return await approveMember(OPENID, event.memberId, event.approve === true);
      case 'payCodeReviews':
        return await payCodeReviews(OPENID);
      case 'payCodeDecide':
        return await payCodeDecide(OPENID, String(event.target || ''), event.approve === true);
      case 'setHandlerName':
        return await setHandlerName(OPENID, event.memberId, event.name);
      case 'members':
        return await listMembers(OPENID);
      case 'removeMember':
        return await removeMember(OPENID, event.memberId);
      case 'viewers':
        return await listViewers(OPENID);
      case 'setOrgMode':
        return await setOrgMode(OPENID, event.orgMode === true, event.orgName);
      case 'memberUpdate':
        return await memberUpdate(OPENID, event.memberId, event.title, event.bookIds, event.allBooks, event.perms);
      case 'setTheme':
        return await setTheme(OPENID, event.primary);
      case 'leave':
        return await leave(OPENID, event.aid);
      case 'switch':
        return await switchIdentity(OPENID, event.aid);
      case 'getByAid':
        return await getByAid(event.aid);
      case 'purge':
        return await purge(OPENID, event.confirm);
      default:
        return err('未知 action');
    }
  } catch (e) {
    console.error('account', event.action, e);
    return err('账户操作失败，请稍后重试');
  }
};

/** 当前身份下的主家信息 + 全部可切换身份 */
async function getMine(openid, withPayCode) {
  let ctx = await resolveCtx(db, openid);
  // 整体移交中途超时：接收人下次打开时续跑剩余的迁移（合并前接收人名下可能有两份主家信息，单独查）
  const tp = (await accounts.where({ ownerOpenid: openid, transferPending: _.exists(true) }).limit(1).get()).data[0];
  if (tp) {
    await resumeTransfer(tp, openid);
    ctx = await resolveCtx(db, openid);
  }
  // 收款码由主家（或移交前的记账人）上传，云存储只有上传者可读：预览链接由云函数生成
  // 只有主家信息页、礼簿码页需要（withPayCode），其余页面省掉这次调用
  let account = ctx.account && safeAccount(ctx.account, ctx);
  // 没有「修改主家信息」权限的记账人看不到收款码文件，但可以看预览（申请更换收款码时对照）；家人不返回
  const codeId = ctx.account && ctx.account.payCodeFileID;
  if (withPayCode && account && codeId && (can(ctx, 'info') || can(ctx, 'paycode') || can(ctx, 'show'))) {
    try {
      const t = await cloud.getTempFileURL({ fileList: [codeId] });
      const f = t.fileList && t.fileList[0];
      account = { ...account, payCodeUrl: (f && f.status === 0 && f.tempFileURL) || '' };
    } catch (e) { /* 预览失败不影响使用 */ }
  }
  return ok({
    account,
    role: ctx.role,                  // owner 主家本人 | clerk 记账人 | viewer 家人共享 | none 尚未完善
    restricted: restricted(ctx),     // 只负责部分礼簿（数据范围受限）/ 家人共享
    readonly: readonly(ctx),         // 家人共享：只读
    perms: ctx.perms || [],          // 拥有的权限（主家为全部，见 ctx.PERMS）
    // 主家：待处理的入伙申请数（工作台提醒）
    pendingMembers: ctx.role === 'owner' ? (await members.where({ aid: ctx.account._id, status: 'pending' }).count()).total : 0,
    lastNotify: (ctx.user && ctx.user.lastNotify) || null, // 最近一次新礼金提醒的发送结果
    identities: await identities(openid)
  });
}

/**
 * 返回给前端的主家信息：去掉内部字段；没有「修改主家信息」权限的记账人与家人看不到收款码文件
 */
function safeAccount(a, ctx) {
  const { ownerOpenid, transferredFrom, transferPending, _openid, pendingPayCode, ...rest } = a;
  if (!can(ctx, 'info')) { delete rest.payCodeFileID; delete rest.payCodeBy; }
  return { ...rest, hasPendingPayCode: !!pendingPayCode };
}

/** 我能使用的身份：自己的主家信息 + 作为记账人加入的主家（待主家同意的不算） */
async function identities(openid) {
  const list = [];
  const own = (await accounts.where({ ownerOpenid: openid, _openid: _.exists(false) }).limit(1).get()).data[0];
  if (own) list.push({ aid: own._id, name: own.accountName, role: 'owner' });
  const ms = (await members.where({ memberOpenid: openid, _openid: _.exists(false) }).limit(20).get()).data
    .filter(m => m.status !== 'pending');
  if (ms.length) {
    const accs = (await accounts.where({ _id: _.in(ms.map(m => m.aid)) }).field({ accountName: true }).get()).data;
    accs.forEach(a => {
      const m = ms.find(x => x.aid === a._id);
      list.push({ aid: a._id, name: a.accountName, role: m && m.role === 'viewer' ? 'viewer' : 'clerk' });
    });
  }
  return list;
}

async function save(openid, event) {
  const accountName = String(event.accountName || '').trim().slice(0, 30);
  const payCodeFileID = String(event.payCodeFileID || '').slice(0, 200);
  if (!accountName) return err('请填写账户名称');
  if (!payCodeFileID.startsWith('cloud://')) return err('收款码图片无效');

  // own=true：操作本人自己的主家信息（记账人新建自己的礼簿）；否则按当前身份
  let ctx = await resolveCtx(db, openid);
  if (event.own !== true && readonly(ctx)) return err('家人共享为只读，不能修改');
  // 没有「修改主家信息」权限的记账人：有「申请更换收款码」权限时只能申请更换收款码（主家确认后生效）
  const codeOnly = event.own !== true && ctx.account && !can(ctx, 'info');
  if (codeOnly && !can(ctx, 'paycode')) return err('你没有修改主家信息的权限');
  if (event.own === true && ctx.role !== 'owner') {
    const mine = (await accounts.where({ ownerOpenid: openid, _openid: _.exists(false) }).limit(1).get()).data[0] || null;
    ctx = { role: mine ? 'owner' : 'none', ownerOpenid: openid, account: mine, user: ctx.user };
    if (mine) await setCurrent(openid, mine._id);
  }

  // 收款码关系到钱进谁的账户：新上传的必须是本人刚上传的图片（不能填别人的文件）
  const codeChanged = !ctx.account || payCodeFileID !== ctx.account.payCodeFileID;
  if (codeOnly && !codeChanged) return err('请上传新的收款码');
  if (codeChanged) {
    if (!ownPayCode(payCodeFileID, openid)) return err('收款码图片无效，请重新上传');
    try {
      const info = await cloud.getTempFileURL({ fileList: [payCodeFileID] });
      const f = info.fileList && info.fileList[0];
      if (!f || !f.tempFileURL || f.status !== 0) return err('收款码图片不可用，请重新上传');
    } catch (e) {
      return err('收款码图片校验失败');
    }
  }

  const theme = {
    name: String((event.theme && event.theme.name) || '默认主题').slice(0, 20),
    primary: /^#[0-9a-fA-F]{6}$/.test((event.theme || {}).primary || '') ? event.theme.primary : '#C8161D',
    bg: /^#[0-9a-fA-F]{6}$/.test((event.theme || {}).bg || '') ? event.theme.bg : '#F7F7F7',
    // 主家在「主家信息」页亲自选过主题色才作为全局主色（旧账号的默认绿色不算）
    chosen: (event.theme || {}).chosen === true
  };
  const data = { accountName, updatedAt: db.serverDate() };
  // 主题色在「外观设置」单独修改（setTheme）；未传时保持原值，新建主家信息用默认
  if (event.theme || !ctx.account) data.theme = theme;
  // 收款模式：longpress=付款方手机长按识别收款码（原模式）；screen=店主亮屏双码（新模式）。未传则保持原值
  if (PAY_MODES.includes(event.payMode)) data.payMode = event.payMode;
  // 礼金快捷金额（宾客随礼页一键选择），未传则保持原值
  if (Array.isArray(event.quickAmounts)) {
    data.quickAmounts = event.quickAmounts.map(Number)
      .filter(n => Number.isFinite(n) && n > 0 && n <= 100000)
      .map(n => Math.round(n * 100) / 100)
      .slice(0, 8);
  }
  // 机构模式（机构版）：需要专业版套餐；关闭随时可以
  if (typeof event.orgMode === 'boolean') {
    if (event.orgMode) {
      const plan = await P.planOf(db, ctx.ownerOpenid);
      if (!plan.features.org) return err('机构模式属于机构版功能，请联系我们开通');
    }
    data.orgMode = event.orgMode;
    data.orgName = String(event.orgName || '').trim().slice(0, 30);
  }
  if (!ctx.account) {
    data.payCodeFileID = payCodeFileID;
    const added = await accounts.add({ data: { ownerOpenid: openid, ...data, createdAt: db.serverDate() } });
    await setCurrent(openid, added._id);
    return ok({ account: safeAccount({ _id: added._id, ownerOpenid: openid, ...data }, ctx) });
  }
  if (codeOnly) {
    const by = handlerOf(ctx);
    await accounts.doc(ctx.account._id).update({ data: { pendingPayCode: { fileID: payCodeFileID, by, byOpenid: openid, at: new Date() }, payCodeCheck: true, payCodeBy: by } });
    return ok({ account: safeAccount({ ...ctx.account, pendingPayCode: true }, ctx), pendingPayCode: true });
  }
  // 记账人更换收款码：先存为待确认，主家在「主家信息」页核对采用后才生效，宾客仍转到原收款码
  let pendingCode = false;
  if (ctx.role === 'clerk') {
    if (codeChanged) {
      data.pendingPayCode = { fileID: payCodeFileID, by: handlerOf(ctx), byOpenid: openid, at: new Date() };
      data.payCodeCheck = true;
      data.payCodeBy = handlerOf(ctx);
      pendingCode = true;
    }
  } else {
    // 主家本人更换收款码、或在本页核对后保存（confirmPayCode）：解除提醒（礼簿另有待确认的收款码时保留）
    if (codeChanged) {
      data.payCodeFileID = payCodeFileID;
      if (ctx.account.pendingPayCode) data.pendingPayCode = _.remove();
    }
    if (ctx.account.payCodeCheck && (codeChanged || event.confirmPayCode === true)) {
      const left = (ctx.account.pendingPayCode && !codeChanged) || (await bookPendingCount(ctx.ownerOpenid)) > 0;
      if (!left) { data.payCodeCheck = false; data.payCodeBy = ''; }
    }
  }
  await accounts.doc(ctx.account._id).update({ data });
  const merged = { ...ctx.account, ...data };
  if (data.pendingPayCode && !pendingCode) delete merged.pendingPayCode;
  return ok({ account: safeAccount(merged, ctx), pendingPayCode: pendingCode });
}

/** 是否为该用户本人上传到 paycodes/ 目录的收款码（前端上传路径见 pages/account、pages/bookedit） */
function ownPayCode(fileID, openid) {
  const esc = String(openid).replace(/[^a-zA-Z0-9_-]/g, '');
  return !!esc && new RegExp(`^cloud://[^/]+/paycodes/(book-)?${esc}-\\d+\\.(png|jpe?g|webp)$`, 'i').test(String(fileID || ''));
}

const handlerOf = ctx => (ctx.member && ctx.member.displayName) || (ctx.user && ctx.user.nickname) || '记账人';

/** 礼簿上待主家确认的收款码数量（机构版本场收款码） */
async function bookPendingCount(ownerOpenid) {
  return (await db.collection('books').where({ ownerOpenid, pendingPayCode: _.exists(true) }).count()).total;
}

/** 主家：待确认的收款码（主家信息 + 各礼簿），附预览链接 */
async function payCodeReviews(openid) {
  const ctx = await resolveCtx(db, openid);
  if (ctx.role !== 'owner') return err('只有主家本人可以确认收款码');
  const list = [];
  if (ctx.account.pendingPayCode) {
    list.push({ target: 'account', name: '主家信息', fileID: ctx.account.pendingPayCode.fileID, cur: ctx.account.payCodeFileID, by: ctx.account.pendingPayCode.by, at: ctx.account.pendingPayCode.at });
  }
  const bk = (await db.collection('books').where({ ownerOpenid: ctx.ownerOpenid, pendingPayCode: _.exists(true) }).limit(100).get()).data;
  bk.forEach(b => list.push({
    target: b._id, name: b.hostName ? `${b.hostName} · ${b.name}` : b.name,
    fileID: b.pendingPayCode.fileID, cur: b.payCodeFileID || ctx.account.payCodeFileID, by: b.pendingPayCode.by, at: b.pendingPayCode.at
  }));
  const ids = [...new Set(list.flatMap(x => [x.fileID, x.cur]).filter(Boolean))];
  const urls = {};
  if (ids.length) {
    try {
      (await cloud.getTempFileURL({ fileList: ids })).fileList.forEach(f => { if (f.status === 0) urls[f.fileID] = f.tempFileURL; });
    } catch (e) { /* 预览失败不影响 */ }
  }
  return ok({ list: list.map(({ fileID, cur, ...x }) => ({ ...x, url: urls[fileID] || '', curUrl: urls[cur] || '' })) });
}

/** 主家采用 / 驳回记账人提交的收款码；全部处理完后解除工作台提醒 */
async function payCodeDecide(openid, target, approve) {
  const ctx = await resolveCtx(db, openid);
  if (ctx.role !== 'owner') return err('只有主家本人可以确认收款码');
  let pend;
  if (target === 'account') {
    pend = ctx.account.pendingPayCode;
    if (!pend) return err('没有待确认的收款码');
    await accounts.doc(ctx.account._id).update({ data: { pendingPayCode: _.remove(), ...(approve ? { payCodeFileID: pend.fileID } : {}) } });
  } else {
    const b = (await db.collection('books').where({ _id: target, ownerOpenid: ctx.ownerOpenid }).limit(1).get()).data[0];
    if (!b || !b.pendingPayCode) return err('没有待确认的收款码');
    pend = b.pendingPayCode;
    await db.collection('books').doc(b._id).update({ data: { pendingPayCode: _.remove(), ...(approve ? { payCodeFileID: pend.fileID } : {}) } });
  }
  if (!approve && ownPayCode(pend.fileID, pend.byOpenid)) {
    try { await cloud.deleteFile({ fileList: [pend.fileID] }); } catch (e) { /* 已不存在 */ }
  }
  const accLeft = target !== 'account' && ctx.account.pendingPayCode;
  if (!accLeft && !(await bookPendingCount(ctx.ownerOpenid))) {
    await accounts.doc(ctx.account._id).update({ data: { payCodeCheck: false, payCodeBy: '' } });
  }
  return ok({ target, approved: approve });
}

// —— 记账人 ——

/**
 * 生成邀请：type=clerk 邀请记账人（主家或记账人均可邀请）；type=viewer 家人共享
 *   每张卡最多 maxUses 人使用，加入的人需主家同意后才生效
 * type=transfer 移交（只有主家本人可发起）：
 *   opts.bookIds 选择要移交的礼簿；全选（或不传）为整体移交——主家信息、收款码、礼簿码一起转
 *   opts.stayClerk 移交后发起人是否继续为对方记账（默认是）
 */
async function createInvite(openid, type, opts = {}) {
  const ctx = await resolveCtx(db, openid);
  if (!ctx.account) return err('请先完善主家信息');
  type = ['transfer', 'viewer'].includes(type) ? type : 'clerk';
  if (type === 'transfer' && ctx.role !== 'owner') return err('只有主家本人可以移交');
  if (!can(ctx, 'members')) return err('你没有邀请记账人的权限');
  const now = new Date();
  const data = {
    type, aid: ctx.account._id, ownerOpenid: ctx.ownerOpenid, fromOpenid: openid,
    fromName: (ctx.user && ctx.user.nickname) || '', accountName: ctx.account.accountName,
    used: false, createdAt: now, expiresAt: new Date(now.getTime() + INVITE_TTL)
  };
  if (type !== 'transfer') {
    data.maxUses = Math.max(1, Math.min(INVITE_USES_MAX, Math.floor(Number(opts.maxUses)) || INVITE_USES));
    data.uses = 0;
  }
  if (type === 'clerk') {
    // 负责的礼簿 + 授予的权限；都不能超出邀请人自己拥有的
    const scope = await pickScope(ctx, opts.bookIds, opts.allBooks === true, [ctx.account.activeBookId]);
    if (scope.error) return err(scope.error);
    Object.assign(data, scope);
    const perms = grantable(ctx, opts.perms);
    if (perms.error) return err(perms.error);
    data.perms = perms.perms;
  }
  if (type === 'viewer') {
    // 礼簿共享：只共享选中的礼簿（只能共享自己负责的）
    const want = (Array.isArray(opts.bookIds) ? opts.bookIds.slice(0, 100).map(String) : []).filter(id => !ctx.bookIds || ctx.bookIds.includes(id));
    const picked = want.length
      ? (await db.collection('books').where({ _id: _.in(want), ownerOpenid: ctx.ownerOpenid }).get()).data
      : [];
    if (!picked.length) return err('请选择要共享的礼簿');
    data.bookIds = picked.map(b => b._id);
    data.books = picked.map(b => ({ name: b.hostName ? `${b.hostName} · ${b.name}` : b.name, count: b.statCount || 0, sum: (b.statFen || 0) / 100 }));
  }
  if (type === 'transfer') {
    const all = (await db.collection('books').where({ ownerOpenid: openid }).limit(1000).get()).data;
    const want = Array.isArray(opts.bookIds) ? opts.bookIds.map(String) : all.map(b => b._id);
    const picked = all.filter(b => want.includes(b._id));
    if (!picked.length) return err('请选择要移交的礼簿');
    data.full = picked.length === all.length;
    data.bookIds = picked.map(b => b._id);
    data.books = picked.map(b => ({ name: b.name, count: b.statCount || 0, sum: (b.statFen || 0) / 100 }));
    data.stayClerk = opts.stayClerk !== false;
    // 同一时间只保留最新一张移交卡：之前未被接收的作废，避免两人同时接收把数据拆散
    await invites.where({ aid: ctx.account._id, type: 'transfer', used: false }).update({ data: { used: true, voided: true } });
  }
  const added = await invites.add({ data });
  return ok({ token: added._id, type, accountName: ctx.account.accountName, full: !!data.full, books: data.books || [], allBooks: !!data.allBooks, perms: data.perms || [], maxUses: data.maxUses || 1 });
}

/**
 * 记账人负责的礼簿：allBooks 为全部（含以后新建的）；不能超出操作人自己负责的
 * 返回 { allBooks: true, bookIds: [] } 或 { bookIds, books }，未选时用 fallback
 */
async function pickScope(ctx, bookIds, allBooks, fallback) {
  if (allBooks) {
    if (ctx.bookIds) return { error: '你只负责部分礼簿，不能授予全部礼簿' };
    return { allBooks: true, bookIds: [], books: [] };
  }
  let want = Array.isArray(bookIds) && bookIds.length ? bookIds.slice(0, 100).map(String) : (fallback || []).filter(Boolean);
  if (ctx.bookIds) want = want.filter(id => ctx.bookIds.includes(id));
  const picked = want.length
    ? (await db.collection('books').where({ _id: _.in(want), ownerOpenid: ctx.ownerOpenid }).get()).data
    : [];
  if (!picked.length) return { error: '请选择记账人负责的礼簿' };
  return {
    allBooks: false,
    bookIds: picked.map(b => b._id),
    books: picked.map(b => ({ name: b.hostName ? `${b.hostName} · ${b.name}` : b.name, count: b.statCount || 0, sum: (b.statFen || 0) / 100 }))
  };
}

/** 可授予的权限：未传时为默认权限；只能授予操作人自己拥有的 */
function grantable(ctx, perms) {
  const want = cleanPerms(perms) || DEFAULT_PERMS.slice();
  const out = want.filter(k => can(ctx, k));
  if (!out.length) return { error: '请至少授予一项权限' };
  return { perms: out };
}

/** 邀请详情（接受前展示） */
async function inviteInfo(token) {
  const inv = await getInvite(token);
  if (!inv) return err('邀请不存在或已失效');
  const max = inv.maxUses || INVITE_USES;
  return ok({
    type: inv.type, accountName: inv.accountName, fromName: inv.fromName, used: inv.used, expired: inv.expiresAt < new Date(),
    full: inv.type === 'transfer' ? inv.full !== false : undefined, // 旧版移交邀请没有 full 字段，视为整体移交（家人共享无此字段）
    books: inv.books || [],
    allBooks: !!inv.allBooks,
    perms: inv.type === 'clerk' ? (inv.perms || DEFAULT_PERMS).map(k => PERMS[k]).filter(Boolean) : [], // 授予的权限（显示名）
    stayClerk: inv.stayClerk !== false,
    maxUses: inv.type === 'transfer' ? 1 : max,
    left: inv.type === 'transfer' ? (inv.used ? 0 : 1) : Math.max(0, max - (inv.uses || 0)),
    voided: !!inv.voided
  });
}

/** 占用邀请卡的一个名额（带条件原子更新），名额用完返回 false */
async function takeUse(inv) {
  if (inv.uses === undefined) {
    // 旧版邀请卡没有名额字段：按默认名额补上
    await invites.where({ _id: inv._id, uses: _.exists(false) }).update({ data: { uses: 0, maxUses: INVITE_USES } });
  }
  const max = inv.maxUses || INVITE_USES;
  const res = await invites.where({ _id: inv._id, uses: _.lt(max) }).update({ data: { uses: _.inc(1) } });
  return res.stats.updated === 1;
}

async function acceptInvite(openid, token, displayName) {
  const dn = cleanName(displayName);
  const inv = await getInvite(token);
  if (!inv) return err('邀请不存在或已失效');
  // 本人接收的移交中途超时：再次打开移交卡续跑
  if (inv.type === 'transfer' && inv.used && inv.usedBy === openid && !inv.done && !inv.voided) return await resumeInvite(inv, openid);
  if (inv.voided) return err('该移交邀请已作废，请让对方重新发起');
  if (inv.used) return err('该邀请已被使用，请让对方重新邀请');
  if (inv.expiresAt < new Date()) return err('邀请已过期（7 天内有效），请让对方重新邀请');
  let acc;
  try { acc = (await accounts.doc(inv.aid).get()).data; } catch (e) { return err('主家信息已不存在'); }
  if (!trusted(acc)) return err('主家信息已不存在');

  if (inv.type === 'viewer' || inv.type === 'clerk') {
    const viewer = inv.type === 'viewer';
    // 记账人必须填写真实姓名（回执、小票、对账单上显示，便于主家辨认是谁确认 / 登记的）
    if (!viewer && !realName(dn)) return err('请填写记账人的真实姓名（2～12 个字）');
    if (acc.ownerOpenid === openid) return err(viewer ? '你就是这位主家，无需接受共享' : '你就是这位主家，无需加入');
    // 邀请卡可能被转发：发出邀请的人须仍是这位主家或其记账人（被移除的记账人发过的卡随之失效）
    if (inv.fromOpenid !== acc.ownerOpenid) {
      const still = await members.where({ aid: acc._id, memberOpenid: inv.fromOpenid, role: _.neq('viewer'), status: _.neq('pending') }).count();
      if (!still.total) return err(viewer ? '共享已失效，请让主家重新共享' : '邀请已失效，请让主家重新邀请');
    }
    const exist = (await members.where({ aid: acc._id, memberOpenid: openid, _openid: _.exists(false) }).limit(1).get()).data[0];
    if (exist && exist.status === 'pending') return ok({ type: inv.type, pending: true, aid: acc._id, accountName: acc.accountName });
    if (exist) {
      if (viewer && exist.role !== 'viewer') return err('你已经是这位主家的记账人，可直接查看');
      if (viewer) {
        // 已共享过：合并新共享的礼簿
        const ids = [...new Set((exist.bookIds || []).concat(inv.bookIds || []))];
        await members.doc(exist._id).update({ data: { bookIds: ids } });
      } else {
        // 已是记账人：合并新邀请的礼簿（任一张为全部礼簿则为全部）
        const upd = dn ? { displayName: dn } : {};
        if (inv.allBooks) upd.allBooks = true;
        else if (!exist.allBooks && inv.bookIds) upd.bookIds = [...new Set((exist.bookIds || []).concat(inv.bookIds))];
        if (inv.perms) upd.perms = [...new Set((cleanPerms(exist.perms) || DEFAULT_PERMS).concat(inv.perms))];
        if (Object.keys(upd).length) await members.doc(exist._id).update({ data: upd });
      }
      await setCurrent(openid, acc._id);
      return ok({ type: inv.type, aid: acc._id, accountName: acc.accountName });
    }
    // 新加入：占用一个名额，先记为待同意，主家同意后才能查看 / 记账
    if (!(await takeUse(inv))) return err('这张邀请卡的人数已满，请让对方重新邀请');
    await members.add({
      data: {
        aid: acc._id, ownerOpenid: acc.ownerOpenid, memberOpenid: openid, role: viewer ? 'viewer' : 'clerk',
        ...(viewer ? { bookIds: inv.bookIds || [] } : (inv.allBooks ? { allBooks: true, bookIds: [] } : { bookIds: inv.bookIds || [] })),
        ...(viewer ? {} : { perms: cleanPerms(inv.perms) || DEFAULT_PERMS.slice() }),
        displayName: dn, status: 'pending', inviteId: inv._id, inviteFrom: inv.fromName || '', createdAt: new Date()
      }
    });
    return ok({ type: inv.type, pending: true, aid: acc._id, accountName: acc.accountName });
  }

  // 移交主家
  const oldOwner = acc.ownerOpenid;
  if (oldOwner === openid) return err('你已经是这位主家');
  if (oldOwner !== inv.fromOpenid) return err('主家已变更，请重新发起移交');
  // 接收人已有自己的主家信息：合并到移交来的这份（礼簿码、台卡都在用它），见 mergeInto
  const mineAcc = (await accounts.where({ ownerOpenid: openid, _openid: _.exists(false) }).limit(1).get()).data[0] || null;

  // 先占用邀请（带条件原子更新），防止同一张移交卡被两人同时接收
  const claim = await invites.where({ _id: token, used: false })
    .update({ data: { used: true, usedBy: openid, usedAt: new Date() } });
  if (claim.stats.updated !== 1) return err('该邀请已被使用，请让对方重新邀请');
  if (inv.full === false) {
    const res = await transferBooks(inv, acc, openid);
    if (res.code === 0) await invites.doc(token).update({ data: { done: true } });
    return res;
  }

  // 整体移交：先原子地改主家信息归属（主家已变更则放弃并退回邀请），再迁移数据；
  // 迁移进度记在 transferPending，云函数超时中断后可续跑（resumeTransfer）
  const lock = await accounts.where({ _id: acc._id, ownerOpenid: oldOwner }).update({
    data: {
      ownerOpenid: openid, transferredFrom: oldOwner, transferredAt: new Date(), payCodeCheck: true,
      transferPending: { from: oldOwner, stayClerk: inv.stayClerk !== false, mergeFrom: mineAcc && mineAcc._id !== acc._id ? mineAcc._id : '', invite: token }
    }
  });
  if (lock.stats.updated !== 1) {
    await invites.doc(token).update({ data: { used: false, usedBy: _.remove(), usedAt: _.remove() } });
    return err('主家已变更，请重新发起移交');
  }
  await resumeTransfer({ ...acc, ownerOpenid: openid, transferPending: { from: oldOwner, stayClerk: inv.stayClerk !== false, mergeFrom: mineAcc && mineAcc._id !== acc._id ? mineAcc._id : '', invite: token } }, openid);
  return ok({ type: 'transfer', aid: acc._id, accountName: acc.accountName });
}

/** 续跑中断的移交（再次打开移交卡时） */
async function resumeInvite(inv, openid) {
  let acc;
  try { acc = (await accounts.doc(inv.aid).get()).data; } catch (e) { return err('主家信息已不存在'); }
  if (inv.full === false) {
    const res = await transferBooks(inv, acc, openid);
    if (res.code === 0) await invites.doc(inv._id).update({ data: { done: true } });
    return res;
  }
  if (acc.ownerOpenid !== openid) return err('主家已变更，请重新发起移交');
  if (acc.transferPending) await resumeTransfer(acc, openid);
  else await invites.doc(inv._id).update({ data: { done: true } });
  return ok({ type: 'transfer', aid: acc._id, accountName: acc.accountName });
}

/**
 * 整体移交的数据迁移（每一步都可重复执行）：礼簿、礼金、样式、导出登记、人员归到接收人，
 * 原主家按选择转为记账人，接收人原有的主家信息并入；全部完成后清除 transferPending
 */
async function resumeTransfer(acc, openid) {
  const tp = acc.transferPending;
  if (!tp) return;
  const oldOwner = tp.from;
  const moveAll = async (name, extra) => {
    for (let i = 0; i < 100; i++) {
      const res = await db.collection(name).where({ ownerOpenid: oldOwner, ...(extra || {}) })
        .update({ data: { ownerOpenid: openid } });
      if (!res.stats.updated) break;
    }
  };
  await moveAll('books');
  await moveAll('records'); // 送礼记录（gifts_out）属于个人人情往来，不移交
  await moveAll('print_templates');
  await moveAll('exports');
  await moveAll('members', { aid: acc._id });
  // 原主家转为记账人（发起时可选择不再记账）；接收人若原本是记账人则去掉记账身份
  await members.where({ aid: acc._id, memberOpenid: openid }).remove();
  if (tp.stayClerk !== false) {
    const exist = await members.where({ aid: acc._id, memberOpenid: oldOwner }).count();
    // 原主家熟悉全部礼簿：继续为对方记账时负责全部礼簿
    if (!exist.total) await members.add({ data: { aid: acc._id, ownerOpenid: openid, memberOpenid: oldOwner, role: 'clerk', allBooks: true, bookIds: [], createdAt: new Date() } });
  }
  // 移交过程中宾客新随的礼仍可能记在原主家名下：再补一轮
  await moveAll('records');
  if (tp.mergeFrom) {
    let from = null;
    try { from = (await accounts.doc(tp.mergeFrom).get()).data; } catch (e) { /* 已不存在 */ }
    if (from && !from.mergedInto) await mergeInto(from, acc, openid);
  }
  await setCurrent(openid, acc._id);
  await setCurrent(oldOwner, tp.stayClerk !== false ? acc._id : '');
  await accounts.doc(acc._id).update({ data: { transferPending: _.remove() } });
  if (tp.invite) await invites.doc(tp.invite).update({ data: { done: true } }).catch(() => {});
}

/** 主家：待同意的记账人 / 家人 */
async function pendingMembers(openid) {
  const ctx = await resolveCtx(db, openid);
  if (ctx.role !== 'owner') return ok({ list: [] });
  const ms = (await members.where({ aid: ctx.account._id, status: 'pending', _openid: _.exists(false) }).limit(100).get()).data;
  const users = {};
  if (ms.length) {
    (await db.collection('users').where({ openid: _.in(ms.map(m => m.memberOpenid)) }).field({ openid: true, nickname: true, avatar: true }).get())
      .data.forEach(u => { users[u.openid] = u; });
  }
  const bookIds = [...new Set(ms.flatMap(m => m.bookIds || []))];
  const names = {};
  if (bookIds.length) {
    (await db.collection('books').where({ _id: _.in(bookIds), ownerOpenid: ctx.ownerOpenid }).field({ name: true }).get())
      .data.forEach(b => { names[b._id] = b.name; });
  }
  return ok({
    list: ms.map(m => ({
      _id: m._id,
      role: m.role === 'viewer' ? 'viewer' : 'clerk',
      name: m.displayName || (users[m.memberOpenid] || {}).nickname || '微信用户',
      nickname: (users[m.memberOpenid] || {}).nickname || '',
      avatar: (users[m.memberOpenid] || {}).avatar || '',
      from: m.inviteFrom || '',
      books: (m.bookIds || []).map(id => names[id]).filter(Boolean),
      createdAt: m.createdAt
    }))
  });
}

/** 主家同意 / 拒绝加入申请 */
async function approveMember(openid, memberId, approve) {
  const ctx = await resolveCtx(db, openid);
  if (ctx.role !== 'owner') return err('只有主家本人可以处理');
  const m = (await members.where({ _id: String(memberId || ''), aid: ctx.account._id, status: 'pending' }).limit(1).get()).data[0];
  if (!m) return err('申请不存在或已处理');
  if (!approve) {
    await members.doc(m._id).remove();
    return ok({ approved: false });
  }
  await members.doc(m._id).update({ data: { status: 'active', approvedAt: new Date() } });
  // 对方还没有自己的主家信息时，直接切到这个身份
  const own = await accounts.where({ ownerOpenid: m.memberOpenid }).count();
  if (!own.total) await setCurrent(m.memberOpenid, ctx.account._id);
  return ok({ approved: true });
}

/**
 * 部分移交：只转所选礼簿（及其礼金、样式、存档 PDF），其余礼簿留在原主家
 * - 接收人没有主家信息时自动建一份（沿用称呼与收款码，并提醒换成自己的收款码）；已有则直接并入
 * - 移交的是原主家的当前礼簿时：原主家清空当前礼簿并把礼簿码转到接收人（forwardTo），
 *   宾客扫旧礼簿码随礼会记到接收人那里，直到原主家重新设置当前礼簿
 * - 发起时选了"继续记账"：原主家成为接收人的记账人
 */
async function transferBooks(inv, acc, openid) {
  const oldOwner = acc.ownerOpenid;
  // 中途超时续跑时，已转到接收人名下的礼簿也算在内（各步骤可重复执行）
  const ids = (await db.collection('books').where({ _id: _.in(inv.bookIds || []), ownerOpenid: _.in([oldOwner, openid]) }).field({ _id: true }).get())
    .data.map(b => b._id);
  if (!ids.length) return err('要移交的礼簿已不存在或已被移交');

  let mine = (await accounts.where({ ownerOpenid: openid, _openid: _.exists(false) }).limit(1).get()).data[0] || null;
  if (!mine) {
    // 机构把一场移交给主家时：优先沿用本场主家称呼与收款码（就是主家本人的，不用再提醒更换）
    const bk = (await db.collection('books').where({ _id: _.in(ids) }).field({ hostName: true, payCodeFileID: true }).get()).data;
    const host = bk.find(b => b.hostName) || {};
    const code = bk.find(b => b.payCodeFileID) || {};
    const data = {
      ownerOpenid: openid,
      accountName: host.hostName || acc.accountName,
      payCodeFileID: code.payCodeFileID || acc.payCodeFileID,
      payCodeCheck: !code.payCodeFileID,
      theme: acc.theme, payMode: acc.payMode || 'longpress',
      ...(Array.isArray(acc.quickAmounts) ? { quickAmounts: acc.quickAmounts } : {}),
      transferredFrom: oldOwner, createdAt: new Date(), updatedAt: new Date()
    };
    const added = await accounts.add({ data });
    mine = { _id: added._id, ...data };
  }

  const move = async (name, cond, data) => {
    for (let i = 0; i < 100; i++) {
      const res = await db.collection(name).where(cond).update({ data });
      if (!res.stats.updated) break;
    }
  };
  await move('books', { _id: _.in(ids), ownerOpenid: oldOwner }, { ownerOpenid: openid });
  await move('records', { bookId: _.in(ids), ownerOpenid: oldOwner }, { ownerOpenid: openid, aid: mine._id });
  // 存档 PDF 的登记行跟着礼簿走，之后由新主家管理、清理
  const archived = (await db.collection('books').where({ _id: _.in(ids) }).field({ archivePdf: true }).get())
    .data.map(b => b.archivePdf && b.archivePdf.fileID).filter(Boolean);
  if (archived.length) await move('exports', { ownerOpenid: oldOwner, fileID: _.in(archived) }, { ownerOpenid: openid });

  // 接收人的当前礼簿：还没有时设为移交来的（优先原主家的当前礼簿）
  const firstId = ids.includes(acc.activeBookId) ? acc.activeBookId : ids[0];
  if (!mine.activeBookId) await accounts.doc(mine._id).update({ data: { activeBookId: firstId } });
  // 原主家的当前礼簿被移交：旧礼簿码转到接收人
  if (ids.includes(acc.activeBookId)) {
    await accounts.doc(acc._id).update({ data: { activeBookId: '', forwardTo: mine._id } });
  }
  if (inv.stayClerk !== false) {
    // 部分移交：原主家负责移交过去的这几本礼簿
    const exist = (await members.where({ aid: mine._id, memberOpenid: oldOwner }).limit(1).get()).data[0];
    if (!exist) await members.add({ data: { aid: mine._id, ownerOpenid: openid, memberOpenid: oldOwner, role: 'clerk', bookIds: ids, createdAt: new Date() } });
    else if (!exist.allBooks) await members.doc(exist._id).update({ data: { bookIds: [...new Set((exist.bookIds || []).concat(ids))] } });
  }
  // 移交过程中宾客新随的礼：再补一轮
  await move('records', { bookId: _.in(ids), ownerOpenid: oldOwner }, { ownerOpenid: openid, aid: mine._id });
  await setCurrent(openid, mine._id);
  return ok({ type: 'transfer', aid: mine._id, accountName: mine.accountName, partial: true, count: ids.length });
}

/**
 * 合并主家信息：接收人原有的主家信息 from 并入移交来的 to
 * - 原有礼金记录、记账人改挂到 to（礼簿本来就按 ownerOpenid 归属，无需改）
 * - 收款码用接收人自己的（就是主家本人的，移交提醒随之解除）
 * - from 保留为别名（mergedInto），之前印出去的礼簿码扫了仍能随礼
 */
async function mergeInto(from, to, openid) {
  for (let i = 0; i < 100; i++) {
    const res = await db.collection('records').where({ aid: from._id }).update({ data: { aid: to._id } });
    if (!res.stats.updated) break;
  }
  const ms = (await members.where({ aid: from._id }).limit(100).get()).data;
  for (const m of ms) {
    const dup = await members.where({ aid: to._id, memberOpenid: m.memberOpenid }).count();
    if (dup.total || m.memberOpenid === openid) await members.doc(m._id).remove();
    else await members.doc(m._id).update({ data: { aid: to._id, ownerOpenid: openid } });
  }
  const data = { mergedFrom: from._id };
  if (from.payCodeFileID) Object.assign(data, { payCodeFileID: from.payCodeFileID, payCodeCheck: false, payCodeBy: '' });
  if (!Array.isArray(to.quickAmounts) && Array.isArray(from.quickAmounts)) data.quickAmounts = from.quickAmounts;
  await accounts.doc(to._id).update({ data });
  await accounts.doc(from._id).update({ data: { ownerOpenid: 'merged:' + openid, mergedInto: to._id, mergedAt: new Date() } });
}

/** 记账人列表（主家与记账人都可查看） */
async function listMembers(openid) {
  const ctx = await resolveCtx(db, openid);
  if (!ctx.account) return ok({ list: [], role: ctx.role });
  const ms = (await members.where({ aid: ctx.account._id }).limit(100).get()).data.filter(m => m.role !== 'viewer' && m.status !== 'pending');
  const ids = [ctx.account.ownerOpenid, ...ms.map(m => m.memberOpenid)];
  const users = (await db.collection('users').where({ openid: _.in(ids) }).field({ openid: true, nickname: true, avatar: true }).get()).data;
  const u = {};
  users.forEach(x => { u[x.openid] = x; });
  const ownerNick = (u[ctx.account.ownerOpenid] || {}).nickname || '';
  return ok({
    role: ctx.role,
    owner: {
      name: ctx.account.ownerHandlerName || ownerNick || '主家',
      nickname: ownerNick,
      avatar: (u[ctx.account.ownerOpenid] || {}).avatar || '',
      me: ctx.account.ownerOpenid === openid
    },
    canManage: can(ctx, 'members'),
    myPerms: ctx.perms || [],        // 自己拥有的权限（邀请 / 设置他人时只能授予这些）
    myAllBooks: !ctx.bookIds,        // 自己是否负责全部礼簿
    permNames: PERMS,
    list: ms.map(m => ({
      _id: m._id,
      name: m.displayName || (u[m.memberOpenid] || {}).nickname || '记账人', // 记账名称优先
      nickname: (u[m.memberOpenid] || {}).nickname || '',
      avatar: (u[m.memberOpenid] || {}).avatar || '',
      me: m.memberOpenid === openid,
      title: m.title || '',          // 机构版：岗位
      bookIds: m.bookIds || [],      // 负责的礼簿
      allBooks: !!m.allBooks,        // 全部礼簿（含以后新建的）
      perms: cleanPerms(m.perms) || (m.allBooks ? ALL_PERMS : DEFAULT_PERMS), // 授予的权限
      createdAt: m.createdAt
    }))
  });
}

/** 移除记账人 / 取消家人共享（主家或有「邀请与管理记账人」权限的记账人；记账人移除自己用 leave） */
async function removeMember(openid, memberId) {
  const ctx = await resolveCtx(db, openid);
  if (!ctx.account) return err('请先完善主家信息');
  if (!can(ctx, 'members')) return err('你没有管理记账人的权限');
  const res = await members.where({ _id: String(memberId || ''), aid: ctx.account._id }).remove();
  if (!res.stats.removed) return err('记账人不存在');
  return ok({ removed: 1 });
}

const cleanName = s => String(s || '').trim().slice(0, 12);
// 真实姓名：2～12 个字，不能是微信默认昵称
const realName = s => s.length >= 2 && !/^(微信用户|记账人|wx|用户)\d*$/i.test(s);

/**
 * 设置记账名称（回执、小票、对账单上显示，便于辨认是谁确认 / 登记的）
 * memberId 为空：设置自己的（主家写 accounts.ownerHandlerName，记账人写自己的 members.displayName）
 * memberId 不为空：改某位记账人的，本人或可管理人员的主家 / 记账人可改
 */
async function setHandlerName(openid, memberId, name) {
  const ctx = await resolveCtx(db, openid);
  if (!ctx.account) return err('请先完善主家信息');
  const n = cleanName(name);
  // 记账人的名称须为真实姓名（主家本人、家人不限）
  if (!memberId && ctx.role === 'clerk' && !realName(n)) return err('请填写记账人的真实姓名（2～12 个字）');
  if (!memberId) {
    if (ctx.role === 'owner') {
      await accounts.doc(ctx.account._id).update({ data: { ownerHandlerName: n } });
      return ok({ name: n });
    }
    if ((ctx.role === 'clerk' || ctx.role === 'viewer') && ctx.member) {
      await members.doc(ctx.member._id).update({ data: { displayName: n } });
      return ok({ name: n });
    }
    return err('无权修改');
  }
  const m = (await members.where({ _id: String(memberId), aid: ctx.account._id }).limit(1).get()).data[0];
  if (!m) return err('人员不存在');
  if (m.memberOpenid !== openid && !can(ctx, 'members')) return err('你没有管理记账人的权限');
  if (m.role !== 'viewer' && !realName(n)) return err('请填写记账人的真实姓名（2～12 个字）');
  await members.doc(m._id).update({ data: { displayName: n } });
  return ok({ name: n });
}

/** 机构模式开关与机构名称（「我的 → 收礼设置」单独设置，不必重新提交主家信息） */
async function setOrgMode(openid, on, orgName) {
  const ctx = await resolveCtx(db, openid);
  if (!ctx.account) return err('请先完善主家信息');
  if (ctx.role !== 'owner') return err('只有主家本人可以设置机构模式');
  if (on) {
    const plan = await P.planOf(db, ctx.ownerOpenid);
    if (!plan.features.org) return err('机构模式属于机构版功能，请联系我们开通');
  }
  const data = { orgMode: on, updatedAt: db.serverDate() };
  if (orgName !== undefined) data.orgName = String(orgName || '').trim().slice(0, 30);
  await accounts.doc(ctx.account._id).update({ data });
  return ok({ orgMode: on, orgName: data.orgName !== undefined ? data.orgName : (ctx.account.orgName || '') });
}

/** 外观设置：主题色（只有主家本人可改，记账人、家人看到的是主家选的颜色） */
async function setTheme(openid, primary) {
  const ctx = await resolveCtx(db, openid);
  if (ctx.role !== 'owner') return err('只有主家本人可以修改主题色');
  if (!/^#[0-9a-fA-F]{6}$/.test(String(primary || ''))) return err('颜色不正确');
  const theme = { ...(ctx.account.theme || { name: '默认主题', bg: '#F7F7F7' }), primary, chosen: true };
  await accounts.doc(ctx.account._id).update({ data: { theme: _.set(theme), updatedAt: db.serverDate() } });
  return ok({ account: safeAccount({ ...ctx.account, theme }, ctx) });
}

/** 礼簿共享：已共享的家人及其可查看的礼簿 */
async function listViewers(openid) {
  const ctx = await resolveCtx(db, openid);
  if (!ctx.account) return err('请先完善主家信息');
  if (!can(ctx, 'members')) return err('无权查看');
  const ms = (await members.where({ aid: ctx.account._id, role: 'viewer' }).limit(100).get()).data.filter(m => m.status !== 'pending');
  const users = {};
  if (ms.length) {
    (await db.collection('users').where({ openid: _.in(ms.map(m => m.memberOpenid)) }).field({ openid: true, nickname: true, avatar: true }).get())
      .data.forEach(u => { users[u.openid] = u; });
  }
  return ok({
    list: ms.map(m => ({
      _id: m._id,
      name: m.displayName || (users[m.memberOpenid] || {}).nickname || '家人',
      avatar: (users[m.memberOpenid] || {}).avatar || '',
      bookIds: m.bookIds || [],
      createdAt: m.createdAt
    }))
  });
}

/**
 * 设置记账人负责的礼簿（allBooks 为全部，含以后新建的）、权限（perms）与岗位（机构版）；家人共享只改共享的礼簿
 * 主家或有「邀请与管理记账人」权限的记账人可改，只能授予自己拥有的权限与礼簿，不能改自己
 */
async function memberUpdate(openid, memberId, title, bookIds, allBooks, perms) {
  const ctx = await resolveCtx(db, openid);
  if (!ctx.account) return err('请先完善主家信息');
  if (!can(ctx, 'members')) return err('你没有管理记账人的权限');
  const m = (await members.where({ _id: String(memberId || ''), aid: ctx.account._id }).limit(1).get()).data[0];
  if (!m) return err('人员不存在');
  if (m.memberOpenid === openid) return err('不能修改自己的权限');
  const data = {};
  if (title !== undefined) data.title = TITLES.includes(title) ? title : '';
  if (bookIds !== undefined || allBooks !== undefined) {
    if (m.role === 'viewer') {
      const want = (Array.isArray(bookIds) ? bookIds.slice(0, 100).map(String) : []).filter(id => !ctx.bookIds || ctx.bookIds.includes(id));
      data.bookIds = want.length
        ? (await db.collection('books').where({ _id: _.in(want), ownerOpenid: ctx.ownerOpenid }).field({ _id: true }).get()).data.map(b => b._id)
        : [];
    } else {
      // 未传 allBooks 时沿用旧约定：空列表为全部礼簿（机构版场次设置）
      const all = allBooks === true || (allBooks === undefined && !(Array.isArray(bookIds) && bookIds.length));
      const scope = await pickScope(ctx, bookIds, all, []);
      if (scope.error) return err(scope.error);
      data.allBooks = scope.allBooks;
      data.bookIds = scope.bookIds;
    }
  }
  if (perms !== undefined && m.role !== 'viewer') {
    const g = grantable(ctx, perms);
    if (g.error) return err(g.error);
    // 对方已有、而操作人自己没有的权限：操作人无权收回，原样保留
    const kept = (cleanPerms(m.perms) || (m.allBooks ? ALL_PERMS : DEFAULT_PERMS)).filter(k => !can(ctx, k));
    data.perms = ALL_PERMS.filter(k => g.perms.includes(k) || kept.includes(k));
  }
  await members.doc(m._id).update({ data });
  return ok({ _id: m._id, ...data });
}

/** 记账人退出某位主家 */
async function leave(openid, aid) {
  await members.where({ aid: String(aid || ''), memberOpenid: openid }).remove();
  await setCurrent(openid, '');
  return ok({ left: 1 });
}

/** 切换身份：自己的主家 / 某位主家的记账人 */
async function switchIdentity(openid, aid) {
  const list = await identities(openid);
  if (!list.some(x => x.aid === aid)) return err('无此身份');
  await setCurrent(openid, aid);
  return ok({ aid });
}

async function setCurrent(openid, aid) {
  await db.collection('users').where({ openid }).update({ data: { currentAid: aid } });
}

async function getInvite(token) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(token || ''))) return null;
  try {
    const d = (await invites.doc(token).get()).data;
    return trusted(d) ? d : null; // 客户端直接写库伪造的邀请无效
  } catch (e) { return null; }
}

const DEFAULT_QUICK = [200, 500, 600, 800, 1000, 1888];

/** 当前礼簿的公开信息（宾客随礼页显示） */
async function activeBook(a) {
  if (!a.activeBookId) return { name: (a.theme && a.theme.name) || '', type: 'other' };
  try {
    return publicBook((await db.collection('books').doc(a.activeBookId).get()).data);
  } catch (e) {
    return { name: (a.theme && a.theme.name) || '', type: 'other' };
  }
}

const publicBook = b => ({ _id: b._id, name: b.name, type: b.type, date: b.date || '', hostName: b.hostName || '' });


/**
 * 清除我的数据（注销）：删除主家的礼簿、礼金记录、送礼记录、模板、主家信息、用户信息与收款码图片
 * 导出 / 存档文件由前端先调用 export 云函数 purge 删除
 * 宾客在他人礼簿中的随礼记录属于对方礼簿档案，不在此删除
 */
async function purge(openid, confirm) {
  if (confirm !== 'DELETE') return err('参数错误');
  // 与管理员「数据清除」共用（tools/cloud-shared/purge.js）；用户自己注销时保留套餐开通记录
  const res = await Purge.run(db, cloud, openid, { ownPayCode });
  const removed = {};
  res.removed.forEach(r => { removed[r.label] = r.count; });
  return ok({ removed, files: res.files });
}

/** 付款方用：只返回公开字段 */
async function getByAid(aid) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(aid || ''))) return err('参数错误');
  let a = null;
  let fixed = null; // 「本场礼簿码」指定的礼簿
  try {
    a = (await accounts.doc(aid).get()).data;
    if (a.mergedInto) a = (await accounts.doc(a.mergedInto).get()).data; // 已合并：转到合并后的主家信息
    else if (a.forwardTo && !a.activeBookId) a = (await accounts.doc(a.forwardTo).get()).data; // 当前礼簿已移交
  } catch (e) {
    try {
      fixed = (await db.collection('books').doc(aid).get()).data;
      a = (await accounts.where({ ownerOpenid: fixed.ownerOpenid }).limit(1).get()).data[0] || null;
    } catch (e2) { /* 都不是 */ }
  }
  if (!a) return err('收款账户不存在');
  if (fixed && fixed.archived) return err('本场礼簿已结束');
  const book = fixed ? publicBook(fixed) : await activeBook(a);
  return ok({
    account: {
      _id: a._id,
      accountName: book.hostName || a.accountName, // 机构版：显示本场主家
      orgName: a.orgMode ? (a.orgName || '') : '',
      payMode: a.payMode || 'longpress',
      quickAmounts: Array.isArray(a.quickAmounts) ? a.quickAmounts : DEFAULT_QUICK, // 主家清空后为 []，不显示快捷金额
      book,
      theme: a.theme || { name: '默认主题', primary: '#C8161D' }
    }
  });
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
