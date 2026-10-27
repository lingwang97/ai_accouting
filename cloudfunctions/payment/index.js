// 云函数 payment — 扫码付款与转账确认（文档 §6.3）
// 状态流转：pending(待转账) → transferred(付款方已转账，待收款方确认) → paid(收款方确认到账)
//          pending → cancelled(付款方取消，或超过 30 分钟未转账被自动取消，仍可补点「已转账」)；transferred → rejected(收款方未收到款)；paid → void(作废)
const cloud = require('wx-server-sdk');
const { ok, err, bjDay, bjTime } = require('./common.js');
const { REC, MEMBER, UNREJECT_MS, COUNTED } = require('./status.js');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const notify = require('./notify.js');
const P = require('./plans.js');
const { nameCheckMap } = require('./namecheck.js');
const { MAX_AMOUNT, MAX_MSG } = require('./limits.js'); // 单笔礼金上限（tools/cloud-shared/limits.js）
const { resolveCode, resolveCtx, handlerName, canBook, readonly, can, workBook, soloBook, trusted } = require('./ctx.js');
const accounts = db.collection('accounts');
const records = db.collection('records');

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
    await ensureCol('records');
    // 收款方操作：身份只解析一次；家人共享（只读）不能做任何收款方操作
    const OWNER_ACTIONS = ['cashEntry', 'confirm', 'confirmBatch', 'reject', 'unreject', 'dismissStall', 'void', 'amend', 'issueQr', 'resetToken', 'unclaim', 'qrCheck'];
    const ctx = OWNER_ACTIONS.includes(event.action) ? await resolveCtx(db, OPENID) : null;
    if (ctx && readonly(ctx)) return err('家人共享为只读，不能修改');
    // 记账人按权限：礼台记账 / 确认收礼 / 作废；amend（修改已入簿礼金）确认收礼或作废任一即可
    // issueQr（打印小票时取小程序码）：能打印小票的人都可以——「礼簿码与打印」（records.markPrinted 同一权限），或确认收礼 / 礼台记账后直接打印（v3.58.1）
    const NEED = { cashEntry: 'desk', confirm: 'confirm', confirmBatch: 'confirm', reject: 'confirm', unreject: 'confirm', dismissStall: 'confirm', void: 'void', amend: ['confirm', 'void'], issueQr: ['show', 'confirm', 'desk'], resetToken: 'members', unclaim: 'members', qrCheck: 'style' };
    if (ctx && ![].concat(NEED[event.action]).some(p => can(ctx, p))) {
      const label = { amend: '修改礼金', issueQr: '礼簿码与打印' }[event.action] || { desk: '礼台记账', confirm: '确认收礼', void: '作废', members: '管理', style: '修改回执与打印样式' }[NEED[event.action]];
      return err('你没有「' + label + '」权限');
    }
    switch (event.action) {
      // 付款方
      case 'create': return await create(OPENID, event);
      case 'cashEntry': return await cashEntry(OPENID, ctx, event);
      case 'transferred': return await transferred(OPENID, event.rid, event.envVersion);
      case 'cancel': return await payerUpdate(OPENID, event.rid, [{ status: REC.PENDING }], REC.CANCELLED);
      case 'status': return await status(OPENID, event.rid);
      case 'receipt': return await receipt(OPENID, event.rid, event.batch === true);
      case 'myReceipts': return await myReceipts(OPENID);
      // 小票二维码（v3.57.0）：宾客扫码查看回执 / 放入「我的随礼记录」
      case 'receiptByToken': return await receiptByToken(OPENID, event.token);
      case 'claimReceipt': return await claimReceipt(OPENID, event.token);
      // 小票二维码：打印时取链接（主家 / 记账人）；重置二维码、解除认领只有主家本人
      case 'issueQr': return await issueQr(ctx, String(event.rid || ''), event.envVersion);
      case 'resetToken': return await resetToken(ctx, String(event.rid || ''));
      case 'unclaim': return await unclaim(ctx, String(event.rid || ''));
      case 'qrCheck': return await qrCheck(event.envVersion, event.withRaster === true);
      // 收款方
      // 主家或其记账人（权限相同）
      // 批次录入的记录：确认 / 拒绝整批（amounts 为逐人实际金额 {rid: 金额}）
      // 宾客没点「我已完成转账」的（pending，或已被自动取消）主家核对到账后也可直接入簿
      case 'confirm': return await groupUpdate(ctx, event.rid, [REC.TRANSFERRED, REC.PENDING, REC.CANCELLED], REC.PAID, event.amount, event.amounts);
      case 'confirmBatch': return await confirmBatch(ctx, event.rids);
      case 'reject': return await groupUpdate(ctx, event.rid, [REC.TRANSFERRED, REC.PENDING], REC.REJECTED);
      // 撤销「未收到」：24 小时内回到标记前的状态
      case 'unreject': return await unreject(ctx, String(event.rid || ''));
      // 修改已入簿礼金（金额 / 姓名 / 关系 / 备注）
      case 'amend': return await amend(ctx, event);
      // 「宾客未点完成」里已被自动取消的：主家核对确实没收到，从这一栏移除（整批）
      case 'dismissStall': return await dismissStall(ctx, String(event.rid || ''));
      case 'void': return await ownerUpdate(ctx, event.rid, [REC.PAID], REC.VOID);
      default: return err('未知 action');
    }
  } catch (e) {
    console.error('payment', event.action, e);
    return err('操作失败，请稍后重试');
  }
};

/**
 * 付款方发起转账：创建待转账记录，返回收款码
 * 批次录入：items 为多位随礼人 [{name, amount, relation, remark}]，每人生成一条记录（batchId 关联），
 * 按合计金额转一笔账，状态整批推进；第一位（batchIdx=0）为扫码人本人
 */
