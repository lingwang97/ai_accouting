// utils/escpos.js — ESC/POS 小票字节流构造（文档 §6.5）
const gbk = require('./gbk.js');
const fmt = require('./format.js');

const ESC = 0x1b, GS = 0x1d;

// 指令片段
const CMD = {
  init: [ESC, 0x40],            // 初始化
  alignLeft: [ESC, 0x61, 0x00],
  alignCenter: [ESC, 0x61, 0x01],
  alignRight: [ESC, 0x61, 0x02],
  boldOn: [ESC, 0x45, 0x01],
  boldOff: [ESC, 0x45, 0x00],
  sizeNormal: [GS, 0x21, 0x00], // GS ! n 字号
  sizeDouble: [GS, 0x21, 0x11], // 倍宽倍高
  feed: [0x0a],
  cut: [GS, 0x56, 0x42, 0x00]   // 切纸
};

const text = s => gbk.encode(s);

/** 组装一条完整小票，返回 ArrayBuffer */
function buildReceipt(record, tpl) {
  const width = tpl.paperWidth || 32;
  const fields = tpl.fields || DEFAULT_FIELDS;
  const bytes = [...CMD.init];
  // 主家与记账人：紧跟标题；模板去掉了标题时放在最前
  const who = [record.accountName ? `主家：${record.accountName}` : '', record.handlerName ? `记账：${record.handlerName}` : '']
    .filter(Boolean).join('  ');
  if (who && !fields.includes('title')) bytes.push(...CMD.alignCenter, ...text(who), ...CMD.feed);

  for (const f of fields) {
    switch (f) {
      case 'title':
        bytes.push(...CMD.alignCenter, ...CMD.boldOn, ...text(tpl.title || '礼金回执'), ...CMD.feed, ...CMD.boldOff);
        if (who) bytes.push(...CMD.alignCenter, ...text(who), ...CMD.feed);
        break;
      case 'divider':
        if (tpl.showDivider !== false) {
          bytes.push(...CMD.alignLeft, ...text('-'.repeat(width)), ...CMD.feed);
        }
        break;
      case 'theme':
        if (record.themeName) {
          bytes.push(...CMD.alignLeft, ...text(`事由：${record.themeName}`), ...CMD.feed);
        }
        break;
      case 'payDay':
        bytes.push(...CMD.alignLeft, ...text(`日期：${fmt.day(record.paidAt || record.createdAt)}`), ...CMD.feed);
        break;
      case 'time':
        bytes.push(...CMD.alignLeft, ...text(`时间：${fmt.time(record.paidAt || record.createdAt)}`), ...CMD.feed);
        break;
      case 'payerName':
        bytes.push(...CMD.alignLeft, ...text(`随礼人：${record.payerName}`), ...CMD.feed);
        break;
      case 'relation':
        if (record.relation) {
          bytes.push(...CMD.alignLeft, ...text(`关系：${record.relation}`), ...CMD.feed);
        }
        break;
      case 'amount':
        bytes.push(...CMD.alignRight, ...CMD.sizeDouble, ...CMD.boldOn,
          ...text(`￥${fmt.money(record.amount)}`), ...CMD.feed,
          ...CMD.sizeNormal, ...CMD.boldOff);
        if (record.payMethod === 'cash') bytes.push(...CMD.alignRight, ...text('（现金）'), ...CMD.feed);
        break;
      case 'remark':
        if (record.remark) {
          bytes.push(...CMD.alignLeft, ...text(`礼品/备注：${record.remark}`), ...CMD.feed);
        }
        break;
      case 'thanks':
        if (tpl.thanks) {
          bytes.push(...CMD.alignCenter, ...text(tpl.thanks), ...CMD.feed);
        }
        break;
    }
  }

  // 底部推广语：白事不打印；「回执样式 → 打印小票」里可关闭
  if (tpl.promo !== false && record.bookType !== 'funeral') {
    bytes.push(...CMD.alignCenter, ...text('微信搜索「慧礼记」记礼金·查往来'), ...CMD.feed);
  }
  bytes.push(...CMD.feed, ...CMD.feed, ...CMD.cut);
  return new Uint8Array(bytes).buffer;
}

/** 联机测试页 */
function buildTestLine() {
  const bytes = [
    ...CMD.init, ...CMD.alignCenter, ...CMD.boldOn,
    ...text('打印测试成功'), ...CMD.feed,
    ...CMD.boldOff, ...text(fmt.dateTime(new Date())), ...CMD.feed,
    ...CMD.feed, ...CMD.cut
  ];
  return new Uint8Array(bytes).buffer;
}

const DEFAULT_FIELDS = ['title', 'divider', 'theme', 'payDay', 'time', 'payerName', 'amount', 'remark', 'thanks'];

module.exports = { buildReceipt, buildTestLine, DEFAULT_FIELDS };
