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
  sizeTall: [GS, 0x21, 0x01],   // 倍高
  sizeDouble: [GS, 0x21, 0x11], // 倍宽倍高
  feed: [0x0a],
  cut: [GS, 0x56, 0x42, 0x00]   // 切纸（带切刀的机器才有效，没有切刀的机器忽略）
};

const AMOUNT_SIZE = { double: CMD.sizeDouble, tall: CMD.sizeTall, normal: CMD.sizeNormal };
const feedLines = n => (n > 0 ? [ESC, 0x64, n] : []); // ESC d n：打印并走纸 n 行

const text = s => gbk.encode(s);

/** 默认值；旧模板缺新字段时按此补齐 */
const TPL_DEFAULTS = {
  feedTop: 1, feedBottom: 5, amountSize: 'double', titleAlign: 'center', titleBold: true,
  showHandler: true, footer: ''
};
const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
function withDefaults(tpl) {
  const t = tpl || {};
  return {
    ...t,
    feedTop: clampInt(t.feedTop, 0, 4, TPL_DEFAULTS.feedTop),
    feedBottom: clampInt(t.feedBottom, 2, 8, TPL_DEFAULTS.feedBottom),
    amountSize: AMOUNT_SIZE[t.amountSize] ? t.amountSize : TPL_DEFAULTS.amountSize,
    titleAlign: t.titleAlign === 'left' ? 'left' : 'center',
    titleBold: t.titleBold !== false,
    showHandler: t.showHandler !== false,
    footer: String(t.footer || '')
  };
}

/** 按打印列宽折行（中文占 2 列，半角占 1 列），长文本整段换行不截断 */
function wrap(s, width) {
  const out = [];
  let cur = '', w = 0;
  for (const ch of Array.from(String(s).replace(/[\r\n\t]+/g, ' '))) {
    const cw = ch.charCodeAt(0) > 255 ? 2 : 1;
    if (w + cw > width) { out.push(cur); cur = ''; w = 0; }
    cur += ch; w += cw;
  }
  if (cur) out.push(cur);
  return out;
}

