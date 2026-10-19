// 云函数 export — 慧礼记 礼簿导出 PDF / Excel / 传统礼簿 / 归档 / 备份 / 文件清理（文档 §6.7）
// 一、导出：{ format: 'pdf'|'xlsx'|'book', startDay?: 'YYYY-MM-DD', endDay?: 'YYYY-MM-DD', bookId?: string, themeName?: string, keep?: boolean }
//   - 传 bookId：校验礼簿归属，按礼簿导出；日期可选（同时传入则再按日期过滤，不传导出整本）
//   - 不传 bookId：日期必填，可选 themeName（礼簿名）过滤；format='book'（传统礼簿）必须传 bookId
//   - 普通导出上传到 exports/{OPENID}/，登记 exports 集合 kind='export' keep=false（前端下载后调 cleanup 删除）
//   - 归档：{ format:'book', bookId, keep:true } 上传到 archives/{OPENID}/，登记 kind='archive' keep=true，
//     并写入礼簿 archivePdf: { fileID, fileName, createdAt }；原有归档文件及其登记一并删除
//   出参：{ code:0, msg:'ok', data:{ fileID, fileName, count, sum } }
// 二、备份：{ format:'backup' } 全量导出一个 xlsx（礼簿汇总 / 礼金明细 / 送礼记录），登记 kind='backup' keep=false
//   出参：{ code:0, msg:'ok', data:{ fileID, fileName, count, sum } }（count/sum 为已入簿礼金）
// 三、清理单个文件：{ action:'cleanup', fileID } 仅删除本人 exports/ 下且 keep=false 的文件；已删除过也返回成功
//   出参：{ code:0, msg:'ok', data:{ deleted: 0|1 } }
// 四、清空本人全部文件：{ action:'purge' } 删除 exports 集合中登记的本人全部文件（含归档），用于删除数据前
//   出参：{ code:0, msg:'ok', data:{ deleted: n } }
// 五、定时触发器 cleanup（每天 3 点）：删除所有用户超过 24 小时且 keep=false 的文件
//   出参：{ code:0, msg:'ok', data:{ deleted: n } }
const cloud = require('wx-server-sdk');
const { resolveCtx, canBook, readonly, can } = require('./ctx.js');
// 按需加载：pdfkit / exceljs 体积大，只在对应格式时加载，缩短冷启动
let _pdfkit = null;
let _exceljs = null;
const PDF = () => (_pdfkit = _pdfkit || require('pdfkit'));
const XLSX = () => (_exceljs = _exceljs || require('exceljs'));

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 字体为 GB2312 子集，超出 GB2312 的生僻字无字形（已知限制）
// 中文字体（思源黑体 GB2312 子集 TrueType）以 JS 模块打包：线上运行时读不到随代码上传的 .ttf 文件，
// 作为代码 require 一定存在。字体以 Buffer 传给 pdfkit（默认字体也用它，不读 pdfkit 内置 Helvetica.afm）
let _fontBuf = null;
const fontBuf = () => (_fontBuf = _fontBuf || Buffer.from(require('./font-data.js'), 'base64'));
const MAX_ROWS = 10000; // 单次导出上限，超出时提示按日期分段导出（不静默截断）
const QUERY_MAX = 1000; // 云函数端单次查询上限
const BATCH = 50; // cloud.deleteFile 单次最多 50 个文件
const EXPIRE_MS = 24 * 3600 * 1000; // 未保留文件的有效期
const TYPE_LABEL = { wedding: '喜事', birthday: '寿宴', baby: '满月/周岁', house: '乔迁', funeral: '白事', other: '其他' };
const NO_BOOK = '未归入礼簿';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 配色：喜事用中国红，白事一律用灰色系（不出现任何红色元素）
const THEME = {
  red: { main: '#B71C1C', light: '#FDF3F3', argb: 'FFB71C1C' },
  grey: { main: '#555555', light: '#F5F5F5', argb: 'FF555555' }
};

