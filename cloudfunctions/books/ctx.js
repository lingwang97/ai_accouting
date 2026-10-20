// ctx.js — 身份解析（主家 / 记账人）。源文件在 tools/cloud-shared/ctx.js，
// 由 tools/sync_shared.py 复制到各云函数目录，勿在云函数目录里直接修改。
//
// 数据始终属于主家（ownerOpenid）。记账人通过邀请加入（members 集合），与主家权限相同，
// 只是"清除数据"和"人情往来"仍按本人身份处理。一个人可以同时是自己的主家、别人家的记账人，
// 当前身份记在 users.currentAid。
// 记账人 = 负责的礼簿（members.bookIds；allBooks=true 为全部礼簿，含以后新建的）+ 授予的权限（members.perms，见 PERMS）。
// 邀请时由主家（或有「邀请与管理记账人」权限的记账人）勾选，之后可在记账人页修改；各云函数用 canBook 校验礼簿、can 校验权限。
// 早期记账人没有 perms：allBooks 的给全部权限，其余给默认权限；也没有 bookIds 的迁移为主家当时的当前礼簿。
// 非机构模式：记账人同一时间只负责一本礼簿（members.soloBookId，邀请时单选、可在记账人页修改）；
// 没设过时按原负责范围取一本（含主家当前礼簿时取当前礼簿，全部礼簿的跟随主家当前礼簿）。bookIds / allBooks 原样保留，切回机构模式后恢复。
// 机构模式：负责多场的记账人可在工作台切换「我现在记哪一场」（members.curBookId，只影响自己），见 workBook。
// 礼簿共享：家人（members.role='viewer'）只能查看共享的礼簿（bookIds），不能做任何修改，用 readonly 校验。
// 通过邀请卡加入的人员先是待同意（members.status='pending'），主家同意后才生效。
//
// 安全：所有数据都由云函数写入，云函数写入的文档没有 _openid 字段；带 _openid 的是客户端绕过云函数直接写库伪造的，
// 一律忽略（集合权限另应设为「所有用户不可读写」）。

/**
 * 记账人权限项（主家本人始终拥有全部；家人共享只读，一项都没有）
 * 只属于主家本人、不能授予的：移交、机构模式、外观设置、同意加入申请、确认收款码、清除数据
 */
const PERMS = {
  confirm: '确认收礼',          // 待确认的确认收到 / 未收到、按实际金额入簿
  desk: '礼台记账',             // 现金 / 微信 / 转账+现金代登记
  show: '礼簿码与打印',         // 出示礼簿码、打印回执与小票
  export: '对账与导出',
  paycode: '申请更换收款码',    // 主家确认后才生效
  style: '回执与打印样式',
  members: '邀请与管理记账人',  // 只能授予自己拥有的权限与礼簿
  void: '作废已入簿礼金',
  books: '管理礼簿',            // 新建、编辑、切换当前礼簿、归档
  info: '修改主家信息'          // 称呼、快捷礼金
};
const ALL_PERMS = Object.keys(PERMS);
const DEFAULT_PERMS = ['confirm', 'desk', 'show', 'export', 'paycode', 'style', 'members'];
const cleanPerms = a => (Array.isArray(a) ? ALL_PERMS.filter(k => a.includes(k)) : null);

/**
 * 解析当前调用者在为哪位主家记账
 * @returns {Promise<{role:'owner'|'clerk'|'none', ownerOpenid:string, account:object|null, user:object|null}>}
 */
