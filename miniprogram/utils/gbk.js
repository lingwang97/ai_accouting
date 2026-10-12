// utils/gbk.js — GBK 编码（热敏打印机中文字符必需）
const TABLE = require('./gbk-table.js');

function encode(str) {
  const out = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out.push(cp);
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