exports.main = async (event) => {
  // 预热：warmer 云函数按「系统设置」定时唤醒，保持实例常驻、减少冷启动；直接返回，不做任何读写
  if (event && event.action === '__warm') return { code: 0, msg: 'warm', data: null };
  let stage = '初始化';
  event = event || {};
  try {
    await ensureCollection();
    // 定时触发器：清理过期的临时文件
    // 只认真正的定时触发：定时触发没有用户身份，用户调用无法冒充
    if (!cloud.getWXContext().OPENID && (event.Type === 'Timer' || event.TriggerName === 'cleanup')) {
      return ok({ deleted: await cleanupExpired() });
    }

    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return err('未获取到用户身份');
    // 清除数据只针对本人；其余按当前身份（记账人代主家导出，文件归主家）
    if (event.action === 'purge') return ok({ deleted: await purgeUser(OPENID) });
    const ctx = await resolveCtx(db, OPENID);
    const OWNER = ctx.ownerOpenid;
    if (event.action === 'cleanup') return await cleanupFile(OWNER, String(event.fileID || ''));
    // 记账人需有「对账与导出」权限（家人共享可导出共享的礼簿）
    if (ctx.role === 'clerk' && !can(ctx, 'export')) return err('你没有导出权限');
    // 送礼记录属于本人的人情往来：记账人备份主家数据时不含；只负责部分场次的人员不能全量备份
    if (event.format === 'backup' && ctx.bookIds) return err('你只负责部分场次，请按场次导出');
    if (event.format === 'backup') return await exportBackup(OWNER, ctx.role === 'owner');

    stage = '参数';
    const format = ['xlsx', 'book'].includes(event.format) ? event.format : 'pdf';
    const bookId = String(event.bookId || '');
    let startDay = String(event.startDay || '');
    let endDay = String(event.endDay || '');
    let themeName = '';
    let book = null;

    if (format === 'book' && !bookId) return err('传统礼簿请选择一本礼簿整本导出');
    // 仅传统礼簿支持归档保留；家人共享只读，不能生成存档
    const archive = format === 'book' && event.keep === true;
    if (archive && !can(ctx, 'books')) return err('生成存档需要「管理礼簿」权限');

    if (bookId) {
      // 按礼簿导出：先校验礼簿归属
      book = await getBook(bookId, OWNER);
      if (!book || !canBook(ctx, book._id)) return err('礼簿不存在');
      if (startDay || endDay) {
        if (!validRange(startDay, endDay)) return err('日期范围不正确');
      }
    } else {
      if (ctx.bookIds) return err('你只负责部分场次，请选择一本礼簿导出');
      if (!validRange(startDay, endDay)) return err('日期范围不正确');
      themeName = String(event.themeName || '').slice(0, 20);
    }

    const account = (await db.collection('accounts').where({ ownerOpenid: OWNER }).limit(1).get()).data[0];
    if (!account) return err('请先绑定收款账户');

    stage = '读取礼金';
    const rows = await fetchRows(OWNER, { bookId, startDay, endDay, themeName });
    if (rows.tooMany) return err(`礼金超过 ${MAX_ROWS} 笔，请按日期范围分段导出`);
    if (rows.length === 0) return err('该范围内没有已入簿的礼金');

    const meta = buildMeta(rows, { account, book, startDay, endDay, themeName });

    let buffer;
    stage = '生成文件';
    if (format === 'xlsx') buffer = await buildXlsx(rows, meta);
    else if (format === 'book') buffer = await buildBook(rows, meta);
    else buffer = await buildPdf(rows, meta);

    const ext = format === 'xlsx' ? 'xlsx' : 'pdf';
    const base = book ? book.name : (themeName ? `${themeName}_${startDay}_${endDay}` : `${startDay}_${endDay}`);
    const fileName = `礼簿_${sanitizeName(base)}.${ext}`;
    const cloudPath = archive
      ? `archives/${OWNER}/${bookId}-${Date.now()}.pdf`
      : `exports/${OWNER}/${Date.now()}.${ext}`;
    stage = '上传';
    const up = await cloud.uploadFile({ cloudPath, fileContent: buffer });
    stage = '记录';
    await track(OWNER, up.fileID, archive, archive ? 'archive' : 'export');
    if (archive) await saveArchive(OWNER, book, bookId, up.fileID, fileName);
    return ok({ fileID: up.fileID, fileName, count: meta.count, sum: meta.sum });
  } catch (e) {
    // 详细堆栈只写日志（含服务器文件路径），前端只提示阶段
    console.error('export failed', stage, e && e.stack);
    return err(`导出失败（${stage}），请稍后重试`);
  }
};

// —— 文件登记与清理 ——
let collectionReady = false;

/** 确保 exports 集合存在（每个容器只尝试一次；集合已存在时 createCollection 会抛错，忽略即可） */
async function ensureCollection() {
  if (collectionReady) return;
  try {
    await db.createCollection('exports');
  } catch (e) {
    // 集合已存在
  }
  collectionReady = true;
}

/** 登记生成的文件 */
function track(openid, fileID, keep, kind) {
  return db.collection('exports').add({
    data: { ownerOpenid: openid, fileID, keep: !!keep, kind, createdAt: new Date() }
  });
}

/** 批量删除云存储文件（单次 ≤50）；文件已不存在时 deleteFile 返回非 0 状态，不视为错误 */
async function deleteFiles(fileIDs) {
  const list = fileIDs.filter(Boolean);
  for (let i = 0; i < list.length; i += BATCH) {
    await cloud.deleteFile({ fileList: list.slice(i, i + BATCH) });
  }
}

/**
 * 删除一批登记行对应的文件及登记行，返回处理条数
 * 只删导出 / 存档目录下的文件；客户端直接写库伪造的登记行（带 _openid）不删文件，只清掉登记行
 */
const OWN_DIR = /^cloud:\/\/[^/]+\/(exports|archives)\//;
async function removeTracked(rows) {
  if (!rows.length) return 0;
  await deleteFiles(rows.filter(r => !r._openid && OWN_DIR.test(String(r.fileID || ''))).map(r => r.fileID));
  await db.collection('exports').where({ _id: _.in(rows.map(r => r._id)) }).remove();
  return rows.length;
}

/** 分批处理所有匹配条件的登记行（处理后即删除，因此每轮都从头取） */
async function removeWhere(cond) {
  let total = 0;
  for (let round = 0; round < 1000; round++) {
    const res = await db.collection('exports').where(cond).limit(BATCH).get();
    total += await removeTracked(res.data);
    if (res.data.length < BATCH) break;
  }
  return total;
}

/** 前端下载完成后删除临时导出文件：仅限本人 exports/ 目录下且未保留的文件 */
async function cleanupFile(openid, fileID) {
  if (!fileID) return err('缺少文件');
  // 以登记行归属为准（移交主家后，旧文件路径里仍是原主家的 openid）
  if (!OWN_DIR.test(fileID) || !fileID.includes('/exports/')) return err('无权删除该文件');
  const row = (await db.collection('exports').where({ ownerOpenid: openid, fileID, _openid: _.exists(false) }).limit(1).get()).data[0];
  if (!row || row.keep) return ok({ deleted: 0 }); // 已清理过，或为保留文件
  return ok({ deleted: await removeTracked([row]) });
}

/** 删除当前用户登记的全部文件（含归档），用于清空数据前 */
function purgeUser(openid) {
  return removeWhere({ ownerOpenid: openid });
}