async function resolveCtx(db, openid) {
  const accounts = db.collection('accounts');
  const safe = async p => { try { return await p; } catch (e) { return null; } };

  const srv = { _openid: db.command.exists(false) };
  const [userRes, ownRes, memRes] = await Promise.all([
    safe(db.collection('users').where({ openid, ...srv }).limit(1).get()),
    safe(accounts.where({ ownerOpenid: openid, ...srv }).limit(1).get()),
    safe(db.collection('members').where({ memberOpenid: openid, ...srv }).limit(20).get())
  ]);
  const user = (userRes && userRes.data[0]) || null;
  const own = (ownRes && ownRes.data[0]) || null;
  const memberships = ((memRes && memRes.data) || []).filter(m => m.status !== 'pending');

  const asClerk = async m => {
    const acc = await safe(accounts.doc(m.aid).get());
    if (!acc || !trusted(acc.data)) return null;
    // 记账人只负责 bookIds 里的礼簿（allBooks 为全部）；家人共享只能看共享的礼簿
    const viewer = m.role === 'viewer';
    let bookIds = Array.isArray(m.bookIds) && m.bookIds.length ? m.bookIds : null;
    if (!viewer && !bookIds && !m.allBooks) {
      // 早期记账人：迁移为只负责主家当前礼簿
      bookIds = acc.data.activeBookId ? [acc.data.activeBookId] : ['__none__'];
      if (acc.data.activeBookId) await safe(db.collection('members').doc(m._id).update({ data: { bookIds } }));
    }
    if (!viewer && m.allBooks) bookIds = null;
    if (viewer && !bookIds) bookIds = ['__none__'];
    if (!viewer && !acc.data.orgMode) bookIds = [soloBook(m, acc.data)]; // 非机构模式：只负责一本
    const perms = viewer ? [] : (cleanPerms(m.perms) || (m.allBooks ? ALL_PERMS.slice() : DEFAULT_PERMS.slice()));
    // 机构模式：自己选的「现在记哪一场」（须仍在负责范围内）
    const cur = !viewer && acc.data.orgMode && m.curBookId && (!bookIds || bookIds.includes(m.curBookId)) ? m.curBookId : '';
    return { role: viewer ? 'viewer' : 'clerk', ownerOpenid: acc.data.ownerOpenid, account: acc.data, user, member: m, bookIds, perms, curBookId: cur };
  };

  const want = user && user.currentAid;
  if (want) {
    if (own && own._id === want) return { role: 'owner', ownerOpenid: openid, account: own, user, bookIds: null, perms: ALL_PERMS.slice() };
    const m = memberships.find(x => x.aid === want);
    if (m) {
      const c = await asClerk(m);
      if (c) return c;
    }
  }
  if (own) return { role: 'owner', ownerOpenid: openid, account: own, user, bookIds: null, perms: ALL_PERMS.slice() };
  for (const m of memberships) {
    const c = await asClerk(m);
    if (c) return c;
  }
  return { role: 'none', ownerOpenid: openid, account: null, user, bookIds: null, perms: [] };
}

/**
 * 非机构模式下记账人负责的那一本礼簿：设过的 soloBookId；否则原负责范围含主家当前礼簿时取当前礼簿，
 * 全部礼簿（或没有范围）的跟随主家当前礼簿，其余取第一本
 */
function soloBook(m, acc) {
  if (m.soloBookId) return m.soloBookId;
  const act = acc.activeBookId || '';
  const ids = Array.isArray(m.bookIds) ? m.bookIds : [];
  if (m.allBooks || !ids.length) return act || '__none__';
  return ids.includes(act) ? act : ids[0];
}

/**
 * 当前调用者正在记的礼簿（工作台、出示礼簿码、对账的默认礼簿）：
 * 机构模式记账人自己选的一场 → 主家当前礼簿（在负责范围内时）→ 负责的第一本
 */
function workBook(ctx) {
  if (!ctx.account) return '';
  if (ctx.curBookId) return ctx.curBookId;
  const act = ctx.account.activeBookId || '';
  if (act && canBook(ctx, act)) return act;
  return ctx.bookIds ? (ctx.bookIds.find(id => id !== '__none__') || '') : act;
}

/** 云函数写入的文档（不是客户端直接写库伪造的） */
function trusted(d) {
  return !!d && !d._openid;
}

/** 是否可操作该礼簿：只负责部分场次的礼台人员限于其负责的礼簿；bookIds 为 null 表示不限 */
function canBook(ctx, bookId) {
  return !ctx.bookIds || ctx.bookIds.includes(bookId);
}

/** 只负责部分礼簿（数据范围受限）：记账人未授权全部礼簿，或家人共享 */
function restricted(ctx) {
  return !!ctx.bookIds;
}

/** 是否拥有某项权限：主家本人全部拥有，家人共享一项都没有 */
function can(ctx, perm) {
  if (ctx.role === 'owner') return true;
  return ctx.role === 'clerk' && Array.isArray(ctx.perms) && ctx.perms.includes(perm);
}

/** 家人共享：只读，不能确认、登记、打印、编辑任何数据 */
function readonly(ctx) {
  return ctx.role === 'viewer';
}

/**
 * 操作人显示名（回执、小票、对账单上的"记账人"）：
 * 记账人用在该主家下设置的记账名称（members.displayName），主家用 accounts.ownerHandlerName，都没有时用微信昵称
 */
function handlerName(ctx) {
  if ((ctx.role === 'clerk' || ctx.role === 'viewer') && ctx.member && ctx.member.displayName) return ctx.member.displayName;
  if (ctx.role === 'owner' && ctx.account && ctx.account.ownerHandlerName) return ctx.account.ownerHandlerName;
  return (ctx.user && ctx.user.nickname) || '';
}

module.exports = { resolveCtx, handlerName, canBook, restricted, readonly, trusted, can, soloBook, workBook, PERMS, ALL_PERMS, DEFAULT_PERMS, cleanPerms };
