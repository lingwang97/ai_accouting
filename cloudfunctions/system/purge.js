// purge.js — 清除账户数据（用户「清除数据」与管理员「数据清除」共用，保证删得一样干净）。
// 源文件在 tools/cloud-shared/purge.js，由 tools/sync_shared.py 复制到 account、system 云函数目录，勿在云函数目录里直接修改。
//
// 范围（openid 为被清除的用户）：
//   作为主家：主家信息（含合并别名）、礼簿、礼金记录、回收站里的礼簿与礼金记录、打印样式、导出 / 存档登记及文件、收款码与礼簿码图片、
//             记账人与家人共享关系、发出的邀请卡
//   本人数据：送礼记录、办事提醒、同名合并记录、作为记账人 / 家人的加入关系、用户信息
//   opts.subscription：套餐订阅（管理员清除时删，用户自己注销时保留开通记录）
//   opts.guestRecords：他作为宾客在别人礼簿里的随礼记录（属于对方礼簿，默认不删）
// 每类数据按条件反复删除直到删完，云函数中途超时后再执行一次即可继续。

const ENVS = ['develop', 'trial', 'release'];
const BATCH = 50; // cloud.deleteFile 单次最多 50 个文件

/** 要清除的各类数据：[名称, 集合, 条件] */
function targets(openid, opts) {
  const list = [
    ['礼金记录', 'records', { ownerOpenid: openid }],
    ['礼簿', 'books', { ownerOpenid: openid }],
    ['回收站礼金记录', 'trash_records', { ownerOpenid: openid }],
    ['回收站礼簿', 'trash_books', { ownerOpenid: openid }],
    ['送礼记录', 'gifts_out', { ownerOpenid: openid }],
    ['办事提醒', 'reminders', { ownerOpenid: openid }],
    ['打印样式', 'print_templates', { ownerOpenid: openid }],
    ['礼簿短码', 'book_codes', { ownerOpenid: openid }],
    ['同名合并', 'person_alias', { ownerOpenid: openid }],
    ['记账人 / 家人', 'members', { ownerOpenid: openid }],
    ['加入的主家', 'members', { memberOpenid: openid }],
    ['邀请卡', 'invites', { ownerOpenid: openid }],
    ['发出的邀请卡', 'invites', { fromOpenid: openid }],
    ['主家信息', 'accounts', { ownerOpenid: openid }],
    ['合并的主家信息', 'accounts', { ownerOpenid: 'merged:' + openid }],
    ['用户信息', 'users', { openid }]
  ];
  if (opts.guestRecords) list.unshift(['作为宾客的随礼', 'records', { payerOpenid: openid }]);
  return list;
}

const safeCount = async (db, col, cond) => {
  try { return (await db.collection(col).where(cond).count()).total; } catch (e) { return 0; }
};

/** 清除前预览：各类数据条数 + 文件数 */
async function preview(db, openid, opts = {}) {
  const rows = await Promise.all(targets(openid, opts).map(async ([label, col, cond]) => ({ label, count: await safeCount(db, col, cond) })));
  const exportsCount = await safeCount(db, 'exports', { ownerOpenid: openid });
  rows.push({ label: '导出 / 存档文件', count: exportsCount });
  if (opts.subscription) rows.push({ label: '套餐订阅', count: await safeCount(db, 'subscriptions', { _id: openid }) });
  return rows.filter(r => r.count > 0);
}

/** 本账户相关的图片文件：本人上传的收款码、礼簿码与本场礼簿码（固定路径，不存在的忽略） */
async function fileIds(db, openid, ownPayCode) {
  const files = [];
  const accs = (await db.collection('accounts').where({ ownerOpenid: openid }).limit(10).get()).data;
  const books = (await db.collection('books').where({ ownerOpenid: openid }).field({ _id: true, payCodeFileID: true, pendingPayCode: true }).limit(1000).get()).data;
  const prefix = (accs[0] && accs[0].payCodeFileID && accs[0].payCodeFileID.split('/paycodes/')[0]) || '';
  accs.forEach(a => {
    if (ownPayCode(a.payCodeFileID, openid)) files.push(a.payCodeFileID);
    if (a.pendingPayCode && a.pendingPayCode.fileID) files.push(a.pendingPayCode.fileID);
  });
  books.forEach(b => {
    if (ownPayCode(b.payCodeFileID, openid)) files.push(b.payCodeFileID);
    if (b.pendingPayCode && b.pendingPayCode.fileID) files.push(b.pendingPayCode.fileID);
  });
  // 礼簿码：qrcodes/{主家信息 id 或 礼簿 id}-{版本}.png
  if (prefix) {
    accs.map(a => a._id).concat(books.map(b => b._id)).forEach(id => {
      ENVS.forEach(env => files.push(`${prefix}/qrcodes/${id}-${env}.png`));
    });
  }
  // 回收站里的礼簿：删除时登记的文件（存档 PDF、本场收款码、礼簿码）
  try {
    (await db.collection('trash_books').where({ ownerOpenid: openid }).field({ files: true }).limit(1000).get()).data
      .forEach(t => (t.files || []).forEach(f => files.push(f)));
  } catch (e) { /* 集合不存在 */ }
  return [...new Set(files.filter(Boolean))];
}

async function deleteFiles(cloud, ids) {
  let n = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    try {
      const res = await cloud.deleteFile({ fileList: ids.slice(i, i + BATCH) });
      n += (res.fileList || []).filter(f => f.status === 0).length;
    } catch (e) { /* 文件已不存在等，忽略 */ }
  }
  return n;
}

/**
 * 执行清除，返回 { removed: [{label, count}], files }
 * ownPayCode(fileID, openid)：是否为该用户本人上传的收款码（移交来的收款码可能是原主家的文件，不删）
 */
async function run(db, cloud, openid, opts = {}) {
  const removeAll = async (col, cond) => {
    let total = 0;
    for (let i = 0; i < 200; i++) {
      let res;
      try { res = await db.collection(col).where(cond).remove(); } catch (e) { break; } // 集合不存在
      total += res.stats.removed;
      if (!res.stats.removed) break;
    }
    return total;
  };
  // 先删文件（需要读主家信息、礼簿里的文件 id）
  let files = await deleteFiles(cloud, await fileIds(db, openid, opts.ownPayCode || (() => false)));
  // 导出 / 存档文件及登记
  for (let i = 0; i < 100; i++) {
    let rows = [];
    try { rows = (await db.collection('exports').where({ ownerOpenid: openid }).limit(BATCH).get()).data; } catch (e) { break; }
    if (!rows.length) break;
    files += await deleteFiles(cloud, rows.filter(r => !r._openid).map(r => r.fileID));
    await db.collection('exports').where({ _id: db.command.in(rows.map(r => r._id)) }).remove();
    if (rows.length < BATCH) break;
  }
  const removed = [];
  for (const [label, col, cond] of targets(openid, opts)) {
    const count = await removeAll(col, cond);
    if (count) removed.push({ label, count });
  }
  if (opts.subscription) {
    const count = await removeAll('subscriptions', { _id: openid });
    if (count) removed.push({ label: '套餐订阅', count });
  }
  return { removed, files };
}

module.exports = { preview, run };
