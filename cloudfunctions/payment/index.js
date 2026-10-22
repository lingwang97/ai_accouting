// 云函数 payment — 扫码付款与转账确认（文档 §6.3）
// 状态流转：pending(待转账) → transferred(付款方已转账，待收款方确认) → paid(收款方确认到账)
//          pending → cancelled(付款方取消，或超过 30 分钟未转账被自动取消，仍可补点「已转账」)；transferred → rejected(收款方未收到款)；paid → void(作废)
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const notify = require('./notify.js');
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
    const OWNER_ACTIONS = ['cashEntry', 'confirm', 'confirmBatch', 'reject', 'dismissStall', 'void'];
    const ctx = OWNER_ACTIONS.includes(event.action) ? await resolveCtx(db, OPENID) : null;
    if (ctx && readonly(ctx)) return err('家人共享为只读，不能修改');
    // 记账人按权限：礼台记账 / 确认收礼 / 作废
    const NEED = { cashEntry: 'desk', confirm: 'confirm', confirmBatch: 'confirm', reject: 'confirm', dismissStall: 'confirm', void: 'void' };
    if (ctx && !can(ctx, NEED[event.action])) return err('你没有「' + { desk: '礼台记账', confirm: '确认收礼', void: '作废' }[NEED[event.action]] + '」权限');
    switch (event.action) {
      // 付款方
      case 'create': return await create(OPENID, event);
      case 'cashEntry': return await cashEntry(OPENID, ctx, event);
      case 'transferred': return await transferred(OPENID, event.rid, event.envVersion);
      case 'cancel': return await payerUpdate(OPENID, event.rid, [{ status: 'pending' }], 'cancelled');
      case 'status': return await status(OPENID, event.rid);
      case 'receipt': return await receipt(OPENID, event.rid, event.batch === true);
      case 'myReceipts': return await myReceipts(OPENID);
      // 收款方
      // 主家或其记账人（权限相同）
      // 批次录入的记录：确认 / 拒绝整批（amounts 为逐人实际金额 {rid: 金额}）
      // 宾客没点「我已完成转账」的（pending，或已被自动取消）主家核对到账后也可直接入簿
      case 'confirm': return await groupUpdate(ctx, event.rid, ['transferred', 'pending', 'cancelled'], 'paid', event.amount, event.amounts);
      case 'confirmBatch': return await confirmBatch(ctx, event.rids);
      case 'reject': return await groupUpdate(ctx, event.rid, ['transferred', 'pending'], 'rejected');
      // 「宾客未点完成」里已被自动取消的：主家核对确实没收到，从这一栏移除（整批）
      case 'dismissStall': return await dismissStall(ctx, String(event.rid || ''));
      case 'void': return await ownerUpdate(ctx, event.rid, ['paid'], 'void');
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
  const needTag = await sameNameOthers(account.ownerOpenid, openid, items.map((x, i) => ({ name: x.payerName, self: i === 0, tagged: !!x.nameTag })));
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
  const book = fixed || await activeBookOf(account);
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
    status: payMethod === 'cash' ? 'transferred' : 'pending',
    ...(payMethod === 'cash' ? { transferredAt: now } : {}),
    printed: false,
    payDay,
    createdAt: now
  };
  // 幂等：宾客端带 reqId 时，重复提交（弱网重试、连点）只记一条；键含主家与付款人。旧前端不传 reqId 时保持原行为
  const { ids, batchId } = await addItems(base, items, reqKeyOf(account.ownerOpenid + ':' + openid, event.reqId));
  const record = {
    _id: ids[0], aid: accountId, batchId, payMethod, status: base.status, payDay, createdAt: now,
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

/** 主家礼簿里，与这些姓名同名、但不是该宾客扫码登记的记录所用的姓名 */
/**
 * 需要填区分信息的姓名：主家礼簿里已有同名、但不是"同一个人"的记录（任何状态，作废的除外）
 * 同一个人 = 同一个微信扫码登记、且同为本人（批次第 1 位 / 单人）或同为代登记的家人（批次第 2 位起）；
 * 礼台登记的、其他宾客的、本人代登记的同名家人，都算别人
 * people：[{ name, self（是否扫码人本人）, tagged（已填区分信息） }]
 */
async function sameNameOthers(ownerOpenid, openid, people) {
  const todo = people.filter(p => !p.tagged);
  if (!todo.length) return [];
  const res = await records.where({
    ownerOpenid, payerName: _.in(todo.map(p => p.name)), status: _.in(['paid', 'transferred', 'pending'])
  }).field({ payerName: true, payerOpenid: true, batchIdx: true }).limit(500).get();
  const out = todo.filter(p => res.data.some(r => {
    if (r.payerName !== p.name) return false;
    const sameScanner = r.payerOpenid === openid;
    const rSelf = !(r.batchIdx > 0);
    return !(sameScanner && rSelf === p.self);
  })).map(p => p.name);
  return [...new Set(out)];
}

// 控制字符会被打印机当作指令（ESC/GS 等），宾客输入入库前一律剔除
const CTRL_RE = /[ -]/g;
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
  // 同名区分：选了礼簿里已有的某一位（personRef 为那一位的某条记录 id），由服务端换成往来人 key（不把宾客 openid 交给前端）
  const raw = Array.isArray(event.items) && event.items.length ? event.items : [{ personRef: event.personRef }];
  for (let i = 0; i < items.length; i++) {
    const ref = String((raw[i] && raw[i].personRef) || '');
    if (validId(ref)) {
      const r = await getRecord(ref);
      if (r && r.ownerOpenid === ctx.ownerOpenid && r.payerName === items[i].payerName) {
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
    status: 'paid',
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
  const res = await payerUpdate(openid, rid,
    [{ status: 'pending' }, { status: 'cancelled', autoCancelled: true }], 'transferred');
  if (res.code === 0 && res.data.changed) await notifyOwner(rid, envVersion);
  return res;
}

/**
 * 付款方推进自己的记录状态。
 * 带状态条件原子更新，避免与收款方确认并发时互相覆盖。
 */
async function payerUpdate(openid, rid, fromConds, to) {
  if (!validId(rid)) return err('记录不存在');
  const cur = await getRecord(rid);
  if (!cur) return err('记录不存在');
  if (cur.payerOpenid !== openid) return err('无权操作');
  const data = { status: to };
  if (to === 'transferred') { data.transferredAt = new Date(); data.autoCancelled = _.remove(); }
  // 批次录入：同一批次一起推进
  const key = cur.batchId ? { batchId: cur.batchId } : { _id: rid };
  const res = await records.where(_.or(fromConds.map(c => ({ ...key, payerOpenid: openid, ...c }))))
    .update({ data });
  if (res.stats.updated >= 1) return ok({ status: to, changed: true });

  // 未更新：已推进过（幂等返回当前状态）
  const rec = await getRecord(rid);
  return ok({ status: rec ? rec.status : cur.status, changed: false });
}

/** 订阅消息提醒收款方（未配置模板或店主未订阅时静默跳过） */
async function notifyOwner(rid, envVersion) {
  if (!notify.TMPL_ID) return;
  const rec = await getRecord(rid);
  if (!rec) return;
  // 主家和全部记账人都提醒（各自订阅过才会收到）
  let to = [rec.ownerOpenid];
  try {
    const ms = await db.collection('members').where({ aid: rec.aid }).limit(100).get();
    // 家人共享、待主家同意、没有「确认收礼」权限的不提醒；只提醒负责这本礼簿的人（口径同 ctx.resolveCtx）
    let acc = null;
    try { acc = (await accounts.doc(rec.aid).get()).data; } catch (e) { /* 忽略 */ }
    to = to.concat(ms.data
      .filter(m => m.role !== 'viewer' && m.status !== 'pending' && !m._openid)
      .filter(m => (Array.isArray(m.perms) ? m.perms.includes('confirm') : true))
      .filter(m => (acc && !acc.orgMode
        ? soloBook(m, acc) === rec.bookId
        : m.allBooks || (Array.isArray(m.bookIds) && m.bookIds.includes(rec.bookId))))
      .map(m => m.memberOpenid));
  } catch (e) { /* 尚无记账人 */ }
  let show = rec;
  if (rec.batchId) {
    const all = await batchRecords(rec.batchId, { ownerOpenid: rec.ownerOpenid });
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
  await Promise.all([...new Set(to)].map(async touser => {
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
  if (rec.payerOpenid === openid || rec.ownerOpenid === openid) return true;
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
  if (rec.status !== 'paid') return err('主家确认收到后才能生成回执');
  let out = receiptRecord(rec);
  // 批次录入：扫码人看到一张合并回执，列出全部随礼人
  if (batch && rec.batchId) {
    const paid = (await batchRecords(rec.batchId, { ownerOpenid: rec.ownerOpenid })).filter(r => r.status === 'paid');
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
  return ok({
    record: out,
    accountName: rec.hostName || (book && book.hostName) || account.accountName || '',
    tpl: (book && book.receiptTpl) || null // 为空时前端按事由类型套用场景默认样式
  });
}

/** 付款方的收据列表（最近 50 笔已到账） */
async function myReceipts(openid) {
  const res = await records.where({ payerOpenid: openid, status: 'paid' })
    .orderBy('paidAt', 'desc').limit(50).get();
  const aids = [...new Set(res.data.map(r => r.aid))];
  const names = {};
  if (aids.length) {
    const acc = await accounts.where({ _id: _.in(aids) }).field({ accountName: true }).get();
    acc.data.forEach(a => { names[a._id] = a.accountName; });
  }
  return ok({ list: res.data.map(r => ({ ...receiptRecord(r), accountName: r.hostName || names[r.aid] || '' })) });
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
      ownerUpdate(ctx, String(rid), ['transferred', 'pending'], 'paid').catch(e => ({ code: 1, msg: e.message }))));
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
  const all = (await batchRecords(rec.batchId, { ownerOpenid: ctx.ownerOpenid })).filter(r => fromList.includes(r.status) && (r.status !== 'cancelled' || r.autoCancelled));
  if (!all.length) return err('当前状态不可操作，请刷新');
  const map = (to === 'paid' && amounts && typeof amounts === 'object') ? amounts : {};
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
  await records.where({ ...key, ownerOpenid: ctx.ownerOpenid, status: 'cancelled', autoCancelled: true }).update({ data: { stallDismissed: true } });
  return ok({ dismissed: true });
}

/**
 * 收款方确认到账 / 拒绝 / 作废（带状态条件原子更新）
 * pre：调用方刚读过的这条记录（groupUpdate 已读），用于范围校验与原金额，省一次读库；状态以原子更新条件为准
 */
async function ownerUpdate(ctx, rid, fromList, to, actualAmount, pre) {
  if (!validId(rid)) return err('记录不存在');
  const openid = ctx.ownerOpenid; // 数据属于主家，记账人代为操作
  const hasAmt = to === 'paid' && actualAmount !== undefined && actualAmount !== null;
  const r0 = (pre && pre._id === rid) ? pre : ((ctx.bookIds || to !== 'void' || hasAmt) ? await getRecord(rid) : null);
  if (ctx.bookIds && (!r0 || !canBook(ctx, r0.bookId))) return err('该礼金不在你负责的场次');
  // 确认 / 拒绝只能在当前礼簿内进行（作废已入簿的不限）
  if (r0 && to !== 'void' && notCurrentBook(ctx, r0)) return err(switchMsg(ctx));
  const data = { status: to };
  if (to === 'paid') {
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
  // 已取消的只有「自动取消」的可以操作（宾客自己取消的不行）
  const statusCond = fromList.includes('cancelled')
    ? _.or([{ status: _.in(fromList.filter(s => s !== 'cancelled')) }, { status: 'cancelled', autoCancelled: true }])
    : { status: _.in(fromList) };
  if (to === 'paid') data.autoCancelled = _.remove();
  const res = await records.where(_.and([{ _id: rid, ownerOpenid: openid }, statusCond]))
    .update({ data });
  const rec = await getRecord(rid);
  if (!rec) return err('记录不存在');
  if (rec.ownerOpenid !== openid) return err('无权操作该账目');
  if (res.stats.updated !== 1) return err('当前状态不可操作，请刷新');
  // 礼簿份数与合计累加：入簿 +1，作废 -1（旧版创建的礼簿没有 statSince，照常累加）
  if (rec.bookId && (to === 'paid' || to === 'void')) {
    const sign = to === 'paid' ? 1 : -1;
    await incBookStat(rec.bookId, sign, sign * Math.round(rec.amount * 100), to === 'paid' ? rec.paidAt : null);
  }
  return ok({ rid, status: to, record: shown(rec) });
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

/** 云函数运行在 UTC，日期统一按北京时间（UTC+8） */
function bj(d) {
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return { day: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, hm: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}` };
}
const bjDay = d => bj(d).day;
const bjTime = d => { const b = bj(d); return `${b.day} ${b.hm}`; };

const centStr = rs => String(rs.reduce((t, r) => t + Math.round(r.amount * 100), 0) / 100);
const validId = s => /^[a-zA-Z0-9_-]{1,64}$/.test(String(s || ''));
/** 返回给主家 / 记账人前端的记录：去掉各方 openid 与往来人标识（含宾客 openid） */
const shown = ({ payerOpenid, handlerOpenid, enteredBy, ownerOpenid, personKey, _openid, ...r }) => r;
const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