async function create(openid, event) {
  if (!validId(String(event.aid || ''))) return err('参数错误');
  const aid = await resolveCode(db, String(event.aid)); // 礼簿短码还原为礼簿 id
  const multi = Array.isArray(event.items) && event.items.length > 1;
  const parsed = parseItems(Array.isArray(event.items) && event.items.length ? event.items
    : [{ name: event.payerName, amount: event.amount, relation: event.relation, remark: event.remark, tag: event.tag }], multi && event.payMethod === 'mixed');
  if (parsed.error) return err(parsed.error);
  const items = parsed.items;
  const totalFen = items.reduce((t, x) => t + Math.round(x.amount * 100), 0);
  if (totalFen > MAX_AMOUNT * 100) return err(MAX_MSG);

  let account = null;
  let fixed = null; // 「本场礼簿码」：aid 实际是礼簿 id，礼金记入这一场
  try {
    account = (await accounts.doc(aid).get()).data;
    if (account.mergedInto) account = (await accounts.doc(account.mergedInto).get()).data; // 主家信息已合并
    else if (account.forwardTo && !account.activeBookId) account = (await accounts.doc(account.forwardTo).get()).data; // 当前礼簿已移交
  } catch (e) {
    try {
      fixed = (await db.collection('books').doc(aid).get()).data;
      account = (await accounts.where({ ownerOpenid: fixed.ownerOpenid, _openid: _.exists(false) }).limit(1).get()).data[0] || null;
    } catch (e2) { /* 都不是 */ }
  }
  if (!account && (await inTrash(aid))) return err('本场礼簿已结束');
  // 只认云函数写入的主家信息与礼簿（客户端绕过云函数伪造的带 _openid，可能挂着别人的收款码）
  if (!trusted(account) || (fixed && !trusted(fixed))) return err('收款账户不存在');
  if (fixed && fixed.archived) return err('本场礼簿已结束');
  const accountId = account._id;

  // 防刷：同一付款人 1 分钟内最多发起 RATE_MAX 次（一个批次算一次）
  const now = new Date();
  const recent = await records.where({
    payerOpenid: openid,
    createdAt: _.gt(new Date(now.getTime() - 60 * 1000))
  }).field({ batchId: true }).limit(100).get();
  if (new Set(recent.data.map(r => r.batchId || r._id)).size >= RATE_MAX) return err('操作太频繁，请稍后再试');
  // 同名检查也计入频率：防止反复提交试探某人是否随过礼（按本次比对的姓名个数计）
  if (!(await sameNameQuota(openid, items.filter(x => !x.nameTag).length))) return err('操作太频繁，请稍后再试');

  // 同名提醒：主家礼簿里已有别的宾客用了同一个姓名（不是本人扫码登记的）时，请宾客填区分信息，方便主家辨认
  // 只返回需要填写的姓名，不透露对方任何信息
  // 本人之前在这位主家这里填过的区分信息直接沿用，不再重复询问
  const untagged = items.filter(x => !x.nameTag);
  if (untagged.length) {
    const mine = (await records.where({ ownerOpenid: account.ownerOpenid, payerOpenid: openid, payerName: _.in(untagged.map(x => x.payerName)), nameTag: _.exists(true) })
      .field({ payerName: true, nameTag: true, nameTagBy: true }).limit(100).get()).data;
    untagged.forEach(x => {
      const m = mine.find(r => r.payerName === x.payerName && r.nameTag);
      if (m) { x.nameTag = m.nameTag; x.nameTagBy = m.nameTagBy || 'host'; } // 沿用时保留来源（主家写的不印在小票上）
    });
  }
  items.forEach(x => { if (x.nameTag && !x.nameTagBy) x.nameTagBy = 'guest'; }); // 宾客自己填的区分信息（小票、回执上可印）
  // 只比对本次要记入的这一本礼簿（和下面 addItems 写入的 bookId 一致）：每场的宾客大多相同，跨礼簿同名不再要求填区分备注
  const book = fixed || await activeBookOf(account);
  const needTag = await sameNameOthers(account.ownerOpenid, openid, items.map((x, i) => ({ name: x.payerName, self: i === 0, tagged: !!x.nameTag })), book ? book._id : '');
  if (needTag.length) return ok({ needTag });


  const payDay = bjDay(now);
  // 支付方式：wechat 微信转账（默认）/ cash 现金 / mixed 转账+现金（批次：部分人转账、部分人给现金，按转账部分扫码转一笔）
  // 现金不经收款码，登记后直接等待主家确认收到；全是现金的 mixed 按现金处理，全是转账的按转账处理
  const split = splitFen(items);
  // 「转账+现金」只填了一人：按这一人选的方式
  const single = event.payMethod === 'mixed' && !multi && Array.isArray(event.items) && event.items[0] && event.items[0].method;
  let payMethod = event.payMethod === 'cash' || single === 'cash' ? 'cash' : (event.payMethod === 'mixed' && multi ? 'mixed' : 'wechat');
  if (payMethod === 'mixed' && !split.wechat) payMethod = 'cash';
  if (payMethod === 'mixed' && !split.cash) payMethod = 'wechat';
  if (payMethod !== 'mixed') items.forEach(x => { delete x.payMethod; });

  // 记入本场礼簿码指定的礼簿，否则记入当前礼簿（旧数据无礼簿时退回旧版主题名）
  const hostName = (book && book.hostName) || ''; // 机构版：本场主家
  const base = {
    aid: accountId,
    hostName,
    ownerOpenid: account.ownerOpenid,
    payerOpenid: openid,
    bookId: book ? book._id : '',
    bookType: book ? book.type : 'other',
    themeName: book ? book.name : ((account.theme && account.theme.name) || ''),
    payMethod: payMethod === 'mixed' ? 'wechat' : payMethod, // mixed 时每人的 payMethod 在 items 里
    ...(payMethod === 'mixed' ? { batchPay: 'mixed' } : {}),
    status: payMethod === 'cash' ? REC.TRANSFERRED : REC.PENDING,
    ...(payMethod === 'cash' ? { transferredAt: now } : {}),
    printed: false,
    payDay,
    createdAt: now
  };
  // 幂等：宾客端带 reqId 时，重复提交（弱网重试、连点）只记一条；键含主家与付款人。旧前端不传 reqId 时保持原行为
  const { ids, batchId, existed } = await addItems(base, items, reqKeyOf(account.ownerOpenid + ':' + openid, event.reqId));
  // 重复提交（弱网重试）：这些记录上一次已写入，状态可能已推进（已转账 / 已入簿 / 被拒），按库里真实状态返回，不能固定成 pending
  let realStatus = base.status;
  if (existed.every(Boolean)) {
    try {
      const sts = [];
      for (const id of ids) sts.push((await records.doc(id).get()).data.status);
      realStatus = sts.every(s => s === REC.PAID) ? REC.PAID : sts[0];
    } catch (e) { /* 读取失败按原状态返回 */ }
  }
  const record = {
    _id: ids[0], aid: accountId, batchId, payMethod, status: realStatus, payDay, createdAt: now,
    payerName: batchName(items), amount: totalFen / 100,
    transferAmount: (payMethod === 'cash' ? 0 : (payMethod === 'mixed' ? split.wechat : totalFen)) / 100, // 需扫码转账的金额
    cashAmount: (payMethod === 'cash' ? totalFen : (payMethod === 'mixed' ? split.cash : 0)) / 100,       // 交给礼台的现金

    remark: items.length > 1 ? '' : items[0].remark,
    relation: items.length > 1 ? '' : items[0].relation,
    items: items.map((x, i) => ({ _id: ids[i], name: x.payerName, amount: x.amount, method: x.payMethod || payMethod })),
    accountName: hostName || account.accountName
  };
  // 宾客自报现金：不推送（可被反复提交刷掉主家的订阅次数），主家与记账人在待确认里看到后当面清点
  if (payMethod === 'cash') return ok({ record });
  // 收款码图片由主家上传，云存储默认只有上传者可读：宾客端直接换链接会失败，
  // 这里用云函数（管理员权限）生成临时链接返回给宾客
  let payCodeUrl = '';
  try {
    // 机构版：本场单独设置了收款码时，宾客的钱直接转给本场主家
    const t = await cloud.getTempFileURL({ fileList: [{ fileID: (book && book.payCodeFileID) || account.payCodeFileID, maxAge: 2 * 3600 }] });
    const f = t.fileList && t.fileList[0];
    if (f && f.status === 0) payCodeUrl = f.tempFileURL;
  } catch (e) { console.warn('收款码临时链接生成失败', e.message); }

  return ok({
    record: {
      ...record,
      payMode: account.payMode || 'longpress',
      payCodeUrl // 只给临时链接，不给文件路径（路径里含主家的 openid）
    }
  });
}

/**
 * 同名检查的频率限制：每位宾客 10 分钟内最多比对 NAME_CHECK_MAX 个姓名
 * 计数存数据库（rate_limits，多实例、冷启动后仍有效）；返回「需要填区分信息」的请求不建记录，也计入
 */
const NAME_CHECK_MAX = 20;
async function sameNameQuota(openid, n) {
  if (!n) return true;
  const now = Date.now();
  const col = db.collection('rate_limits');
  const id = 'nc_' + openid;
  let list = [];
  try { list = ((await col.doc(id).get()).data.t || []).filter(t => now - t < 10 * 60 * 1000); } catch (e) { /* 首次 */ }
  if (list.length + n > NAME_CHECK_MAX) return false;
  list = list.concat(Array(n).fill(now));
  try {
    await col.doc(id).set({ data: { t: list, at: new Date() } });
  } catch (e) {
    try { await ensureCol('rate_limits'); await col.doc(id).set({ data: { t: list, at: new Date() } }); } catch (e2) { /* 计数失败不影响随礼 */ }
  }
  return true;
}

/**
 * 需要填区分信息的姓名：主家礼簿里已有同名、但不是"同一个人"的记录（任何状态，作废的除外）
 * 同一个人 = 同一个微信扫码登记、且同为本人（批次第 1 位 / 单人）或同为代登记的家人（批次第 2 位起）；
 * 礼台登记的、其他宾客的、本人代登记的同名家人，都算别人
 * people：[{ name, self（是否扫码人本人）, tagged（已填区分信息） }]；bookId：只看这一本礼簿（v3.50.0 起，不再跨礼簿）
 */
async function sameNameOthers(ownerOpenid, openid, people, bookId) {
  const todo = people.filter(p => !p.tagged);
  if (!todo.length) return [];
  // ownerOpenid 与 bookId 必须在同一个 where 里（连续 where 后一个会覆盖前一个）；没有礼簿时退回按主家全部礼簿
  const cond = { ownerOpenid, payerName: _.in(todo.map(p => p.name)), status: _.in(COUNTED.slice()) };
  if (bookId) cond.bookId = bookId;
  const res = await records.where(cond).field({ payerName: true, payerOpenid: true, batchIdx: true }).limit(500).get();
  const out = todo.filter(p => res.data.some(r => {
    if (r.payerName !== p.name) return false;
    const sameScanner = r.payerOpenid === openid;
    const rSelf = !(r.batchIdx > 0);
    return !(sameScanner && rSelf === p.self);
  })).map(p => p.name);
  return [...new Set(out)];
}