/** 组装一条完整小票，返回 ArrayBuffer；opts.qr 由二维码模块提供的字节（可选） */
function buildReceipt(record, rawTpl, opts) {
  const tpl = withDefaults(rawTpl);
  const width = tpl.paperWidth || 32;
  const fields = tpl.fields || DEFAULT_FIELDS;
  const bytes = [...CMD.init, ...feedLines(tpl.feedTop)];
  const put = (...parts) => parts.forEach(p => bytes.push(...p));
  // 文字行：先折行再逐行输出
  const lines = (s, align) => wrap(s, width).forEach(l => put(align || CMD.alignLeft, text(l), CMD.feed));

  // 主家与记账人：紧跟标题；模板去掉了标题时放在最前。主家称呼不提供开关（回执的身份凭据）
  const who = [record.accountName ? `主家：${record.accountName}` : '',
    tpl.showHandler && record.handlerName ? `记账：${record.handlerName}` : '']
    .filter(Boolean).join('  ');
  if (who && !fields.includes('title')) lines(who, CMD.alignCenter);

  for (const f of fields) {
    switch (f) {
      case 'title': {
        const al = tpl.titleAlign === 'left' ? CMD.alignLeft : CMD.alignCenter;
        if (tpl.titleBold) put(CMD.boldOn);
        lines(tpl.title || '礼金回执', al);
        put(CMD.boldOff);
        if (who) lines(who, al);
        break;
      }
      case 'divider':
        if (tpl.showDivider !== false) put(CMD.alignLeft, text('-'.repeat(width)), CMD.feed);
        break;
      case 'theme':
        if (record.themeName) lines(`事由：${record.themeName}`);
        break;
      case 'payDay':
        lines(`日期：${fmt.day(record.paidAt || record.createdAt)}`);
        break;
      case 'time':
        lines(`时间：${fmt.time(record.paidAt || record.createdAt)}`);
        break;
      case 'receiptNo':
        if (record._id) lines(`编号：${fmt.receiptNo(record)}`);
        break;
      case 'payerName':
        lines(`随礼人：${record.payerName}`);
        break;
      case 'relation':
        if (record.relation) lines(`关系：${record.relation}`);
        break;
      case 'payMethod':
        lines(`方式：${record.payMethod === 'cash' ? '现金' : '微信'}`);
        break;
      case 'amount':
        put(CMD.alignRight, AMOUNT_SIZE[tpl.amountSize], CMD.boldOn,
          text(`￥${fmt.money(record.amount)}`), CMD.feed, CMD.sizeNormal, CMD.boldOff);
        // 没有单独打印「方式」行时，现金仍在金额下标注
        if (record.payMethod === 'cash' && !fields.includes('payMethod')) put(CMD.alignRight, text('（现金）'), CMD.feed);
        break;
      case 'amountUpper':
        lines(`大写：${fmt.amountUpper(record.amount)}`, CMD.alignRight);
        break;
      case 'remark':
        if (record.remark) lines(`礼品/备注：${record.remark}`);
        break;
      case 'thanks':
        if (tpl.thanks) lines(tpl.thanks, CMD.alignCenter);
        break;
    }
  }

  // 二维码（可选，位于致谢语之后）：二维码字节由 qrprint 生成，下面印一行提示
  if (opts && opts.qr) {
    put(CMD.feed, CMD.alignCenter, opts.qr, CMD.feed);
    lines(record.bookType === 'funeral' ? '扫码查看回执' : '扫码查看电子回执', CMD.alignCenter);
  }
  // 自定义页脚一行
  if (tpl.footer) lines(tpl.footer, CMD.alignCenter);
  // 底部推广语：白事不打印；「回执样式 → 打印小票」里可关闭
  if (tpl.promo !== false && record.bookType !== 'funeral') lines('微信搜索「慧礼记」记礼金·查往来', CMD.alignCenter);
  // 下方留白，便于撕纸；ESC d 对有无切刀的机器都有效
  put(feedLines(tpl.feedBottom), CMD.cut);
  return new Uint8Array(bytes).buffer;
}

/** 联机测试页 */
/** 二维码测试页：用一段固定文字，扫出来能看到文字即说明这台机器支持当前方式 */
function buildQrTest(qrBytes, mode) {
  const bytes = [
    ...CMD.init, ...CMD.alignCenter, ...CMD.boldOn,
    ...text(mode === 'image' ? '二维码测试（图片方式）' : '二维码测试（原生指令）'), ...CMD.feed, ...CMD.boldOff,
    ...CMD.feed, ...qrBytes, ...CMD.feed,
    ...text('微信扫一扫应显示：'), ...CMD.feed, ...text('HUILIJI QR TEST 123'), ...CMD.feed,
    ...feedLines(4), ...CMD.cut
  ];
  return new Uint8Array(bytes).buffer;
}

function buildTestLine() {
  const bytes = [
    ...CMD.init, ...CMD.alignCenter, ...CMD.boldOn,
    ...text('打印测试成功'), ...CMD.feed,
    ...CMD.boldOff, ...text(fmt.dateTime(new Date())), ...CMD.feed,
    ...feedLines(4), ...CMD.cut
  ];
  return new Uint8Array(bytes).buffer;
}

/** 是否打印二维码：模板明确设置了按模板；没设置时喜事等默认开，白事默认关 */
const qrOn = (tpl, bookType) => (tpl && typeof tpl.qr === 'boolean' ? tpl.qr : bookType !== 'funeral');

const DEFAULT_FIELDS = ['title', 'divider', 'theme', 'payDay', 'time', 'receiptNo', 'payerName', 'amount', 'amountUpper', 'remark', 'thanks'];

module.exports = { qrOn, buildReceipt, buildTestLine, buildQrTest, DEFAULT_FIELDS, TPL_DEFAULTS, withDefaults, wrap, CMD };
