// 云函数 export — 账目导出 PDF / Excel（文档 §6.7）
// 入参：{ format: 'pdf'|'xlsx', startDay: 'YYYY-MM-DD', endDay: 'YYYY-MM-DD', themeName?: string }
const cloud = require('wx-server-sdk');
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const FONT = path.join(__dirname, 'fonts', 'NotoSansSC-Subset.otf');
const MAX_ROWS = 5000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    const format = event.format === 'xlsx' ? 'xlsx' : 'pdf';
    const startDay = String(event.startDay || '');
    const endDay = String(event.endDay || '');
    if (!DAY_RE.test(startDay) || !DAY_RE.test(endDay) || startDay > endDay) {
      return err('日期范围不正确');
    }
    const themeName = String(event.themeName || '').slice(0, 20);

    const account = (await db.collection('accounts').where({ ownerOpenid: OPENID }).limit(1).get()).data[0];
    if (!account) return err('请先绑定收款账户');

    const rows = await fetchRows(OPENID, startDay, endDay, themeName);
    if (rows.length === 0) return err('该范围内没有已到账的账目');

    const meta = {
      accountName: account.accountName,
      startDay, endDay, themeName,
      count: rows.length,
      sum: rows.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100,
      exportedAt: fmtDateTime(new Date())
    };

    const buffer = format === 'pdf' ? await buildPdf(rows, meta) : await buildXlsx(rows, meta);
    const fileName = `账目_${startDay}_${endDay}${themeName ? '_' + themeName : ''}.${format}`;
    const up = await cloud.uploadFile({
      cloudPath: `exports/${OPENID}/${Date.now()}.${format}`,
      fileContent: buffer
    });
    return ok({ fileID: up.fileID, fileName, count: meta.count, sum: meta.sum });
  } catch (e) {
    return err('导出失败：' + e.message);
  }
};

/** 拉取范围内已到账账目（分批，单次最多 100 条） */
async function fetchRows(openid, startDay, endDay, themeName) {
  const cond = { ownerOpenid: openid, status: 'paid', payDay: _.gte(startDay).and(_.lte(endDay)) };
  if (themeName) cond.themeName = themeName;
  const col = db.collection('records');
  const out = [];
  while (out.length < MAX_ROWS) {
    const res = await col.where(cond).orderBy('createdAt', 'asc').skip(out.length).limit(100).get();
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out;
}

// —— PDF ——
const PAGE = { margin: 40, width: 595.28, height: 841.89 }; // A4
const COLS = [
  { key: 'idx', title: '序号', w: 36, align: 'center' },
  { key: 'time', title: '时间', w: 100 },
  { key: 'payerName', title: '付款人', w: 80 },
  { key: 'amount', title: '金额(元)', w: 72, align: 'right' },
  { key: 'themeName', title: '主题', w: 80 },
  { key: 'remark', title: '备注', w: 147 }
];
const ROW_H = 20;

function buildPdf(rows, meta) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('cn', FONT);
    doc.font('cn');

    // 标题与汇总
    doc.fontSize(18).text(`${meta.accountName} · 收款账目`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#666')
      .text(`统计区间：${meta.startDay} 至 ${meta.endDay}${meta.themeName ? '　主题：' + meta.themeName : ''}`, { align: 'center' })
      .text(`导出时间：${meta.exportedAt}`, { align: 'center' });
    doc.moveDown(0.8);

    const boxY = doc.y;
    doc.roundedRect(PAGE.margin, boxY, PAGE.width - PAGE.margin * 2, 46, 6).fillAndStroke('#F2FBF6', '#07C160');
    doc.fillColor('#333').fontSize(11).text('已到账合计', PAGE.margin + 16, boxY + 9);
    doc.fillColor('#07C160').fontSize(16).text(`￥${meta.sum.toFixed(2)}`, PAGE.margin + 16, boxY + 24);
    doc.fillColor('#333').fontSize(11).text('笔数', PAGE.width / 2, boxY + 9);
    doc.fontSize(16).text(`${meta.count} 笔`, PAGE.width / 2, boxY + 24);
    doc.y = boxY + 62;

    // 明细表
    let y = drawHeader(doc, doc.y);
    rows.forEach((r, i) => {
      if (y + ROW_H > PAGE.height - PAGE.margin - 20) {
        doc.addPage();
        y = drawHeader(doc, PAGE.margin);
      }
      if (i % 2 === 1) doc.rect(PAGE.margin, y, tableWidth(), ROW_H).fill('#FAFAFA');
      const cells = {
        idx: String(i + 1),
        time: fmtDateTime(r.paidAt || r.createdAt),
        payerName: r.payerName,
        amount: Number(r.amount).toFixed(2),
        themeName: r.themeName || '',
        remark: r.remark || ''
      };
      drawRow(doc, y, cells, '#333');
      y += ROW_H;
    });

    // 合计行
    if (y + ROW_H > PAGE.height - PAGE.margin - 20) { doc.addPage(); y = PAGE.margin; }
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + tableWidth(), y).strokeColor('#07C160').stroke();
    drawRow(doc, y, { idx: '', time: '合计', payerName: `${meta.count} 笔`, amount: meta.sum.toFixed(2), themeName: '', remark: '' }, '#07C160');

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

function tableWidth() {
  return COLS.reduce((s, c) => s + c.w, 0);
}

function drawHeader(doc, y) {
  doc.rect(PAGE.margin, y, tableWidth(), ROW_H).fill('#07C160');
  drawRow(doc, y, Object.fromEntries(COLS.map(c => [c.key, c.title])), '#FFFFFF');
  return y + ROW_H;
}

function drawRow(doc, y, cells, color) {
  let x = PAGE.margin;
  doc.fontSize(9).fillColor(color);
  for (const c of COLS) {
    doc.text(String(cells[c.key] ?? ''), x + 4, y + 5, {
      width: c.w - 8, height: ROW_H - 4, align: c.align || 'left', lineBreak: false, ellipsis: true
    });
    x += c.w;
  }
}

// —— Excel ——
async function buildXlsx(rows, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '扫码智能记账';
  const ws = wb.addWorksheet('账目明细');

  ws.mergeCells('A1:F1');
  ws.getCell('A1').value = `${meta.accountName} · 收款账目`;
  ws.getCell('A1').font = { size: 16, bold: true };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:F2');
  ws.getCell('A2').value = `统计区间：${meta.startDay} 至 ${meta.endDay}${meta.themeName ? '　主题：' + meta.themeName : ''}　导出时间：${meta.exportedAt}`;
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getCell('A2').font = { color: { argb: 'FF666666' } };

  const header = ws.getRow(4);
  header.values = ['序号', '时间', '付款人', '金额(元)', '主题', '备注'];
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF07C160' } }; });

  rows.forEach((r, i) => {
    ws.addRow([i + 1, fmtDateTime(r.paidAt || r.createdAt), r.payerName, Number(r.amount), r.themeName || '', r.remark || '']);
  });

  const first = 5, last = 4 + rows.length;
  const total = ws.addRow(['', '合计', `${rows.length} 笔`, { formula: `SUM(D${first}:D${last})`, result: meta.sum }, '', '']);
  total.font = { bold: true, color: { argb: 'FF07C160' } };

  ws.getColumn(4).numFmt = '#,##0.00';
  [8, 20, 14, 14, 16, 30].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 4 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// —— 工具 ——
function fmtDateTime(d) {
  // 云函数运行在 UTC，统一转北京时间
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