/** 定时清理：所有用户超过 24 小时且未保留的文件 */
function cleanupExpired() {
  return removeWhere({ keep: false, createdAt: _.lt(new Date(Date.now() - EXPIRE_MS)) });
}

/** 归档：写入礼簿 archivePdf，并删除旧的归档文件及其登记 */
async function saveArchive(openid, book, bookId, fileID, fileName) {
  await db.collection('books').doc(bookId).update({
    data: { archivePdf: _.set({ fileID, fileName, createdAt: new Date() }) }
  });
  const old = book.archivePdf && book.archivePdf.fileID;
  if (old && old !== fileID) {
    // 只删本主家登记过的归档文件（移交后路径里仍是原主家 openid，但登记行已转到新主家）
    const row = (await db.collection('exports').where({ ownerOpenid: openid, fileID: old }).limit(1).get()).data[0];
    if (row) await removeTracked([row]);
  }
}

/** 读取礼簿并校验归属，不存在或不属于当前用户返回 null */
async function getBook(bookId, openid) {
  try {
    const res = await db.collection('books').doc(bookId).get();
    const b = res && res.data;
    return b && b.ownerOpenid === openid ? b : null;
  } catch (e) {
    return null; // doc 不存在时 get 会抛错
  }
}

function validRange(startDay, endDay) {
  return DAY_RE.test(startDay) && DAY_RE.test(endDay) && startDay <= endDay;
}

/** 拉取已入簿礼金（分批，单次最多 QUERY_MAX 条）；超过 MAX_ROWS 时返回 tooMany，由调用方提示分段导出 */
async function fetchRows(openid, { bookId, startDay, endDay, themeName }) {
  const cond = { ownerOpenid: openid, status: 'paid' };
  if (startDay && endDay) cond.payDay = _.gte(startDay).and(_.lte(endDay));
  if (bookId) cond.bookId = bookId;
  else if (themeName) cond.themeName = themeName;
  const col = db.collection('records');
  if ((await col.where(cond).count()).total > MAX_ROWS) return Object.assign([], { tooMany: true });
  const out = [];
  while (out.length < MAX_ROWS) {
    const res = await col.where(cond).orderBy('createdAt', 'asc').skip(out.length).limit(QUERY_MAX).get();
    out.push(...res.data);
    if (res.data.length < QUERY_MAX) break;
  }
  return out;
}

/** 汇总导出所需的元信息 */
function buildMeta(rows, { account, book, startDay, endDay, themeName }) {
  // 礼簿类型：按礼簿取；未指定礼簿时，仅当全部记录都是白事才按白事处理
  let bookType = book ? book.type : '';
  if (!bookType) bookType = rows.length && rows.every(r => r.bookType === 'funeral') ? 'funeral' : 'other';
  const funeral = bookType === 'funeral';
  return {
    accountName: (book && book.hostName) || account.accountName || '', // 机构版：本场主家
    bookName: book ? book.name || '' : '',
    bookDate: book ? book.date || '' : '',
    location: book ? book.location || '' : '',
    title: book ? book.name || '礼簿' : (account.accountName || '礼簿'),
    bookType, funeral,
    theme: funeral ? THEME.grey : THEME.red,
    startDay, endDay, themeName,
    count: rows.length,
    sum: rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0) / 100,
    methodLine: methodSummary(rows),
    exportedAt: fmtDateTime(new Date())
  };
}

/** 支付方式分项：微信 / 现金合计，另列「转账+现金」批次（金额已分别计入微信与现金） */
function methodSummary(rows) {
  const fen = rs => rs.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);
  const f = n => (n / 100).toFixed(2);
  const cash = rows.filter(r => r.payMethod === 'cash');
  const wechat = rows.filter(r => r.payMethod !== 'cash');
  const mixed = rows.filter(r => r.batchPay === 'mixed');
  let s = `微信 ${wechat.length} 份 ￥${f(fen(wechat))}　现金 ${cash.length} 份 ￥${f(fen(cash))}`;
  if (mixed.length) {
    const n = new Set(mixed.map(r => r.batchId)).size;
    s += `　其中转账+现金 ${n} 批：转账 ￥${f(fen(mixed.filter(r => r.payMethod !== 'cash')))}、现金 ￥${f(fen(mixed.filter(r => r.payMethod === 'cash')))}`;
  }
  return s;
}

/** 副标题：主家 / 礼簿日期 / 统计区间 */
function subtitleLines(meta) {
  const lines = [];
  const head = [`主家：${meta.accountName}`];
  if (meta.bookDate) head.push(`礼簿日期：${meta.bookDate}`);
  if (meta.location) head.push(`地点：${meta.location}`);
  lines.push(head.join('　'));
  if (meta.startDay && meta.endDay) {
    lines.push(`统计区间：${meta.startDay} 至 ${meta.endDay}${meta.themeName ? '　礼簿：' + meta.themeName : ''}`);
  }
  if (meta.methodLine) lines.push(meta.methodLine);
  lines.push(`导出时间：${meta.exportedAt}　由微信小程序「慧礼记」生成`);
  return lines;
}

/** 代随礼文字：优先 proxyItems（有金额时带金额，如「王五 ￥200、赵六」），否则用 proxyFor */
function proxyText(r) {
  if (Array.isArray(r.proxyItems) && r.proxyItems.length) {
    const parts = r.proxyItems.map(p => {
      const name = String((p && p.name) || '').trim();
      if (!name) return '';
      const a = p.amount;
      const hasAmount = a !== undefined && a !== null && a !== '' && isFinite(Number(a));
      return hasAmount ? `${name} ￥${fmtAmount(a)}` : name;
    }).filter(Boolean);
    if (parts.length) return parts.join('、');
  }
  return String(r.proxyFor || '').trim();
}