// 控制字符会被打印机当作指令（ESC/GS 等），宾客输入入库前一律剔除
const CTRL_RE = /[\x00-\x1f\x7f]/g;
function cleanText(v, n) { return String(v || '').replace(CTRL_RE, '').trim().slice(0, n); }

/**
 * 校验随礼人名单：1～BATCH_PEOPLE 人，姓名必填且不重复，每人金额 > 0
 * mixed=true（批次「转账+现金」）：每人各自的支付方式 p.method（wechat / cash）
 * 同名区分备注 p.tag 都接受；礼台记账另可用 personRef 指定为已有的某一位（见 cashEntry，宾客自助随礼不接受）
 */
function parseItems(raw, mixed, desk) {
  if (raw.length > BATCH_PEOPLE) return { error: `批次录入最多 ${BATCH_PEOPLE} 人` };
  const items = raw.map(p => ({
    payerName: cleanText(p && p.name, 20),
    amount: Math.round(Number(p && p.amount) * 100) / 100,
    relation: RELATIONS.includes(p && p.relation) ? p.relation : '',
    remark: cleanText(p && p.remark, 50),
    ...(mixed ? { payMethod: p && p.method === 'cash' ? 'cash' : 'wechat' } : {}),
    // 同名区分：区分备注（宾客扫码登记时同名会被要求填写；礼台记账时选择），指定为已有的某一位只限礼台记账
    ...(p && p.tag ? { nameTag: String(p.tag).replace(CTRL_RE, '').trim().replace(/[#:\s]/g, '').slice(0, 12) } : {}),

  }));
  for (const it of items) {
    if (!it.payerName) return { error: '请填写随礼人姓名' };
    if (!Number.isFinite(it.amount) || it.amount <= 0) return { error: `请填写${items.length > 1 ? ' ' + it.payerName + ' 的' : '正确'}金额` };
    if (it.amount > MAX_AMOUNT) return { error: MAX_MSG };
  }
  if (new Set(items.map(x => x.payerName + '#' + (x.nameTag || ''))).size !== items.length) return { error: '随礼人姓名有重复' };
  return { items };
}

/** 转账部分与现金部分的金额（分）；未标注支付方式的按转账 */
function splitFen(items) {
  const s = { wechat: 0, cash: 0 };
  items.forEach(x => { s[x.payMethod === 'cash' ? 'cash' : 'wechat'] += Math.round(x.amount * 100); });
  return s;
}

/** 按名单逐人建记录；多于 1 人时用 batchId 关联成一个批次 */
async function addItems(base, items, reqKey) {
  // reqKey：幂等键（礼台记账的 reqId）。记录 _id 由它确定，重试时同一条已存在则不重复写入（existed[i] 为 true）
  const batchId = items.length > 1 ? (reqKey ? 'B' + reqKey : 'B' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)) : '';
  const existed = items.map(() => false);
  const ids = await Promise.all(items.map(async (x, i) => {
    const data = { ...base, ...x, ...(batchId ? { batchId, batchIdx: i, batchSize: items.length } : {}) };
    if (!reqKey) return (await records.add({ data }))._id;
    const _id = 'q' + reqKey + String(i).padStart(2, '0');
    try {
      await records.add({ data: { _id, ...data } });
    } catch (e) {
      // 重复提交（重试 / 并发）：这条已写入则视为成功；否则是真的失败，原样抛出
      let d = null;
      try { d = (await records.doc(_id).get()).data; } catch (e2) { /* 不存在 */ }
      if (!d) throw e;
      existed[i] = true;
    }
    return _id;
  }));
  return { ids, batchId, existed };
}

/** 礼台记账幂等键：reqId 与主家绑定（不同主家的相同 reqId 互不影响），24 位十六进制 */
function reqKeyOf(ownerOpenid, reqId) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(reqId || ''))) return '';
  return require('crypto').createHash('md5').update(ownerOpenid + ':' + reqId).digest('hex').slice(0, 24);
}

/** 批次显示名：张三 等 3 人 */
const batchName = items => (items.length > 1 ? `${items[0].payerName} 等 ${items.length} 人` : items[0].payerName);

/** 同一批次的全部记录（按录入顺序） */
async function batchRecords(batchId, cond) {
  const res = await records.where({ batchId, ...cond }).limit(BATCH_PEOPLE * 2).get();
  return res.data.sort((a, b) => (a.batchIdx || 0) - (b.batchIdx || 0));
}

/** 主家当前礼簿（礼簿已删除或尚未建礼簿时为 null） */
async function activeBookOf(account) {
  if (!account.activeBookId) return null;
  try { return (await db.collection('books').doc(account.activeBookId).get()).data; } catch (e) { return null; }
}

/**
 * 主家 / 记账人在礼台直接登记现金：直接入簿（paid），无需宾客操作与确认
 * 没有宾客的微信身份（payerOpenid 为空），人情往来按姓名归并
 */
async function cashEntry(openid, ctx, event) {
  const account = ctx.account;
  if (!account) return err('请先完善主家信息');

  // 礼台记账：payMethod cash 现金（默认）/ wechat 宾客当面微信转账、礼台看到到账后登记 / mixed 批次转账+现金（每人各自 method）
  const multi = Array.isArray(event.items) && event.items.length > 1;
  let method = ['wechat', 'mixed'].includes(event.payMethod) ? event.payMethod : 'cash';
  // 「转账+现金」只填了一人：按这一人选的方式
  if (method === 'mixed' && !multi) method = event.items && event.items[0] && event.items[0].method === 'wechat' ? 'wechat' : 'cash';
  // 批次录入：items 为多位随礼人，每人一条记录（batchId 关联），每人各打一张小票
  const parsed = parseItems(Array.isArray(event.items) && event.items.length ? event.items
    : [{ name: event.payerName, amount: event.amount, relation: event.relation, remark: event.remark, tag: event.tag, personRef: event.personRef }], method === 'mixed', true);
  if (parsed.error) return err(parsed.error);
  const items = parsed.items;
  // 一次调用完成同名检查（v3.66.0，原先前端先调 records.nameCheck 再调 cashEntry）：
  // 传 nameCheck:true 时，礼簿里已有同名宾客就只返回名单（不入簿），前端选好是哪一位后不带 nameCheck 再提交；没有同名直接入簿
  // 同一 reqId 已入簿过（上次成功但前端没收到结果的重试）：跳过检查，下面按重复提交返回原记录
  if (event.nameCheck === true) {
    const key = reqKeyOf(ctx.ownerOpenid, event.reqId);
    let done = false;
    if (key) { try { done = !!(await records.doc('q' + key + '00').get()).data; } catch (e) { done = false; } }
    if (!done) {
      const map = await nameCheckMap(db, ctx, items.map(x => x.payerName), event.bookId);
      if (Object.keys(map).length) return ok({ needPick: true, map });
    }
  }
  // 同名区分：选了礼簿里已有的某一位（personRef 为那一位的某条记录 id），由服务端换成往来人 key（不把宾客 openid 交给前端）
  const raw = Array.isArray(event.items) && event.items.length ? event.items : [{ personRef: event.personRef }];
  for (let i = 0; i < items.length; i++) {
    const ref = String((raw[i] && raw[i].personRef) || '');
    if (validId(ref)) {
      const r = await getRecord(ref);
      // 只认负责范围内礼簿的记录（与 records.nameCheck 的范围一致，v3.59.1）
      if (r && r.ownerOpenid === ctx.ownerOpenid && canBook(ctx, r.bookId) && r.payerName === items[i].payerName) {
        items[i].personKey = r.personKey || (r.payerOpenid ? `o:${r.payerOpenid}:${String(r.payerName).replace(/[\s\u3000]/g, '')}` : '');
        if (!items[i].personKey) delete items[i].personKey;
        if (r.nameTag) { items[i].nameTag = r.nameTag; items[i].nameTagBy = r.nameTagBy || 'desk'; }
      }
    }
    if (items[i].nameTag && !items[i].nameTagBy) items[i].nameTagBy = 'desk';
  }
  if (items.reduce((t, x) => t + Math.round(x.amount * 100), 0) > MAX_AMOUNT * 100) return err(MAX_MSG);
  if (method === 'mixed') {
    const split = splitFen(items);
    if (!split.wechat) method = 'cash';
    else if (!split.cash) method = 'wechat';
    if (method !== 'mixed') items.forEach(x => { delete x.payMethod; });
  }

  let book = null;
  if (event.bookId) {
    try { book = (await db.collection('books').doc(String(event.bookId)).get()).data; } catch (e) { /* 不存在 */ }
    if (!book || book.ownerOpenid !== ctx.ownerOpenid) return err('礼簿不存在');
    if (book.archived) return err('该礼簿已归档');
  } else {
    // 未指定时记入正在记的礼簿：主家当前礼簿；只负责部分礼簿的取负责的那本，机构模式记账人取自己选的一场（见 ctx.workBook）
    const id = workBook(ctx);
    if (id === account.activeBookId) book = await activeBookOf(account);
    else {
      try { book = id ? (await db.collection('books').doc(id).get()).data : null; } catch (e) { book = null; }
      if (book && (book.ownerOpenid !== ctx.ownerOpenid || book.archived)) book = null;
    }
  }
  if (book && !canBook(ctx, book._id)) return err('请选择你负责的场次');
  // 没有可记的礼簿：不登记成无礼簿的记录（之后会被悄悄归进默认礼簿）
  if (!book) return err(ctx.role === 'clerk' ? '你负责的礼簿已结束，请联系主家重新安排' : '请先选择当前礼簿');
  const now = new Date();
  const base = {
    aid: account._id,
    hostName: (book && book.hostName) || '',
    ownerOpenid: ctx.ownerOpenid,
    payerOpenid: '',
    enteredBy: openid, // 主家或记账人代登记
    handlerOpenid: openid,
    handlerName: handlerName(ctx),
    bookId: book ? book._id : '',
    bookType: book ? book.type : 'other',
    themeName: book ? book.name : ((account.theme && account.theme.name) || ''),
    payMethod: method === 'wechat' ? 'wechat' : 'cash', // mixed 时每人的 payMethod 在 items 里
    ...(method === 'mixed' ? { batchPay: 'mixed' } : {}),
    deskEntry: true, // 礼台登记（不经宾客扫码）
    status: REC.PAID,
    printed: false,
    payDay: bjDay(now),
    createdAt: now,
    transferredAt: now,
    paidAt: now
  };
  const { ids, batchId, existed } = await addItems(base, items, reqKeyOf(ctx.ownerOpenid, event.reqId));
  if (existed.every(Boolean)) {
    // 重复提交：上一次已全部入簿，返回原记录，不再累加合计
    const docs = [];
    for (const id of ids) docs.push((await records.doc(id).get()).data);
    const olds = docs.map(shown);
    return ok({ record: olds[0], list: olds, duplicate: true });
  }
  const fen = items.reduce((t, x) => t + Math.round(x.amount * 100), 0);
  if (book) await incBookStat(book._id, items.length, fen, now);
  const list = items.map((x, i) => shown({
    _id: ids[i], ...base, ...x, ...(batchId ? { batchId, batchIdx: i, batchSize: items.length } : {})
  }));
  return ok({ record: list[0], list });
}

