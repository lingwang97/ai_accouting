// 测试辅助：把 ESC/POS 字节流解析成「行」，用来检查花边模式下每行占多少列、左右字符是否对齐
// 返回数组：{ type: 'text', cols, text, size } | { type: 'raster', wBytes, h }
const decoder = new TextDecoder('gbk');
function dump(buf) {
  const b = Array.from(new Uint8Array(buf));
  const out = [];
  let i = 0, cur = [], cols = 0, wmul = 1, hasText = false;
  const flush = () => { out.push({ type: 'text', cols, text: decoder.decode(Uint8Array.from(cur)), size: wmul }); cur = []; cols = 0; hasText = false; };
  while (i < b.length) {
    const c = b[i];
    if (c === 0x1b) {
      const k = b[i + 1];
      if (k === 0x40) i += 2;
      else i += 3; // a / E / d / J 均带 1 个参数
    } else if (c === 0x1d) {
      const k = b[i + 1];
      if (k === 0x21) { wmul = (b[i + 2] >> 4) + 1; i += 3; }
      else if (k === 0x56) i += 4;
      else if (k === 0x76) {
        const w = b[i + 4] + b[i + 5] * 256, h = b[i + 6] + b[i + 7] * 256;
        out.push({ type: 'raster', wBytes: w, h });
        i += 8 + w * h;
      } else throw new Error('未知 GS 指令 ' + k);
    } else if (c === 0x0a) { flush(); i++; }
    else if (c >= 0x81 && c <= 0xfe) { cur.push(c, b[i + 1]); cols += 2 * wmul; hasText = true; i += 2; }
    else { cur.push(c); cols += wmul; hasText = true; i++; }
  }
  if (hasText) flush();
  return out;
}
module.exports = { dump };