/** 宾客显示名：姓名 +（代 某某） */
function guestText(r) {
  const proxy = proxyText(r);
  return `${r.payerName || ''}${proxy ? `（代 ${proxy}）` : ''}`;
}

// —— 表格 PDF（A4 纵向） ——
const PAGE = { margin: 40, width: 595.28, height: 841.89 }; // A4
const COLS = [ // 合计宽度 515，不超过 595.28 - 80（按用户要求不含时间列）
  { key: 'idx', title: '序号', w: 30, align: 'center' },
  { key: 'guest', title: '宾客', w: 130 },
  { key: 'relation', title: '关系', w: 40, align: 'center' },
  { key: 'method', title: '方式', w: 36, align: 'center' },
  { key: 'amount', title: '礼金(元)', w: 62, align: 'right' },
  { key: 'themeName', title: '礼簿', w: 64 },
  { key: 'remark', title: '礼品/备注', w: 153 }
];
// 「转账+现金」批次的记录标「混」，礼台登记的微信标「礼台」
const methodText = r => (r.payMethod === 'cash' ? '现金' : (r.deskEntry && !r.payerOpenid ? '微信(礼台)' : '微信')) + (r.batchPay === 'mixed' ? '·混' : '');

/** 按整本礼簿导出时标题已含礼簿名，不再重复「礼簿」列，宽度并入礼品/备注；按日期跨礼簿导出时保留 */
function colsFor(meta) {
  if (!meta.bookName) return COLS;
  const book = COLS.find(c => c.key === 'themeName');
  return COLS.filter(c => c.key !== 'themeName')
    .map(c => (c.key === 'remark' ? { ...c, w: c.w + book.w } : c));
}
const ROW_H = 20;

function buildPdf(rows, meta) {
  return new Promise((resolve, reject) => {
    const doc = new (PDF())({ size: 'A4', margin: PAGE.margin, bufferPages: true, font: fontBuf() });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('cn', fontBuf());
    doc.font('cn');
    const color = meta.theme.main;
    const cols = colsFor(meta);

    // 标题与汇总
    doc.fontSize(18).fillColor('#222').text(`${meta.title} · 礼簿`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#666');
    subtitleLines(meta).forEach(l => doc.text(l, { align: 'center' }));
    doc.moveDown(0.8);

    const boxY = doc.y;
    doc.roundedRect(PAGE.margin, boxY, PAGE.width - PAGE.margin * 2, 46, 6).fillAndStroke(meta.theme.light, color);
    doc.fillColor('#333').fontSize(11).text('礼金合计', PAGE.margin + 16, boxY + 9);
    doc.fillColor(color).fontSize(16).text(`￥${meta.sum.toFixed(2)}`, PAGE.margin + 16, boxY + 24);
    doc.fillColor('#333').fontSize(11).text('份数', PAGE.width / 2, boxY + 9);
    doc.fontSize(16).text(`${meta.count} 份`, PAGE.width / 2, boxY + 24);
    doc.y = boxY + 62;

    // 明细表
    let y = drawHeader(doc, doc.y, color, cols);
    rows.forEach((r, i) => {
      if (y + ROW_H > PAGE.height - PAGE.margin - 20) {
        doc.addPage();
        y = drawHeader(doc, PAGE.margin, color, cols);
      }
      if (i % 2 === 1) doc.rect(PAGE.margin, y, tableWidth(cols), ROW_H).fill('#FAFAFA');
      const cells = {
        idx: String(i + 1),
        guest: guestText(r),
        relation: r.relation || '',
        method: methodText(r),
        amount: Number(r.amount).toFixed(2),
        themeName: r.themeName || '',
        remark: r.remark || ''
      };
      drawRow(doc, y, cells, '#333', cols);
      y += ROW_H;
    });

    // 合计行
    if (y + ROW_H > PAGE.height - PAGE.margin - 20) { doc.addPage(); y = PAGE.margin; }
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + tableWidth(cols), y).strokeColor(color).stroke();
    drawRow(doc, y, { idx: '', guest: `合计 ${meta.count} 份`, relation: '', method: '', amount: meta.sum.toFixed(2), themeName: '', remark: '' }, color, cols);

    // 页脚页码（写在下边距内，需临时取消下边距，否则 pdfkit 会自动换页）
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(8).fillColor('#999').text(
        `第 ${i + 1} / ${range.count} 页`, PAGE.margin, PAGE.height - PAGE.margin + 10,
        { width: PAGE.width - PAGE.margin * 2, align: 'center', lineBreak: false }
      );
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

function tableWidth(cols = COLS) {
  return cols.reduce((s, c) => s + c.w, 0);
}

function drawHeader(doc, y, color, cols = COLS) {
  doc.rect(PAGE.margin, y, tableWidth(cols), ROW_H).fill(color);
  drawRow(doc, y, Object.fromEntries(cols.map(c => [c.key, c.title])), '#FFFFFF', cols);
  return y + ROW_H;
}

function drawRow(doc, y, cells, color, cols = COLS) {
  let x = PAGE.margin;
  doc.fontSize(9).fillColor(color);
  for (const c of cols) {
    doc.text(String(cells[c.key] ?? ''), x + 4, y + 5, {
      width: c.w - 8, height: ROW_H - 4, align: c.align || 'left', lineBreak: false, ellipsis: true
    });
    x += c.w;
  }
}

// —— Excel ——
async function buildXlsx(rows, meta) {
  const wb = new (XLSX().Workbook)();
  wb.creator = '慧礼记';
  const ws = wb.addWorksheet('礼簿明细');

  // 整本礼簿导出：标题已含礼簿名，不再重复「礼簿」列
  const withBook = !meta.bookName;
  const lastCol = withBook ? 'G' : 'F';
  ws.mergeCells(`A1:${lastCol}1`);
  ws.getCell('A1').value = `${meta.title} · 礼簿`;
  ws.getCell('A1').font = { size: 16, bold: true };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells(`A2:${lastCol}2`);
  ws.getCell('A2').value = subtitleLines(meta).join('　');
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getCell('A2').font = { color: { argb: 'FF666666' } };

  const header = ws.getRow(4);
  header.values = withBook
    ? ['序号', '宾客', '关系', '方式', '礼金(元)', '礼簿', '礼品/备注']
    : ['序号', '宾客', '关系', '方式', '礼金(元)', '礼品/备注'];
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: meta.theme.argb } }; });

  rows.forEach((r, i) => {
    const row = [i + 1, guestText(r), r.relation || '', methodText(r), Number(r.amount)];
    ws.addRow(withBook ? row.concat(r.themeName || '', r.remark || '') : row.concat(r.remark || ''));
  });

  // 合计行：SUM 公式落在「礼金」列（E 列）
  const first = 5, last = 4 + rows.length;
  const total = ws.addRow(['合计', `${rows.length} 份`, '', '', { formula: `SUM(E${first}:E${last})`, result: meta.sum }]);
  total.font = { bold: true, color: { argb: meta.theme.argb } };

  ws.getColumn(5).numFmt = '#,##0.00';
  (withBook ? [8, 26, 10, 8, 14, 18, 32] : [8, 26, 10, 8, 14, 44]).forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 4 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// —— 传统礼簿 PDF（A4 横向，竖排，从右到左） ——