/** 礼簿份数与合计累加（只累加到已补算、且分界时间不晚于入簿时间的礼簿，见 books.backfillStats） */
async function incBookStat(bookId, count, fen, paidAt) {
  let cond = { _id: bookId, statReady: true };
  if (paidAt) cond = _.and([cond, _.or([{ statSince: _.lte(paidAt) }, { statSince: _.exists(false) }])]);
  try {
    await db.collection('books').where(cond).update({ data: { statCount: _.inc(count), statFen: _.inc(fen) } });
  } catch (e) {
    // 累加失败：标记为待补算，下次打开礼簿列表时按记录重新统计，避免合计长期对不上
    console.warn('礼簿合计更新失败', e.message);
    try { await db.collection('books').doc(bookId).update({ data: { statReady: false } }); } catch (e2) { /* 忽略 */ }
  }
}

/** 付款方已转账：pending（或超时被自动取消的）→ transferred，并通知收款方 */
async function transferred(openid, rid, envVersion) {
  const out = {};
  const res = await payerUpdate(openid, rid,
    [{ status: REC.PENDING }, { status: REC.CANCELLED, autoCancelled: true }], REC.TRANSFERRED, out);
  // 复用 payerUpdate 已读到的记录，不再重复读库（v3.60.3）
  if (res.code === 0 && res.data.changed) await notifyOwner(out.rec || rid, envVersion);
  return res;
}

/**
 * 付款方推进自己的记录状态。
 * 带状态条件原子更新，避免与收款方确认并发时互相覆盖。
 */
async function payerUpdate(openid, rid, fromConds, to, out) {
  if (!validId(rid)) return err('记录不存在');
  const cur = await getRecord(rid);
  if (!cur) return err('记录不存在');
  if (cur.payerOpenid !== openid) return err('无权操作');
  const data = { status: to };
  if (to === REC.TRANSFERRED) { data.transferredAt = new Date(); data.autoCancelled = _.remove(); }
  // 批次录入：同一批次一起推进
  const key = cur.batchId ? { batchId: cur.batchId } : { _id: rid };
  const res = await records.where(_.or(fromConds.map(c => ({ ...key, payerOpenid: openid, ...c }))))
    .update({ data });
  if (res.stats.updated >= 1) {
    // out.rec：更新后的记录快照（仅供云函数内部用，不返回前端）
    if (out) out.rec = { ...cur, ...data, status: to, autoCancelled: undefined };
    return ok({ status: to, changed: true });
  }

  // 未更新：已推进过（幂等返回当前状态）
  const rec = await getRecord(rid);
  return ok({ status: rec ? rec.status : cur.status, changed: false });
}

/**
 * 收件人名单缓存：同一礼簿（aid + bookId）在实例内存里缓存 60 秒，省掉每笔转账都查 members / accounts。
 * 代价：成员权限、负责礼簿变化最多延迟 60 秒生效（可接受）。
 */
const RECIPIENT_TTL = 60 * 1000;
const recipientCache = new Map();
async function recipientsOf(rec) {
  const key = `${rec.aid}|${rec.bookId || ''}`;
  const hit = recipientCache.get(key);
  if (hit && hit.exp > Date.now() && hit.owner === rec.ownerOpenid) return hit.to;
  // 主家和全部记账人都提醒（各自订阅过才会收到）
  let to = [rec.ownerOpenid];
  try {
    // members 与 accounts 并行查询
    const [ms, acc] = await Promise.all([
      db.collection('members').where({ aid: rec.aid }).limit(100).get(),
      accounts.doc(rec.aid).get().then(r => r.data, () => null)
    ]);
    // 家人共享、待主家同意、没有「确认收礼」权限的不提醒；只提醒负责这本礼簿的人（口径同 ctx.resolveCtx）
    to = to.concat(ms.data
      .filter(m => m.role !== 'viewer' && m.status !== MEMBER.PENDING && !m._openid)
      .filter(m => (Array.isArray(m.perms) ? m.perms.includes('confirm') : true))
      .filter(m => (acc && !acc.orgMode
        ? soloBook(m, acc) === rec.bookId
        : m.allBooks || (Array.isArray(m.bookIds) && m.bookIds.includes(rec.bookId))))
      .map(m => m.memberOpenid));
  } catch (e) { return to; /* 尚无记账人：不缓存，下次重查 */ }
  to = [...new Set(to)];
  if (recipientCache.size > 200) recipientCache.clear();
  recipientCache.set(key, { exp: Date.now() + RECIPIENT_TTL, owner: rec.ownerOpenid, to });
  return to;
}

/** 订阅消息提醒收款方（未配置模板或店主未订阅时静默跳过）。recOrId：已读到的记录（省一次读库）或记录 id */
async function notifyOwner(recOrId, envVersion) {
  if (!notify.TMPL_ID) return;
  const rec = typeof recOrId === 'object' && recOrId ? recOrId : await getRecord(recOrId);
  if (!rec) return;
  // 收件人名单与批次合计并行取
  const [to, all] = await Promise.all([
    recipientsOf(rec),
    rec.batchId ? batchRecords(rec.batchId, { ownerOpenid: rec.ownerOpenid }) : Promise.resolve(null)
  ]);
  let show = rec;
  if (all) {
    show = {
      ...rec,
      payerName: rec.payerName,
      amount: all.reduce((t, r) => t + Math.round(r.amount * 100), 0) / 100,
      remark: all.some(r => r.batchPay === 'mixed')
        ? `${all.length}人·转账${centStr(all.filter(r => r.payMethod !== 'cash'))}+现金${centStr(all.filter(r => r.payMethod === 'cash'))}`
        : `${all.length}人一起随礼`
    };
  }
  const data = notify.build(show, bjTime(rec.transferredAt || new Date()));
  await Promise.all(to.map(async touser => {
    let result;
    try {
      await cloud.openapi.subscribeMessage.send({
        touser,
        templateId: notify.TMPL_ID,
        page: 'pages/pending/pending', // 点通知直达待确认页
        miniprogramState: { develop: 'developer', trial: 'trial' }[envVersion] || 'formal',
        data
      });
      result = { ok: true, code: 0 };
    } catch (e) {
      // 43101=未订阅或次数用完；-604101=云函数无 subscribeMessage.send 权限；47003=模板参数不符
      console.warn('订阅消息发送失败', e.errCode, e.errMsg || e.message);
      result = { ok: false, code: e.errCode || -1, msg: String(e.errMsg || e.message || '').slice(0, 100) };
    }
    // 记下最近一次结果，「我的」页显示，便于排查收不到提醒
    try {
      await db.collection('users').where({ openid: touser }).update({ data: { lastNotify: { ...result, at: new Date() } } });
    } catch (e) { /* 忽略 */ }
  }));
}

