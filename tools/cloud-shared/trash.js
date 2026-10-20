// trash.js — 礼簿回收站。源文件在 tools/cloud-shared/trash.js，由 tools/sync_shared.py 复制到 books、warmer 云函数目录，勿在云函数目录里直接修改。
//
// 主家删除已归档的礼簿：礼簿移到 trash_books（_id 不变），全部礼金记录从 records 移到 trash_records（_id 不变），
// 移出正常数据后，礼簿列表、对账、导出、人情往来、统计都不会再包含它们。
// 回收站保留 TRASH_DAYS 天：期间可恢复（原样放回，仍为已归档），也可手动彻底删除；到期由 warmer 定时永久删除（连同文件）。
// 移动是分批的：单次调用超过时间预算时返回 done=false，再调用一次接着移（trashStatus 记录进度：moving / restoring / done）。

const TRASH_DAYS = 15;
const BUDGET_MS = 12 * 1000; // 单次调用最多移动这么久（books 云函数超时 20 秒）
const ENVS = ['develop', 'trial', 'release'];

/** 把 from 集合里满足 cond 的文档原样（_id 不变）移到 to 集合；超时返回 false，移完返回 true */
async function moveDocs(db, from, to, cond, deadline) {
  const src = db.collection(from);
  const dst = db.collection(to);
  for (;;) {
    const rows = (await src.where(cond).limit(100).get()).data;
    if (!rows.length) return true;
    await Promise.all(rows.map(({ _id, ...doc }) => dst.doc(_id).set({ data: doc })));
    await src.where({ _id: db.command.in(rows.map(r => r._id)) }).remove();
    if (rows.length < 100) return true;
    if (Date.now() > deadline) return false;
  }
}

async function ensure(db, name) {
  try { await db.createCollection(name); } catch (e) { /* 已存在 */ }
}

/**
 * 删除（移入回收站）。book 为礼簿文档（首次调用）；续跑时 book 为 null，按 trash_books 里的进度继续
 * files：彻底删除时要一并删掉的文件（存档 PDF、本场收款码、各版本礼簿码）
 */
async function moveToTrash(db, owner, bookId, book, extra) {
  await ensure(db, 'trash_books');
  await ensure(db, 'trash_records');
  const deadline = Date.now() + BUDGET_MS;
  const tb = db.collection('trash_books');
  if (book) {
    const { _id, ...doc } = book;
    const now = new Date();
    await tb.doc(bookId).set({
      data: { ...doc, ...extra, trashStatus: 'moving', deletedAt: now, purgeAt: new Date(now.getTime() + TRASH_DAYS * 24 * 3600 * 1000) }
    });
    await db.collection('books').doc(bookId).remove();
  }
  const done = await moveDocs(db, 'records', 'trash_records', { ownerOpenid: owner, bookId }, deadline);
  if (done) await tb.doc(bookId).update({ data: { trashStatus: 'done' } });
  return done;
}

/** 恢复：礼簿放回 books（仍为已归档），礼金记录放回 records；全部放回后删掉回收站里的这本 */
async function restore(db, owner, bookId) {
  const deadline = Date.now() + BUDGET_MS;
  const tb = db.collection('trash_books');
  const t = (await tb.doc(bookId).get()).data;
  if (t.trashStatus === 'moving') return { error: '这本礼簿还在删除中，请稍后再试' };
  if (t.trashStatus !== 'restoring') {
    const { _id, trashStatus, deletedAt, purgeAt, files, count, sum, aid, ...doc } = t;
    await db.collection('books').doc(bookId).set({ data: { ...doc, archived: true } });
    await tb.doc(bookId).update({ data: { trashStatus: 'restoring' } });
  }
  const done = await moveDocs(db, 'trash_records', 'records', { ownerOpenid: owner, bookId }, deadline);
  if (done) await tb.doc(bookId).remove();
  return { done };
}

/** 永久删除回收站里的一本：文件、礼金记录、礼簿 */
async function purge(db, cloud, t) {
  const files = (t.files || []).filter(Boolean);
  for (let i = 0; i < files.length; i += 50) {
    try { await cloud.deleteFile({ fileList: files.slice(i, i + 50) }); } catch (e) { /* 忽略 */ }
  }
  for (let i = 0; i < 200; i++) {
    const r = await db.collection('trash_records').where({ ownerOpenid: t.ownerOpenid, bookId: t._id }).remove();
    if (!r.stats.removed) break;
  }
  if (t.archivePdf && t.archivePdf.fileID) {
    try { await db.collection('exports').where({ fileID: t.archivePdf.fileID }).remove(); } catch (e) { /* 忽略 */ }
  }
  await db.collection('trash_books').doc(t._id).remove();
}

/** 到期的永久删除（warmer 定时调用；每次最多 limit 本，没删完的下次继续） */
async function purgeExpired(db, cloud, limit) {
  let res;
  try {
    res = await db.collection('trash_books').where({ trashStatus: 'done', purgeAt: db.command.lt(new Date()), _openid: db.command.exists(false) }).limit(limit || 5).get();
  } catch (e) { return 0; } // 集合还不存在
  for (const t of res.data) await purge(db, cloud, t);
  return res.data.length;
}

/** 删除时登记的文件：存档 PDF、本人上传的本场收款码、各版本礼簿码 */
function filesOf(book, account, ownPayCode) {
  const files = [];
  if (book.archivePdf && book.archivePdf.fileID) files.push(book.archivePdf.fileID);
  if (ownPayCode(book.payCodeFileID, book.ownerOpenid)) files.push(book.payCodeFileID);
  const prefix = account && account.payCodeFileID ? account.payCodeFileID.split('/paycodes/')[0] : '';
  if (prefix) ENVS.forEach(env => files.push(`${prefix}/qrcodes/${book._id}-${env}.png`));
  return files;
}

module.exports = { TRASH_DAYS, moveToTrash, restore, purge, purgeExpired, filesOf };