// 每页三栏：姓名（含代随礼）/ 金额（大写 + 小写）/ 礼品·备注；最右侧一列为栏目名
const BK = {
  width: 841.89, height: 595.28,
  left: 36, right: 841.89 - 36,
  gridTop: 66, gridBottom: 540,
  divider: 262,   // 姓名栏 | 金额栏 分界
  divider2: 430,  // 金额栏 | 礼品/备注栏 分界
  labelW: 34,     // 最右侧栏目列宽
  perPage: 12,
  sumSlots: 3 // 末尾合计块占用的列数
};
BK.colW = (BK.right - BK.labelW - BK.left) / BK.perPage;

function buildBook(rows, meta) {
  return new Promise((resolve, reject) => {
    // 边距全部置 0，所有文字用绝对坐标绘制，避免 pdfkit 自动换页
    const doc = new (PDF())({ size: 'A4', layout: 'landscape', margin: 0, bufferPages: true, autoFirstPage: false, font: fontBuf() });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('cn', fontBuf());
    doc.font('cn');

    const pal = meta.funeral
      ? { line: '#555555', text: '#333333', sub: '#777777', accent: '#333333' }
      : { line: '#B71C1C', text: '#222222', sub: '#777777', accent: '#B71C1C' };

    drawCover(doc, meta);

    // 内容页：每位宾客占一列，从右往左排
    let slot = BK.perPage; // 触发首个内容页
    const pageGrids = []; // 记录内容页，最后统一画格线与页码
    const newPage = () => {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
      drawBookHeader(doc, meta, pal);
      pageGrids.push({ page: doc.bufferedPageRange().count - 1, merge: null });
      slot = 0;
    };
    rows.forEach((r, i) => {
      if (slot >= BK.perPage) newPage();
      drawEntry(doc, r, i, slot, pal);
      slot++;
    });

    // 合计块：剩余列不足时另起一页
    if (BK.perPage - slot < BK.sumSlots) newPage();
    pageGrids[pageGrids.length - 1].merge = slot;
    drawSummary(doc, meta, slot, pal);

    // 格线与页码
    pageGrids.forEach((g, i) => {
      doc.switchToPage(g.page);
      drawGrid(doc, pal, g.merge);
      doc.fontSize(8).fillColor('#999').text(`— ${i + 1} / ${pageGrids.length} —`, 0, BK.gridBottom + 14,
        { width: BK.width, align: 'center', lineBreak: false });
    });
    doc.end();
  });
}

/** 封面：喜事红底金色双框；白事浅灰底深灰框 */
function drawCover(doc, meta) {
  const W = BK.width, H = BK.height;
  const c = meta.funeral
    ? { bg: '#F5F5F5', border: '#333333', title: '#333333', text: '#333333' }
    : { bg: '#B71C1C', border: '#D4AF37', title: '#D4AF37', text: '#F8E7B0' };
  doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
  doc.rect(0, 0, W, H).fill(c.bg);
  doc.lineWidth(3).rect(24, 24, W - 48, H - 48).stroke(c.border);
  doc.lineWidth(1).rect(34, 34, W - 68, H - 68).stroke(c.border);

  // 主标题：礼簿名，过长自动缩小字号
  const main = meta.bookName || (meta.funeral ? '奠仪簿' : '礼簿');
  const suffix = meta.funeral ? '奠仪簿' : '礼簿';
  const showSuffix = !!meta.bookName && !main.endsWith(suffix);
  const maxW = W - 160;
  let size = 60;
  doc.font('cn').fontSize(size);
  while (size > 20 && doc.widthOfString(main) > maxW) { size -= 2; doc.fontSize(size); }
  let y = showSuffix ? 170 : 200;
  doc.fillColor(c.title).text(main, 0, y, { width: W, align: 'center', lineBreak: false });
  y += size * 1.5;
  if (showSuffix) {
    doc.fontSize(30).fillColor(c.title).text(suffix.split('').join(' '), 0, y, { width: W, align: 'center', lineBreak: false });
    y += 56;
  }
  // 分隔短线
  doc.lineWidth(1).moveTo(W / 2 - 80, y).lineTo(W / 2 + 80, y).stroke(c.border);
  y += 22;

  const info = [];
  if (meta.accountName) info.push(`主家：${meta.accountName}`);
  if (meta.bookDate) info.push(`日期：${meta.bookDate}`);
  else if (meta.startDay && meta.endDay) info.push(`日期：${meta.startDay} 至 ${meta.endDay}`);
  if (meta.location) info.push(`地点：${meta.location}`);
  doc.fontSize(16).fillColor(c.text);
  info.forEach(t => { doc.text(t, 0, y, { width: W, align: 'center', lineBreak: false }); y += 26; });

  doc.fontSize(10).fillColor(c.text).text('慧礼记', 0, H - 70, { width: W, align: 'center', lineBreak: false });
}