/** 是否可查看该记录：宾客本人，或主家 / 其记账人 */
async function canView(openid, rec) {
  if (rec.payerOpenid === openid || (rec.claimedOpenid && rec.claimedOpenid === openid)) return true;
  return isStaff(openid, rec);
}

/** 主家本人或其负责该礼簿的记账人 / 家人共享（不含认领人） */
async function isStaff(openid, rec) {
  if (rec.ownerOpenid === openid) return true;
  const ctx = await resolveCtx(db, openid);
  return ctx.ownerOpenid === rec.ownerOpenid && canBook(ctx, rec.bookId);
}

/** 付款方轮询状态 */
async function status(openid, rid) {
  const rec = await getRecord(rid);
  if (!rec) return err('记录不存在');
  if (!(await canView(openid, rec))) return err('无权查看');
  return ok({
    status: rec.status,
    record: {
      _id: rec._id, payerName: rec.payerName, amount: rec.amount,
      remark: rec.remark, status: rec.status, createdAt: rec.createdAt, paidAt: rec.paidAt
    }
  });
}

/**
 * 宾客留存的电子回执：已入簿记录 + 该笔礼金所属礼簿的回执样式（宾客与主家均可查看）
 * 样式跟礼簿走，主家之后改了别的礼簿的样式，不影响这本礼簿的回执
 */
async function receipt(openid, rid, batch) {
  const rec = await getRecord(rid);
  if (!rec) return err('记录不存在');
  if (!(await canView(openid, rec))) return err('无权查看');
  if (rec.status !== REC.PAID) return err('主家确认收到后才能生成回执');
  // 合并批次回执（列出同批全部随礼人）：只给扫码登记这一批的宾客本人和主家 / 记账人；
  // 认领人只认领了自己那张小票，不能借 batch 看到同批其他人的姓名和金额（v3.58.1）
  const whole = batch && (rec.payerOpenid === openid || (await isStaff(openid, rec)));
  return ok(await receiptView(rec, whole));
}

/** 回执内容：记录（可合并批次）+ 主家称呼 + 该礼簿的回执样式 */
async function receiptView(rec, batch) {
  let out = receiptRecord(rec);
  // 批次录入：扫码人看到一张合并回执，列出全部随礼人
  if (batch && rec.batchId) {
    const paid = (await batchRecords(rec.batchId, { ownerOpenid: rec.ownerOpenid })).filter(r => r.status === REC.PAID);
    if (paid.length > 1) {
      out = {
        ...out,
        payerName: batchName(paid),
        amount: paid.reduce((t, r) => t + Math.round(r.amount * 100), 0) / 100,
        relation: '',
        remark: '',
        batchItems: paid.map(r => ({ name: r.payerName, amount: r.amount }))
      };
    }
  }
  let account = {};
  let book = null;
  try { account = (await accounts.doc(rec.aid).get()).data; } catch (e) { /* 主家已注销 */ }
  if (rec.bookId) {
    try { book = (await db.collection('books').doc(rec.bookId).get()).data; } catch (e) { /* 礼簿已删除 */ }
  }
  let tpl = (book && book.receiptTpl) || null; // 为空时前端按事由类型套用场景默认样式
  // v3.62.0 会员预留：套餐关闭 receiptStylePremium 后，已选的会员样式按「卡片」显示（不改库）
  if (tpl && P.RECEIPT_STYLES_PREMIUM.includes(tpl.style)) {
    let open = true;
    try { open = P.featureOpen((await P.planOf(db, rec.ownerOpenid)).features, 'receiptStylePremium'); } catch (e) { /* 读套餐失败：按开放处理 */ }
    if (!open) tpl = { ...tpl, style: 'card' };
  }
  return {
    record: out,
    accountName: rec.hostName || (book && book.hostName) || account.accountName || '',
    tpl
  };
}

/** 等待主家确认一栏只看最近 3 天（更早的多半已被主家处理或自动取消） */
const WAITING_DAYS = 3;

/**
 * 付款方的收据列表（最近 50 笔已到账）+ 等待主家确认的（v3.66.0）
 * waiting：只查 payerOpenid 为本人的记录（自己扫码登记的），状态为已转账待确认 / 还没点「我已完成转账」；
 * 批次合成一行；只返回姓名、金额、状态、主家称呼与时间，不含任何 openid 与内部字段
 */
async function myReceipts(openid) {
  // 本人扫码付款的 + 小票二维码认领的（礼台登记的）
  const [res, wres] = await Promise.all([
    records.where(_.and([{ status: REC.PAID }, _.or([{ payerOpenid: openid }, { claimedOpenid: openid }])]))
      .orderBy('paidAt', 'desc').limit(50).get(),
    records.where({
      payerOpenid: openid,
      status: _.in([REC.TRANSFERRED, REC.PENDING]),
      createdAt: _.gte(new Date(Date.now() - WAITING_DAYS * 86400000))
    }).orderBy('createdAt', 'desc').limit(50).get()
  ]);
  const waitRows = [];
  const byBatch = {};
  wres.data.forEach(r => {
    const g = r.batchId ? byBatch[r.batchId] : null;
    if (g) { g.names.push(r.payerName); g.fen += Math.round(r.amount * 100); return; }
    const row = { _id: r._id, aid: r.aid, hostName: r.hostName || '', status: r.status, names: [r.payerName], fen: Math.round(r.amount * 100), createdAt: r.createdAt, transferredAt: r.transferredAt || null };
    if (r.batchId) byBatch[r.batchId] = row;
    waitRows.push(row);
  });
  const aids = [...new Set(res.data.map(r => r.aid).concat(waitRows.map(r => r.aid)))];
  const names = {};
  if (aids.length) {
    const acc = await accounts.where({ _id: _.in(aids) }).field({ accountName: true }).get();
    acc.data.forEach(a => { names[a._id] = a.accountName; });
  }
  return ok({
    list: res.data.map(r => ({ ...receiptRecord(r), accountName: r.hostName || names[r.aid] || '' })),
    waiting: waitRows.slice(0, 20).map(w => ({
      _id: w._id, status: w.status,
      payerName: w.names.length > 1 ? `${w.names[0]} 等 ${w.names.length} 人` : w.names[0],
      amount: w.fen / 100,
      accountName: w.hostName || names[w.aid] || '',
      createdAt: w.createdAt, transferredAt: w.transferredAt
    }))
  });
}

/** 收据只暴露必要字段 */
const receiptRecord = r => ({
  _id: r._id, aid: r.aid, payerName: r.payerName, amount: r.amount, remark: r.remark,
  relation: r.relation || '',
  bookId: r.bookId || '', bookType: r.bookType || 'other', payMethod: r.payMethod || 'wechat',
  handlerName: r.handlerName || '', batchId: r.batchId || '', hostName: r.hostName || '',
  themeName: r.themeName, payDay: r.payDay, createdAt: r.createdAt, paidAt: r.paidAt
});

/**
 * 主家批量确认收到：单次最多 BATCH_MAX 笔（前端分批调用），每 5 笔并行，
 * 控制总耗时在云函数超时内；返回成功的记录供前端逐张打印
 */
const BATCH_MAX = 20;
async function confirmBatch(ctx, rids) {
  if (!Array.isArray(rids) || rids.length === 0 || rids.length > BATCH_MAX) return err('参数错误');
  const done = [];
  const failed = [];
  for (let i = 0; i < rids.length; i += 5) {
    const part = rids.slice(i, i + 5);
    const results = await Promise.all(part.map(rid =>
      ownerUpdate(ctx, String(rid), [REC.TRANSFERRED, REC.PENDING], REC.PAID).catch(e => ({ code: 1, msg: e.message }))));
    results.forEach((res, k) => {
      if (res.code === 0) done.push(res.data.record);
      else failed.push(part[k]);
    });
  }
  return ok({ list: done, failed });
}

