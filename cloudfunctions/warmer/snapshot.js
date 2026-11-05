// snapshot.js — 宾客随礼凭证快照（v3.85.0）。源文件在 tools/cloud-shared/snapshot.js，
// 由 tools/sync_shared.py 复制到 books、warmer、account、system 云函数目录，勿在云函数目录里直接修改。
//
// 背景：宾客的「我的随礼记录」是实时查主家礼簿里的记录（records），主家删除礼簿 / 注销后宾客什么都看不到，
// 主家等于能单方面销毁随礼凭证。所以主家删除礼簿（移入回收站）和主家自己注销 / 清除数据之前，先给每位「有身份」的宾客
// （扫码登记的 payerOpenid，或认领了小票二维码的 claimedOpenid）留一份凭证到 guest_receipts，保存在宾客自己名下：
//   - 触发点只有两处：trash.moveToTrash（删礼簿）与 purge.run（用户自己注销，opts.snapshot）；管理员清除不做快照（清除测试数据要能清干净）
//   - 内容最小化：主家称呼、礼簿名、日期、金额、状态、修改记录；不存记账人、收款码、备注、关系等主家内部信息
//   - 长期保留，直到宾客自己删除（payment.deleteVoucher）；用户自己删簿 / 注销、永久删除回收站都不删快照
//   - _id = 原记录 id，幂等：重复执行、续跑都安全
//   - 清除：管理员清除测试数据（system.wipeAll / adminPurgeBook / 清除用户）按 ownerOpenid 删；宾客自己清除全部数据时按 guestOpenid 删
//   - 回收站恢复：礼簿放回后以 records 为准，快照随即删除（dropBook），避免重复显示
// 不含任何 openid 给前端：guestOpenid / ownerOpenid 只在云端用于查询与清除。

const COL = 'guest_receipts';
const KEEP = ['paid', 'void', 'rejected']; // 只留有结果的：已入簿 / 已作废 / 主家未收到（含申诉记录）
const PAGE = 100;
const CONC = 8; // 快照并发写入数

function isMissing(e) {
  const code = String((e && (e.errCode !== undefined ? e.errCode : e.code)) || '');
  return code === '-502005' || /DATABASE_COLLECTION_NOT_EXIST|collection not exist|Db or Table not exist/i.test(String((e && (e.errMsg || e.message)) || ''));
}

/** 只留宾客时间线要用的日志字段（去掉操作人姓名等），并把旧版只写在 amendLog 里的金额 / 姓名修改补进来 */
function trailOf(r) {
  const keep = ['at', 'act', 'reason', 'note', 'why', 'kind', 'newAmount', 'newName', 'changes'];
  const trail = (Array.isArray(r.trail) ? r.trail : []).map(e => { const o = {}; keep.forEach(k => { if (e[k] !== undefined) o[k] = e[k]; }); return o; });
  if (!trail.some(e => e.act === 'amend')) {
    (Array.isArray(r.amendLog) ? r.amendLog : []).forEach(l => {
      const ch = {};
      if (l.changes && l.changes.amount) ch.amount = l.changes.amount;
      if (l.changes && l.changes.payerName) ch.payerName = l.changes.payerName;
      if (Object.keys(ch).length) trail.push({ at: l.at, act: 'amend', changes: ch });
    });
  }
  return trail;
}

function docOf(r, hostName, now) {
  const doc = {
    guestOpenid: r.payerOpenid || r.claimedOpenid, ownerOpenid: r.ownerOpenid,
    bookId: r.bookId || '', batchId: r.batchId || '', bookType: r.bookType || 'other',
    hostName, themeName: r.themeName || '', payerName: r.payerName || '', amount: r.amount, payMethod: r.payMethod || 'wechat',
    status: r.status, createdAt: r.createdAt || null, transferredAt: r.transferredAt || null, paidAt: r.paidAt || null,
    trail: trailOf(r), snapshotAt: now
  };
  if (r.voidedAt) doc.voidedAt = r.voidedAt;
  if (r.rejectedAt) doc.rejectedAt = r.rejectedAt;
  if (r.rejectReason) doc.rejectReason = r.rejectReason;
  if (r.rejectNote) doc.rejectNote = r.rejectNote;
  if (r.appealStatus) doc.appealStatus = r.appealStatus;
  if (r.appealReply) doc.appealReply = r.appealReply;
  return doc;
}

async function ensure(db) {
  try { await db.createCollection(COL); } catch (e) { /* 已存在 */ }
}

/**
 * 给 owner 名下满足 cond 的记录里「有宾客身份」的留凭证；已存在的跳过（幂等 / 续跑）。
 * 超过 deadline 返回 false（调用方稍后再调用一次接着做），做完返回 true
 */
async function snapshotRecords(db, owner, cond, deadline) {
  const _ = db.command;
  await ensure(db);
  const records = db.collection('records');
  const col = db.collection(COL);
  const names = {};
  const hostOf = async r => {
    if (r.hostName) return r.hostName;
    if (!r.aid) return '';
    if (names[r.aid] === undefined) {
      try { names[r.aid] = ((await db.collection('accounts').doc(r.aid).get()).data || {}).accountName || ''; } catch (e) { names[r.aid] = ''; }
    }
    return names[r.aid];
  };
  for (let skip = 0; ; skip += PAGE) {
    const rows = (await records.where({ ...cond, ownerOpenid: owner, status: _.in(KEEP) }).orderBy('_id', 'asc').skip(skip).limit(PAGE).get()).data;
    const mine = rows.filter(r => !r._openid && (r.payerOpenid || r.claimedOpenid));
    if (mine.length) {
      // 已有的凭证跳过；带 _openid 的是客户端伪造的占位文档（v3.86.10），不算已有，先删掉再写入真凭证
      const exist = (await col.where({ _id: _.in(mine.map(r => r._id)) }).field({ _id: true, _openid: true }).limit(PAGE).get()).data;
      const have = new Set(exist.filter(x => !x._openid).map(x => x._id));
      const forged = new Set(exist.filter(x => x._openid).map(x => x._id));
      const todo = mine.filter(r => !have.has(r._id));
      const now = new Date();
      for (let i = 0; i < todo.length; i += CONC) { // 每组 CONC 个并发写（v3.86.10 从 20 降到 8，减少对数据库 QPS 的冲击）
        await Promise.all(todo.slice(i, i + CONC).map(async r => {
          if (forged.has(r._id)) await col.doc(r._id).remove();
          return col.doc(r._id).set({ data: docOf(r, await hostOf(r), now) });
        }));
      }
    }
    if (rows.length < PAGE) return true;
    if (deadline && Date.now() > deadline) return false;
  }
}

/** 删除凭证（管理员清除测试数据 / 回收站恢复 / 宾客自己清除用）；集合不存在忽略，返回删除条数 */
async function dropWhere(db, cond) {
  let total = 0;
  for (let i = 0; i < 200; i++) {
    let res;
    try { res = await db.collection(COL).where(cond).remove(); } catch (e) { if (isMissing(e)) break; throw e; }
    total += res.stats.removed;
    if (!res.stats.removed) break;
  }
  return total;
}

module.exports = { COL, KEEP, CONC, snapshotRecords, dropWhere, trailOf };