/** 内容页页眉 */
function drawBookHeader(doc, meta, pal) {
  const title = `${meta.title} · ${meta.funeral ? '奠仪簿' : '礼簿'}`;
  doc.fontSize(14).fillColor(pal.accent).text(title, 0, 30, { width: BK.width, align: 'center', lineBreak: false });
  doc.fontSize(9).fillColor(pal.sub);
  if (meta.accountName) doc.text(`主家：${meta.accountName}`, BK.left, 38, { width: 200, lineBreak: false });
  const d = meta.bookDate || (meta.startDay ? `${meta.startDay} 至 ${meta.endDay}` : '');
  if (d) doc.text(d, BK.right - 200, 38, { width: 200, align: 'right', lineBreak: false });
}

/** 第 slot 列（从右数，0 起，不含最右侧栏目列）的左边界 x */
function slotX(slot) {
  return BK.right - BK.labelW - (slot + 1) * BK.colW;
}

/** 画格线：外框双线、列间竖线、三栏分隔横线、最右侧栏目列；merge 起的 sumSlots 列合并为合计块 */
function drawGrid(doc, pal, merge) {
  const { left, right, gridTop: top, gridBottom: bottom, divider, divider2, labelW } = BK;
  const inMerge = s => merge !== null && s >= merge && s < merge + BK.sumSlots;
  doc.strokeColor(pal.line);
  doc.lineWidth(1.6).rect(left - 3, top - 3, right - left + 6, bottom - top + 6).stroke();
  doc.lineWidth(0.6).rect(left, top, right - left, bottom - top).stroke();

  // 栏目列：竖线 + 两条横线 + 栏目名
  const lx = right - labelW;
  doc.lineWidth(0.6).moveTo(lx, top).lineTo(lx, bottom).stroke();
  doc.moveTo(lx, divider).lineTo(right, divider).stroke();
  doc.moveTo(lx, divider2).lineTo(right, divider2).stroke();
  doc.fillColor(pal.accent);
  [['姓名', top, divider], ['金额', divider, divider2], ['礼品/备注', divider2, bottom]].forEach(([label, y1, y2]) => {
    const tokens = tokenize(label);
    const lh = 15;
    drawVertical(doc, tokens, lx, y1 + (y2 - y1 - tokens.length * lh) / 2, labelW, 12, lh);
  });

  for (let s = 0; s < BK.perPage; s++) {
    const x = slotX(s);
    // 列左侧竖线（最左列的左线即外框）
    if (s < BK.perPage - 1 && !(inMerge(s) && inMerge(s + 1))) {
      doc.lineWidth(0.6).moveTo(x, top).lineTo(x, bottom).stroke();
    }
    if (!inMerge(s)) {
      doc.lineWidth(0.6).moveTo(x, divider).lineTo(x + BK.colW, divider).stroke();
      doc.moveTo(x, divider2).lineTo(x + BK.colW, divider2).stroke();
    }
  }
}

/**
 * 竖排绘制文字：逐字一行；连续的 ASCII 字符（数字、字母）作为一个整体横排
 * 返回实际绘制到的 y
 */
function drawVertical(doc, tokens, x, y, w, size, lineH) {
  doc.fontSize(size);
  for (const t of tokens) {
    let s = size;
    while (s > 5 && doc.fontSize(s).widthOfString(t) > w) s -= 0.5;
    doc.text(t, x, y + (size - s) / 2, { width: w, align: 'center', lineBreak: false });
    doc.fontSize(size);
    y += lineH;
  }
  return y;
}

function tokenize(str) {
  return String(str || '').match(/[\x21-\x7E]+|[^\s\x21-\x7E]/g) || [];
}

/** 截断到 n 个 token，超出时末位改为省略号 */
function clip(tokens, n) {
  if (n <= 0) return [];
  if (tokens.length <= n) return tokens;
  return tokens.slice(0, n - 1).concat('…');
}