/**
 * 确认 / 拒绝：批次录入的记录整批处理（逐人可按实际金额入簿），普通记录按单笔
 * amounts：{rid: 实际金额}，未列出的按宾客登记金额
 */
async function groupUpdate(ctx, rid, fromList, to, actualAmount, amounts) {
  const rec = await getRecord(rid);
  if (!rec || !rec.batchId) return ownerUpdate(ctx, rid, fromList, to, actualAmount, rec);
  if (rec.ownerOpenid !== ctx.ownerOpenid || !canBook(ctx, rec.bookId)) return err('无权操作该账目');
  if (notCurrentBook(ctx, rec)) return err(switchMsg(ctx));
  const all = (await batchRecords(rec.batchId, { ownerOpenid: ctx.ownerOpenid })).filter(r => fromList.includes(r.status) && (r.status !== REC.CANCELLED || r.autoCancelled));
  if (!all.length) return err('当前状态不可操作，请刷新');
  const map = (to === REC.PAID && amounts && typeof amounts === 'object') ? amounts : {};
  for (const r of all) {
    const v = map[r._id];
    if (v !== undefined && v !== null && !(Number(v) > 0 && Number(v) <= MAX_AMOUNT)) return err(`${r.payerName} 的实际金额不正确`);
  }
  const results = await Promise.all(all.map(r => ownerUpdate(ctx, r._id, fromList, to, map[r._id], r)
    .catch(e => ({ code: 1, msg: e.message }))));
  const list = results.filter(x => x.code === 0).map(x => x.data.record);
  if (!list.length) return err(results[0].msg);
  return ok({ rid, status: to, record: list[0], list, failed: all.length - list.length });
}

/** 确认 / 拒绝限定在当前礼簿（workBook）：待确认只显示当前礼簿，防止跨礼簿误确认；旧数据没有 bookId 的不限 */
function switchMsg(ctx) {
  return ctx.account && ctx.account.orgMode ? '请先切换到该场次' : '请先切换到该礼簿';
}
function notCurrentBook(ctx, rec) {
  return !!rec.bookId && rec.bookId !== workBook(ctx);
}

/** 礼簿码对应的礼簿已被删除（在回收站里） */
async function inTrash(id) {
  try { return !!(await db.collection('trash_books').doc(id).get()).data; } catch (e) { return false; }
}

/** 自动取消的记录标记为「主家已核对未收到」，不再出现在待确认的「宾客未点完成」里 */
async function dismissStall(ctx, rid) {
  if (readonly(ctx) || !can(ctx, 'confirm')) return err('你没有确认收礼的权限');
  const rec = await getRecord(rid);
  if (!rec || rec.ownerOpenid !== ctx.ownerOpenid || !canBook(ctx, rec.bookId)) return err('记录不存在');
  if (notCurrentBook(ctx, rec)) return err(switchMsg(ctx));
  const key = rec.batchId ? { batchId: rec.batchId } : { _id: rid };
  await records.where({ ...key, ownerOpenid: ctx.ownerOpenid, status: REC.CANCELLED, autoCancelled: true }).update({ data: { stallDismissed: true } });
  return ok({ dismissed: true });
}

/**
 * 收款方确认到账 / 拒绝 / 作废（带状态条件原子更新）
 * pre：调用方刚读过的这条记录（groupUpdate 已读），用于范围校验与原金额，省一次读库；状态以原子更新条件为准
 */
async function ownerUpdate(ctx, rid, fromList, to, actualAmount, pre) {
  if (!validId(rid)) return err('记录不存在');
  const openid = ctx.ownerOpenid; // 数据属于主家，记账人代为操作
  const hasAmt = to === REC.PAID && actualAmount !== undefined && actualAmount !== null;
  const r0 = (pre && pre._id === rid) ? pre : ((ctx.bookIds || to !== REC.VOID || hasAmt) ? await getRecord(rid) : null);
  if (ctx.bookIds && (!r0 || !canBook(ctx, r0.bookId))) return err('该礼金不在你负责的场次');
  // 确认 / 拒绝只能在当前礼簿内进行（作废已入簿的不限）
  if (r0 && to !== REC.VOID && notCurrentBook(ctx, r0)) return err(switchMsg(ctx));
  const data = { status: to };
  if (to === REC.PAID) {
    data.paidAt = new Date();
    // 记账人：实际确认这笔礼金的人（回执、小票上显示）
    data.handlerOpenid = (ctx.user && ctx.user.openid) || '';
    data.handlerName = handlerName(ctx);
  }
  // 主家按实际到账金额入簿：保留宾客原登记金额备查
  if (hasAmt) {
    const amt = Math.round(Number(actualAmount) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_AMOUNT) return err('实际金额不正确');
    const cur = r0;
    if (!cur || cur.ownerOpenid !== openid) return err('记录不存在');
    if (Math.round(cur.amount * 100) !== Math.round(amt * 100)) {
      data.amount = amt;
      data.declaredAmount = cur.amount;
    }
  }
  // 标记「未收到」：记下时间与标记前的状态，24 小时内可撤销（见 unreject）；限定为读到的当前状态，保证记下的状态准确
  if (to === REC.REJECTED) {
    data.rejectedAt = new Date();
    if (r0 && fromList.includes(r0.status)) { data.rejectedFrom = r0.status; fromList = [r0.status]; }
  }
  // 已取消的只有「自动取消」的可以操作（宾客自己取消的不行）
  const statusCond = fromList.includes(REC.CANCELLED)
    ? _.or([{ status: _.in(fromList.filter(s => s !== REC.CANCELLED)) }, { status: REC.CANCELLED, autoCancelled: true }])
    : { status: _.in(fromList) };
  if (to === REC.PAID) data.autoCancelled = _.remove();
  const res = await records.where(_.and([{ _id: rid, ownerOpenid: openid }, statusCond]))
    .update({ data });
  const rec = await getRecord(rid);
  if (!rec) return err('记录不存在');
  if (rec.ownerOpenid !== openid) return err('无权操作该账目');
  if (res.stats.updated !== 1) return err('当前状态不可操作，请刷新');
  // 礼簿份数与合计累加：入簿 +1，作废 -1（旧版创建的礼簿没有 statSince，照常累加）
  if (rec.bookId && (to === REC.PAID || to === REC.VOID)) {
    const sign = to === REC.PAID ? 1 : -1;
    await incBookStat(rec.bookId, sign, sign * Math.round(rec.amount * 100), to === REC.PAID ? rec.paidAt : null);
  }
  return ok({ rid, status: to, record: shown(rec) });
}


/**
 * 撤销「未收到」：24 小时内把 rejected 恢复为标记前的状态（rejectedFrom，缺省 transferred）
 * 批次整批撤销（与标记时整批一致）；只恢复标记时间在期限内的，没有 rejectedAt 的旧记录不可撤销
 * 与确认 / 标记同口径：只能在当前礼簿内进行；rejected 不计入礼簿合计，无需调整合计
 */
async function unreject(ctx, rid) {
  if (!validId(rid)) return err('记录不存在');
  const rec = await getRecord(rid);
  if (!rec || rec.ownerOpenid !== ctx.ownerOpenid || !canBook(ctx, rec.bookId)) return err('记录不存在');
  if (notCurrentBook(ctx, rec)) return err(switchMsg(ctx));
  const cut = new Date(Date.now() - UNREJECT_MS);
  const all = rec.batchId ? await batchRecords(rec.batchId, { ownerOpenid: ctx.ownerOpenid }) : [rec];
  const todo = all.filter(r => r.status === REC.REJECTED && r.rejectedAt && new Date(r.rejectedAt) > cut);
  if (!todo.length) {
    return err(all.some(r => r.status === REC.REJECTED) ? '已超过 24 小时，不能撤销' : '当前状态不可操作，请刷新');
  }
  let n = 0;
  await Promise.all(todo.map(async r => {
    const back = r.rejectedFrom === REC.PENDING ? REC.PENDING : REC.TRANSFERRED;
    // 带状态与时间条件的原子更新：并发撤销或期限刚过时不会误改
    const res = await records.where({ _id: r._id, ownerOpenid: ctx.ownerOpenid, status: REC.REJECTED, rejectedAt: _.gt(cut) })
      .update({ data: { status: back, rejectedAt: _.remove(), rejectedFrom: _.remove() } });
    n += res.stats.updated;
  }));
  if (!n) return err('当前状态不可操作，请刷新');
  return ok({ rid, restored: n });
}

const AMEND_KEYS = ['amount', 'payerName', 'relation', 'remark'];
const AMEND_LOG_MAX = 20;
const normName = s => String(s || '').replace(/[\s　]/g, '');

