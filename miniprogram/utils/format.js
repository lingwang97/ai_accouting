// utils/format.js — 金额/日期格式化
const pad = n => (n < 10 ? '0' + n : '' + n);

function money(n) {
  return (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
}

function day(d) {
  const t = new Date(d);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function time(d) {
  const t = new Date(d);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

function dateTime(d) {
  return `${day(d)} ${time(d)}`;
}

/** 汇总用整数分累加，避免浮点误差 */
function sumAmounts(list) {
  const fen = list.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  return fen / 100;
}

/** 收据编号：到账日期 + 记录 ID 末 6 位 */
function receiptNo(r) {
  const d = day(r.paidAt || r.createdAt).replace(/-/g, '');
  return `R${d}${String(r._id || '').slice(-6).toUpperCase()}`;
}

/** 金额转人民币大写 */
function amountUpper(n) {
  const fen = Math.round(Number(n || 0) * 100);
  if (fen === 0) return '零元整';
  const digit = '零壹贰叁肆伍陆柒捌玖';
  const unit = ['', '拾', '佰', '仟'];
  const big = ['', '万', '亿'];
  const yuan = Math.floor(fen / 100);
  const jiao = Math.floor(fen / 10) % 10;
  const f = fen % 10;

  let s = '';
  if (yuan > 0) {
    const str = String(yuan);
    let zero = false;
    for (let i = 0; i < str.length; i++) {
      const pos = str.length - 1 - i;
      const d = Number(str[i]);
      if (d === 0) {
        zero = true;
      } else {
        if (zero) s += '零';
        zero = false;
        s += digit[d] + unit[pos % 4];
      }
      if (pos % 4 === 0 && pos > 0) {
        // 万/亿 节：本节有非零数字才加单位
        const sec = str.slice(Math.max(0, i - 3), i + 1);
        if (Number(sec) > 0) s += big[pos / 4];
      }
    }
    s += '元';
  }
  if (jiao === 0 && f === 0) return s + '整';
  if (jiao > 0) s += digit[jiao] + '角';
  else if (yuan > 0) s += '零';
  if (f > 0) s += digit[f] + '分';
  else s += '整'; // 到角为止，后写"整"
  return s;
}

/**
 * 画图用的行数上限：画布过高时部分安卓机导出失败，超出时截断并补一行说明（完整内容用「复制对账单」）
 * @param {string[]} lines 全部行
 * @param {number} max 最多画几行（含说明行）
 */
function clipLines(lines, max) {
  if (lines.length <= max) return lines;
  const keep = Math.max(1, max - 1);
  return lines.slice(0, keep).concat(`…… 另有 ${lines.length - keep} 行未画出，请用「复制对账单」查看完整内容`);
}

module.exports = { clipLines, money, day, time, dateTime, sumAmounts, receiptNo, amountUpper };