/** 一位宾客一列：姓名栏（姓名 + 代随礼）/ 金额栏（大写 + 小写）/ 礼品·备注栏 */
function drawEntry(doc, r, i, slot, pal) {
  const x = slotX(slot), w = BK.colW, half = w / 2;
  const { gridTop: top, divider, divider2, gridBottom: bottom } = BK;
  const pSize = 10, pLH = 11.5;

  // 序号
  doc.fontSize(7).fillColor(pal.sub).text(String(i + 1), x, top + 4, { width: w, align: 'center', lineBreak: false });

  // 姓名栏：20 号字逐字竖排，代随礼小字写在姓名下方
  const proxy = proxyText(r);
  const nameSize = 20, nameLH = 23;
  const nameTop = top + 18, nameEnd = divider - 6;
  const maxNameChars = proxy ? 5 : Math.floor((nameEnd - nameTop) / nameLH);
  doc.fillColor(pal.text);
  const y = drawVertical(doc, clip(tokenize(r.payerName), maxNameChars), x, nameTop, w, nameSize, nameLH);
  if (proxy) {
    drawSmall(doc, tokenize('代' + proxy), x, y + 6, nameEnd, w, pal, pSize, pLH);
  }

  // 金额栏：大写金额（字号随字数自适应）+ 底部小写金额
  const upper = tokenize(amountUpper(r.amount));
  const avail = divider2 - 18 - (divider + 8);
  const lh = Math.min(19, avail / upper.length);
  const size = Math.max(6, Math.min(16, lh / 1.15));
  doc.fillColor(pal.text);
  drawVertical(doc, upper, x, divider + 8, w, size, lh);
  doc.fontSize(8).fillColor(pal.sub).text(`￥${fmtAmount(r.amount)}`, x, divider2 - 13, { width: w, align: 'center', lineBreak: false });

  // 礼品/备注栏：小字竖排，放不下时分两小列
  const remark = String(r.remark || '').trim();
  if (remark) drawSmall(doc, tokenize(remark), x, divider2 + 6, bottom - 4, w, pal, pSize, pLH);
}

/** 小字竖排：一列放不下时分两小列（从右往左），仍放不下以省略号结尾 */
function drawSmall(doc, tokens, x, y, yEnd, w, pal, size, lh) {
  const perCol = Math.max(0, Math.floor((yEnd - y) / lh));
  const half = w / 2;
  doc.fillColor(pal.sub);
  if (tokens.length <= perCol) {
    drawVertical(doc, tokens, x, y, w, size, lh);
  } else {
    const all = clip(tokens, perCol * 2);
    drawVertical(doc, all.slice(0, perCol), x + half - 2, y, half, size, lh);
    drawVertical(doc, all.slice(perCol), x + 2, y, half, size, lh);
  }
}

/** 合计块：共 X 份 / 礼金合计 ￥xx / 大写合计，竖排从右往左 */
function drawSummary(doc, meta, slot, pal) {
  const w = BK.colW, top = BK.gridTop + 24, bottom = BK.gridBottom - 12;
  // 第一列：共 X 份
  doc.fillColor(pal.accent);
  drawVertical(doc, tokenize(`共${meta.count}份`), slotX(slot), top, w, 20, 26);
  // 第二列：礼金合计 + 小写金额
  let y = drawVertical(doc, tokenize('礼金合计'), slotX(slot + 1), top, w, 20, 26);
  drawVertical(doc, [`￥${meta.sum.toFixed(2)}`], slotX(slot + 1) + 2, y + 6, w - 4, 14, 18);
  // 第三列：大写合计
  const upper = tokenize(amountUpper(meta.sum));
  const lh = Math.min(26, (bottom - top) / upper.length);
  const size = Math.max(7, Math.min(20, lh / 1.15));
  doc.fillColor(pal.text);
  drawVertical(doc, upper, slotX(slot + 2), top, w, size, lh);
}

// —— 全量备份（xlsx） ——
async function exportBackup(openid, withGifts = true) {
  const [records, books, gifts] = await Promise.all([
    fetchRows(openid, {}),
    fetchAll('books', { ownerOpenid: openid }),
    withGifts ? fetchAll('gifts_out', { ownerOpenid: openid }) : Promise.resolve([])
  ]);
  if (records.tooMany) return err(`礼金超过 ${MAX_ROWS} 笔，请按礼簿或日期范围分段导出`);
  if (!records.length && !books.length && !gifts.length) return err('暂无可备份的数据');

  const buffer = await buildBackup({ records, books, gifts });
  const up = await cloud.uploadFile({
    cloudPath: `exports/${openid}/backup-${Date.now()}.xlsx`,
    fileContent: buffer
  });
  await track(openid, up.fileID, false, 'backup');
  const fileName = `慧礼记备份_${fmtDateTime(new Date()).slice(0, 10).replace(/-/g, '')}.xlsx`;
  return ok({ fileID: up.fileID, fileName, count: records.length, sum: centsSum(records) });
}

/** 通用分页拉取（单次最多 QUERY_MAX 条，上限 MAX_ROWS） */
async function fetchAll(name, cond) {
  const col = db.collection(name);
  const out = [];
  while (out.length < MAX_ROWS) {
    const res = await col.where(cond).skip(out.length).limit(QUERY_MAX).get();
    out.push(...res.data);
    if (res.data.length < QUERY_MAX) break;
  }
  return out;
}

const timeOf = r => new Date(r.paidAt || r.createdAt).getTime() || 0;
// 金额合计（按分累加，避免浮点误差）
const centsSum = rows => rows.reduce((s, r) => s + (Math.round(Number(r.amount) * 100) || 0), 0) / 100;