/**
 * 修改已入簿（paid）礼金：金额、姓名、关系、备注（录错了不必作废重录）
 * - 权限：确认收礼或作废任一；记账人限负责的场次；已归档礼簿不可改；家人共享只读（入口已拦）
 * - 乐观锁：按读到的版本（amendN）条件写入，并发修改只有一个成功；金额变化用差额增减礼簿合计（失败则置待补算由自愈接手）
 * - amendLog 记每次修改（最多 AMEND_LOG_MAX 条，含操作人显示名、改前改后）；已打印的小票不自动重打（printed 不动，可手动补打）
 * - 往来人：扫码宾客记录若没有固定的 personKey，改姓名前先固定为原来的 o:openid:原姓名，改名后仍是同一个人，只换显示名
 */
async function amend(ctx, event) {
  const rid = String(event.rid || '');
  if (!validId(rid)) return err('记录不存在');
  const rec = await getRecord(rid);
  if (!rec || rec.ownerOpenid !== ctx.ownerOpenid) return err('记录不存在');
  if (!canBook(ctx, rec.bookId)) return err('该礼金不在你负责的场次');
  if (rec.status !== REC.PAID) return err('只能修改已入簿的礼金');

  const next = {};
  if (event.amount !== undefined && event.amount !== null && event.amount !== '') {
    const amt = Math.round(Number(event.amount) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) return err('请填写正确的金额');
    if (amt > MAX_AMOUNT) return err(MAX_MSG);
    next.amount = amt;
  }
  if (event.payerName !== undefined) {
    const name = cleanText(event.payerName, 20);
    if (!name) return err('请填写随礼人姓名');
    next.payerName = name;
  }
  if (event.relation !== undefined) next.relation = RELATIONS.includes(event.relation) ? event.relation : '';
  if (event.remark !== undefined) next.remark = cleanText(event.remark, 50);

  const changes = {};
  AMEND_KEYS.forEach(k => {
    if (next[k] === undefined) return;
    const before = k === 'amount' ? rec.amount : (rec[k] || '');
    const same = k === 'amount' ? Math.round(before * 100) === Math.round(next[k] * 100) : before === next[k];
    if (!same) changes[k] = [before, next[k]];
  });
  if (!Object.keys(changes).length) return ok({ rid, changed: false, record: shown(rec) });

  if (rec.bookId) {
    let book = null;
    try { book = (await db.collection('books').doc(rec.bookId).get()).data; } catch (e) { /* 礼簿已删除：只改记录 */ }
    if (book && book.archived) return err('该礼簿已归档，不能修改');
  }

  const ver = Number(rec.amendN) || 0;
  const verCond = ver === 0 ? _.or([{ amendN: 0 }, { amendN: _.exists(false) }]) : { amendN: ver };
  const log = (Array.isArray(rec.amendLog) ? rec.amendLog : []).concat([{ at: new Date(), by: handlerName(ctx), changes }]).slice(-AMEND_LOG_MAX);
  const data = { amendN: ver + 1, amendedAt: new Date(), amendLog: log };
  Object.keys(changes).forEach(k => { data[k] = next[k]; });
  if (changes.payerName && rec.payerOpenid && !rec.personKey) {
    data.personKey = `o:${rec.payerOpenid}:${normName(rec.payerName)}`;
  }
  const res = await records.where(_.and([{ _id: rid, ownerOpenid: ctx.ownerOpenid, status: REC.PAID }, verCond])).update({ data });
  if (res.stats.updated !== 1) return err('这笔礼金刚被修改或状态已变，请刷新后重试');
  // 金额变化：礼簿合计加减差额（与入簿 / 作废同一个累加函数）
  if (changes.amount && rec.bookId) {
    await incBookStat(rec.bookId, 0, Math.round(next.amount * 100) - Math.round(rec.amount * 100), rec.paidAt);
  }
  const fresh = await getRecord(rid);
  return ok({ rid, changed: true, record: shown(fresh || { ...rec, ...next, amendLog: log }) });
}

async function getRecord(rid) {
  if (!validId(rid)) return null;
  try {
    return (await records.doc(rid).get()).data;
  } catch (e) {
    return null;
  }
}

const RATE_MAX = 3;
const BATCH_PEOPLE = 10; // 批次录入最多人数
const RELATIONS = ['亲戚', '朋友', '同事', '同学', '邻里', '其他'];


const centStr = rs => String(rs.reduce((t, r) => t + Math.round(r.amount * 100), 0) / 100);
const validId = s => /^[a-zA-Z0-9_-]{1,64}$/.test(String(s || ''));
/** 返回给主家 / 记账人前端的记录：去掉各方 openid 与往来人标识（含宾客 openid） */
const shown = ({ payerOpenid, handlerOpenid, enteredBy, ownerOpenid, personKey, rcptToken, rcptQrKey, rcptQrFileID, claimedOpenid, claimedAt, _openid, ...r }) => (claimedOpenid ? { ...r, claimed: true } : r);

// —— 小票二维码（v3.57.0 起；v3.58.0 改为小程序码）——
// token：12 位随机（base62），存 records.rcptToken，任何列表 / 详情接口都不返回；知道 token 的人（持有小票的人）可看这一笔回执。
// 小票上印的是小程序码（wxacode.getUnlimited，scene = 't=' + token，共 14 位，≤32 且字符合法），打开 pages/receipt/receipt。
// 小程序码永久有效、任何人都能扫（不像 URL Link 有 30 天限制和首位独占；URL Link 只开放给大陆非个人主体，个人主体报 85407，所以不用）。
// 先认先得：礼台登记的记录由第一位点「放入我的随礼记录」的人认领；主家可解除认领、重置二维码（换 token，旧码扫出来提示失效）。
// 云端把码图解码成 1 位光栅（GS v 0）再返回，按 token 缓存到云存储（records.rcptQrKey / rcptQrFileID），补打不重复生成。
const TOKEN_RE = /^[0-9A-Za-z]{12}$/;
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function newToken() {
  const crypto = require('crypto');
  let t = '';
  while (t.length < 12) {
    for (const b of crypto.randomBytes(24)) { if (b < 248 && t.length < 12) t += B62[b % 62]; } // 248 = 62*4，避免取模偏差
  }
  return t;
}
const ENVS = ['develop', 'trial', 'release'];
const RASTER_VER = 'w280v1'; // 光栅规格（宽 280 点、阈值 128）；改规格时换版本号，旧缓存自动失效
const toRaster = (...a) => require('./wxaraster.js').toRaster(...a); // 用到时才加载（pngjs / jpeg-js 只在云端装好后才有）

/** 通过 token 找记录（忽略客户端伪造的带 _openid 文档） */
async function recordByToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const rec = (await records.where({ rcptToken: String(token) }).limit(1).get()).data[0];
  return rec && trusted(rec) ? rec : null;
}

/** 打印小票前取二维码链接：记录没有 token 就条件写入一个（并发只有一个成功），已有则复用；生成链接失败返回空 url，不报错 */
async function issueQr(ctx, rid, envVersion) {
  const rec = await getRecord(rid);
  if (!rec || !trusted(rec) || rec.ownerOpenid !== ctx.ownerOpenid || !canBook(ctx, rec.bookId)) return err('无权操作该账目');
  if (rec.status !== REC.PAID) return err('入簿后才有二维码');
  let token = TOKEN_RE.test(String(rec.rcptToken || '')) ? rec.rcptToken : '';
  if (!token) {
    token = newToken();
    const res = await records.where({ _id: rid, rcptToken: _.exists(false) }).update({ data: { rcptToken: token } });
    if (!res.stats.updated) { // 别处刚写入：读回已有的
      token = ((await getRecord(rid)) || {}).rcptToken || '';
      if (!TOKEN_RE.test(String(token))) return err('二维码生成失败');
    }
  }
  // 缓存键带版本（v3.58.1）：体验版 / 开发版生成的码只能在对应版本打开，正式版补打不能复用体验版的码
  const env = ENVS.includes(envVersion) ? envVersion : 'release';
  const key = token + ':' + RASTER_VER + ':' + env;
  const oldFile = rec.rcptQrFileID || '';
  if (rec.rcptQrKey === key && rec.rcptQrFileID) { // 缓存命中：补打不重复生成
    try {
      const d = await cloud.downloadFile({ fileID: rec.rcptQrFileID });
      if (d.fileContent && d.fileContent.length > 100) return ok({ raster: Buffer.from(d.fileContent).toString('base64') });
    } catch (e) { /* 缓存丢失，重新生成 */ }
  }
  const code = await makeCode({ scene: 't=' + token, page: 'pages/receipt/receipt', envVersion: env });
  // reason 只放错误码 / 简短原因（不含 token、密钥），失败时便于在设置页「检测小程序码生成」或前端日志里定位
  if (!code.image) return ok({ raster: '', reason: code.reason });
  let r;
  try { r = toRaster(code.image); } catch (e) { return ok({ raster: '', reason: /^decode:/.test(e.message) ? e.message : 'decode:err' }); }
  try {
    const up = await cloud.uploadFile({ cloudPath: `rcptqr/${rid}-${token}-${env}.bin`, fileContent: r.bytes });
    await records.where({ _id: rid, rcptToken: token }).update({ data: { rcptQrKey: key, rcptQrFileID: up.fileID } });
    // 每条记录只缓存一份：换了版本 / 规格时删掉旧文件
    if (oldFile && oldFile !== up.fileID) { try { await cloud.deleteFile({ fileList: [oldFile] }); } catch (e2) { /* 删不掉不影响 */ } }
  } catch (e) { console.error('rcptqr cache failed', e && (e.errMsg || e.message)); } // 缓存失败不影响本次打印
  return ok({ raster: r.bytes.toString('base64') });
}

