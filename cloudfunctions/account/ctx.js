// ctx.js — 身份解析（主家 / 记账人）。源文件在 tools/cloud-shared/ctx.js，
// 由 tools/sync_shared.py 复制到各云函数目录，勿在云函数目录里直接修改。
//
// 数据始终属于主家（ownerOpenid）。记账人通过邀请加入（members 集合），与主家权限相同，
// 只是"清除数据"和"人情往来"仍按本人身份处理。一个人可以同时是自己的主家、别人家的记账人，
// 当前身份记在 users.currentAid。
// 机构版：礼台人员可只负责部分场次（members.bookIds），各云函数用 canBook / restricted 校验。
// 礼簿共享：家人（members.role='viewer'）只能查看共享的礼簿（bookIds），不能做任何修改，用 readonly 校验。
// 通过邀请卡加入的人员先是待同意（members.status='pending'），主家同意后才生效。
//
// 安全：所有数据都由云函数写入，云函数写入的文档没有 _openid 字段；带 _openid 的是客户端绕过云函数直接写库伪造的，
// 一律忽略（集合权限另应设为「所有用户不可读写」）。

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
    // 机构版礼台人员：members.bookIds 非空时只负责这些场次（礼簿）；家人共享只能看共享的礼簿
    const viewer = m.role === 'viewer';
    let bookIds = Array.isArray(m.bookIds) && m.bookIds.length ? m.bookIds : null;
    if (viewer && !bookIds) bookIds = ['__none__'];
    return { role: viewer ? 'viewer' : 'clerk', ownerOpenid: acc.data.ownerOpenid, account: acc.data, user, member: m, bookIds };
  };

  const want = user && user.currentAid;
  if (want) {
    if (own && own._id === want) return { role: 'owner', ownerOpenid: openid, account: own, user, bookIds: null };
    const m = memberships.find(x => x.aid === want);
    if (m) {
      const c = await asClerk(m);
      if (c) return c;
    }
  }
  if (own) return { role: 'owner', ownerOpenid: openid, account: own, user, bookIds: null };
  for (const m of memberships) {
    const c = await asClerk(m);
    if (c) return c;
  }
  return { role: 'none', ownerOpenid: openid, account: null, user, bookIds: null };
}

/** 云函数写入的文档（不是客户端直接写库伪造的） */
function trusted(d) {
  return !!d && !d._openid;
}

/** 是否可操作该礼簿：只负责部分场次的礼台人员限于其负责的礼簿；bookIds 为 null 表示不限 */
function canBook(ctx, bookId) {
  return !ctx.bookIds || ctx.bookIds.includes(bookId);
}

/** 只负责部分场次的礼台人员 / 家人共享：不能管理主家信息、礼簿、人员 */
function restricted(ctx) {
  return !!ctx.bookIds;
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

module.exports = { resolveCtx, handlerName, canBook, restricted, readonly, trusted };