/** 组装备份工作簿：礼簿汇总 / 礼金明细 / 送礼记录 */
async function buildBackup({ records, books, gifts }) {
  const wb = new (XLSX().Workbook)();
  wb.creator = '慧礼记';
  const headStyle = row => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: THEME.red.argb } }; });
  };
  const totalStyle = row => { row.font = { bold: true, color: { argb: THEME.red.argb } }; };
  // 合计公式：数据从第 2 行开始，共 n 行；无数据时直接写 0
  const sumCell = (col, n, value) => (n > 0 ? { formula: `SUM(${col}2:${col}${n + 1})`, result: value } : 0);

  // 礼簿按日期、名称排序；无 bookId 或礼簿已不存在的记录归入「未归入礼簿」
  const sortedBooks = books.slice().sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')) || String(a.name || '').localeCompare(String(b.name || '')));
  const bookIndex = new Map(sortedBooks.map((b, i) => [b._id, i]));
  const groups = sortedBooks.map(b => ({ book: b, rows: [] }));
  const loose = [];
  records.forEach(r => {
    const i = r.bookId ? bookIndex.get(r.bookId) : undefined;
    if (i === undefined) loose.push(r); else groups[i].rows.push(r);
  });
  groups.forEach(g => g.rows.sort((a, b) => timeOf(a) - timeOf(b)));
  loose.sort((a, b) => timeOf(a) - timeOf(b));

  // 礼簿汇总
  const ws1 = wb.addWorksheet('礼簿汇总');
  headStyle(ws1.addRow(['礼簿', '类型', '日期', '地点', '状态', '份数', '礼金合计']));
  groups.forEach(({ book: b, rows }) => {
    ws1.addRow([b.name || '', TYPE_LABEL[b.type] || '', b.date || '', b.location || '',
      b.archived ? '已归档' : '进行中', rows.length, centsSum(rows)]);
  });
  if (loose.length) ws1.addRow([NO_BOOK, '', '', '', '', loose.length, centsSum(loose)]);
  const n1 = groups.length + (loose.length ? 1 : 0);
  totalStyle(ws1.addRow(['合计', '', '', '', '', sumCell('F', n1, records.length), sumCell('G', n1, centsSum(records))]));
  ws1.getColumn(7).numFmt = '#,##0.00';
  [24, 10, 12, 20, 10, 8, 14].forEach((w, i) => { ws1.getColumn(i + 1).width = w; });
  ws1.views = [{ state: 'frozen', ySplit: 1 }];

  // 礼金明细：按礼簿、时间排序
  const ws2 = wb.addWorksheet('礼金明细');
  headStyle(ws2.addRow(['序号', '礼簿', '时间', '宾客', '代随礼', '关系', '方式', '礼金(元)', '礼品/备注']));
  const ordered = [];
  groups.forEach(g => g.rows.forEach(r => ordered.push([g.book.name || '', r])));
  loose.forEach(r => ordered.push([NO_BOOK, r]));
  ordered.forEach(([name, r], i) => {
    ws2.addRow([i + 1, name, fmtDateTime(r.paidAt || r.createdAt), r.payerName || '', proxyText(r),
      r.relation || '', methodText(r), Number(r.amount), r.remark || '']);
  });
  totalStyle(ws2.addRow(['', '合计', `${ordered.length} 份`, '', '', '', '', sumCell('H', ordered.length, centsSum(records)), '']));
  ws2.getColumn(8).numFmt = '#,##0.00';
  [8, 20, 18, 14, 22, 10, 8, 12, 30].forEach((w, i) => { ws2.getColumn(i + 1).width = w; });
  ws2.views = [{ state: 'frozen', ySplit: 1 }];

  // 送礼记录：按日期排序
  const ws3 = wb.addWorksheet('送礼记录');
  headStyle(ws3.addRow(['序号', '日期', '对方', '关系', '类型', '事由', '金额(元)', '备注']));
  const gs = gifts.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  gs.forEach((g, i) => {
    ws3.addRow([i + 1, g.date || '', g.toName || '', g.relation || '', TYPE_LABEL[g.eventType] || '',
      g.event || '', Number(g.amount) || 0, g.remark || '']);
  });
  totalStyle(ws3.addRow(['', '合计', `${gs.length} 笔`, '', '', '', sumCell('G', gs.length, centsSum(gs)), '']));
  ws3.getColumn(7).numFmt = '#,##0.00';
  [8, 12, 14, 10, 12, 20, 12, 30].forEach((w, i) => { ws3.getColumn(i + 1).width = w; });
  ws3.views = [{ state: 'frozen', ySplit: 1 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 人民币大写（整数分运算） */
function amountUpper(n) {
  const D = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  const U = ['', '拾', '佰', '仟'];
  const G = ['', '万', '亿', '万亿'];
  let fen = Math.round(Number(n) * 100);
  if (!isFinite(fen)) return '';
  const neg = fen < 0;
  if (neg) fen = -fen;
  if (fen === 0) return '零元整';
  const yuan = Math.floor(fen / 100);
  const jiao = Math.floor(fen / 10) % 10;
  const f = fen % 10;

  // 整数部分：四位一组，组内/组间的连续零只读一个“零”
  let s = '';
  let zero = false;
  const groups = [];
  for (let v = yuan; v > 0; v = Math.floor(v / 10000)) groups.push(v % 10000);
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (g === 0) { if (s) zero = true; continue; }
    if (s && g < 1000) zero = true;
    let started = false;
    for (let p = 3; p >= 0; p--) {
      const d = Math.floor(g / Math.pow(10, p)) % 10;
      if (d === 0) { if (started) zero = true; continue; }
      if (zero) { s += '零'; zero = false; }
      s += D[d] + U[p];
      started = true;
    }
    s += G[gi];
  }
  if (yuan > 0) s += '元';

  // 角分部分
  if (jiao === 0 && f === 0) {
    s += '整';
  } else {
    if (jiao > 0) s += D[jiao] + '角';
    else if (yuan > 0) s += '零';
    s += f > 0 ? D[f] + '分' : '整';
  }
  return (neg ? '负' : '') + s;
}

// —— 工具 ——
function fmtAmount(n) {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** 文件名去除非法字符 */
function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s\x00-\x1F]+/g, '_').slice(0, 40) || '导出';
}

function fmtDateTime(d) {
  // 云函数运行在 UTC，统一转北京时间
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });

// 仅供本地测试使用，不影响云函数入口
module.exports._test = { buildPdf, buildXlsx, buildBook, buildBackup, buildMeta, amountUpper, sanitizeName, guestText, proxyText };
