// utils/gbk.js — GBK 编码（热敏打印机中文字符必需）
const TABLE = require('./gbk-table.js');

function encode(str) {
  const out = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      // 文本中的控制字符（ESC/GS 等）会被打印机当指令执行：除换行外一律换成空格
      out.push(cp < 0x20 && cp !== 0x0a || cp === 0x7f ? 0x20 : cp);
    } else {
      const gbk = TABLE[cp];
      if (gbk !== undefined) {
        out.push((gbk >> 8) & 0xff, gbk & 0xff);
      } else {
        out.push(0x3f); // 表外生僻字以 '?' 代替，避免整行乱码
      }
    }
  }
  return out;
}

module.exports = { encode };