/** 取一个错误里的错误码（云调用 errCode / HTTP errcode），拼成简短原因 */
const codeOf = e => String((e && (e.errCode !== undefined ? e.errCode : e.code !== undefined ? e.code : e.errcode)) || 'err').slice(0, 20);

/**
 * 生成小程序码图片：先试云调用 cloud.openapi.wxacode.getUnlimited（需要 payment 云函数有 wxacode.getUnlimited 权限）；
 * 失败（命令行部署不一定应用 config.json 的权限）再请求 system 的内部 action `_wxaCode`（用 AppSecret 走 HTTPS 接口）。
 * 内部调用的身份证明：本函数先往 settings 集合写一条一次性凭据（集合客户端不可读写），system 核对并删除后才执行。
 * width 280 为官方最小值；纯黑白（auto_color=false、黑色线条、不透明底），热敏机二值化后最清晰；check_path=false：未发布 / 体验版也能生成。
 * 返回 { image: Buffer, via } 或 { reason }
 */
// 主通道缺权限（-604101：云函数没有 wxacode.getUnlimited 云调用权限，命令行部署常见）时实例内记住 10 分钟，
// 这期间直接走备用通道，不再每张小票白白多一次失败调用（v3.58.1）；设置页检测（force）始终两路都试
const OPENAPI_OFF_MS = 10 * 60 * 1000;
let openapiOff = null; // { code, until }
async function makeCode({ scene, page, envVersion, force }) {
  const env = ENVS.includes(envVersion) ? envVersion : 'release';
  let reason = '';
  if (!force && openapiOff && openapiOff.until > Date.now()) reason = 'openapi:' + openapiOff.code;
  else try {
    const r = await cloud.openapi.wxacode.getUnlimited({
      scene, page, width: 280, checkPath: false, envVersion: env,
      autoColor: false, lineColor: { r: 0, g: 0, b: 0 }, isHyaline: false
    });
    if (r && r.buffer && r.buffer.length > 100) { openapiOff = null; return { image: Buffer.from(r.buffer), via: 'openapi' }; }
    reason = 'openapi:' + (r && r.errCode ? r.errCode : 'empty');
  } catch (e) {
    reason = 'openapi:' + codeOf(e);
    if (codeOf(e) === '-604101') openapiOff = { code: '-604101', until: Date.now() + OPENAPI_OFF_MS };
    console.error('wxacode.getUnlimited failed', e && (e.errMsg || e.message));
  }
  const nonce = 'urlnonce_' + require('crypto').randomBytes(12).toString('hex');
  try {
    await ensureCol('settings');
    await db.collection('settings').doc(nonce).set({ data: { kind: 'urllink', createdAt: Date.now() } });
    const res = await cloud.callFunction({ name: 'system', data: { action: '_wxaCode', nonce, scene, page, envVersion: env } });
    const out = (res && res.result) || {};
    if (out.code === 0 && out.data && out.data.image) return { image: Buffer.from(out.data.image, 'base64'), via: 'system' };
    reason += ',system:' + String((out.data && out.data.reason) || out.msg || 'err').slice(0, 40);
  } catch (e) {
    reason += ',call:' + codeOf(e);
    console.error('system._wxaCode call failed', e && (e.errMsg || e.message));
  }
  try { await db.collection('settings').doc(nonce).remove(); } catch (e) { /* 已被 system 删除 */ }
  return { reason };
}

/** 设置页「检测小程序码生成 / 打印测试码」：生成指向首页的小程序码（scene test=1）；withRaster 时一并返回光栅供打印 */
async function qrCheck(envVersion, withRaster) {
  const code = await makeCode({ scene: 'test=1', page: 'pages/index/index', envVersion, force: true });
  if (!code.image) return ok({ ok: false, via: '', reason: code.reason });
  let r;
  try { r = toRaster(code.image); } catch (e) { return ok({ ok: false, via: code.via, reason: /^decode:/.test(e.message) ? e.message : 'decode:err' }); }
  return ok({ ok: true, via: code.via, reason: '', ...(withRaster ? { raster: r.bytes.toString('base64') } : {}) });
}

/** 主家重置二维码：换新 token，旧小票上的码立即失效；已认领关系不变 */
async function resetToken(ctx, rid) {
  if (ctx.role !== 'owner') return err('只有主家本人可以重置二维码');
  const rec = await getRecord(rid);
  if (!rec || !trusted(rec) || rec.ownerOpenid !== ctx.ownerOpenid) return err('记录不存在');
  await records.where({ _id: rid, ownerOpenid: ctx.ownerOpenid }).update({ data: { rcptToken: newToken(), rcptQrKey: '', rcptQrFileID: '' } });
  if (rec.rcptQrFileID) { try { await cloud.deleteFile({ fileList: [rec.rcptQrFileID] }); } catch (e) { /* 旧缓存文件删不掉不影响 */ } }
  return ok({});
}

/** 主家解除认领：那位微信用户的「我的随礼记录」里不再显示这一笔，其他人可重新认领 */
async function unclaim(ctx, rid) {
  if (ctx.role !== 'owner') return err('只有主家本人可以解除认领');
  const rec = await getRecord(rid);
  if (!rec || !trusted(rec) || rec.ownerOpenid !== ctx.ownerOpenid) return err('记录不存在');
  await records.where({ _id: rid, ownerOpenid: ctx.ownerOpenid }).update({ data: { claimedOpenid: '' } });
  return ok({});
}

/** 扫小票二维码：已登录即可，只返回这一笔的回执（不能枚举）。claim：mine 已在我的记录 / open 可认领 / taken 已被认领 / staff 主家或记账人 */
async function receiptByToken(openid, token) {
  const rec = await recordByToken(token);
  if (!rec) return err('二维码已失效');
  if (rec.status !== REC.PAID) return err('这笔礼金尚未入簿');
  const view = await receiptView(rec, false);
  const { aid, bookId, batchId, ...record } = view.record; // 不外露内部 id
  let claim = 'taken';
  if (rec.payerOpenid === openid || (rec.claimedOpenid && rec.claimedOpenid === openid)) claim = 'mine';
  else if (await isStaff(openid, rec)) claim = 'staff';
  else if (!rec.payerOpenid && !rec.claimedOpenid) claim = 'open';
  return ok({ ...view, record, claim });
}

/** 认领：仅当 payerOpenid 与 claimedOpenid 都为空（礼台登记、尚无人认领）才能认领，条件更新保证先到先得；不改 payerOpenid */
async function claimReceipt(openid, token) {
  const rec = await recordByToken(token);
  if (!rec) return err('二维码已失效');
  if (rec.status !== REC.PAID) return err('这笔礼金尚未入簿');
  if (rec.payerOpenid === openid || rec.claimedOpenid === openid) return ok({ claim: 'mine' });
  if (await isStaff(openid, rec)) return err('这是你自己的礼簿，不需要放入');
  const empty = k => _.or([{ [k]: '' }, { [k]: _.exists(false) }]);
  const res = await records.where(_.and([
    { _id: rec._id, rcptToken: String(token), status: REC.PAID },
    empty('payerOpenid'),
    empty('claimedOpenid')
  ])).update({ data: { claimedOpenid: openid, claimedAt: db.serverDate() } });
  if (res.stats.updated !== 1) return err('这笔记录已被认领');
  return ok({ claim: 'mine' });
}
