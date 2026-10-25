// utils/qrprint.js — 小票二维码的 ESC/POS 字节：原生指令 GS ( k，或图片方式 GS v 0（光栅位图）
// 图片方式在前端直接由二维码矩阵逐点生成位图，不需要 canvas；数据量大（约 3.5KB），蓝牙每包 20 字节，要多等 3～4 秒，但所有 ESC/POS 机器都能打。
const qrcode = require('./qrcode-lib.js');

const GS = 0x1d;

/** 只允许可打印 ASCII（URL Link 都是 ASCII），长度 ≤ 120，防止二维码过大 */
function validData(s) {
  return typeof s === 'string' && /^[\x20-\x7e]{1,120}$/.test(s);
}

/** 返回 { n, dark(r, c) }；失败返回 null */
function matrixOf(data) {
  if (!validData(data)) return null;
  try {
    const q = qrcode(0, 'M'); // 自动选版本，纠错 M
    q.addData(data, 'Byte');
    q.make();
    return { n: q.getModuleCount(), dark: (r, c) => q.isDark(r, c) };
  } catch (e) {
    return null;
  }
}

/** 原生二维码：模型 2、模块大小 cell 点、纠错 M；打印机自己生成。不支持的机型可能不出码 */
function nativeBytes(data, cell) {
  if (!validData(data)) return null;
  const body = Array.from(data, ch => ch.charCodeAt(0));
  const len = body.length + 3;
  return [
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,       // 选择模型 2
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, cell || 6,          // 模块大小
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,               // 纠错等级 M
    GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...body, // 存入数据
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30                // 打印
  ];
}

/**
 * 图片方式：每个模块 cell×cell 点，四周留 quiet 个模块的白边，输出 GS v 0 光栅位图。
 * maxDots：纸宽点数（58mm=384、80mm=576）；放不下时返回 null（调用方放弃二维码）
 */
function rasterBytes(data, cell, maxDots) {
  const m = matrixOf(data);
  if (!m) return null;
  const quiet = 2;
  const cellDots = cell || 5;
  const side = (m.n + quiet * 2) * cellDots;
  if (side > (maxDots || 384)) return null;
  const wBytes = Math.ceil(side / 8);
  const out = [GS, 0x76, 0x30, 0x00, wBytes & 0xff, wBytes >> 8, side & 0xff, side >> 8];
  for (let y = 0; y < side; y++) {
    const r = Math.floor(y / cellDots) - quiet;
    const row = new Array(wBytes).fill(0);
    for (let x = 0; x < side; x++) {
      const c = Math.floor(x / cellDots) - quiet;
      if (r >= 0 && c >= 0 && r < m.n && c < m.n && m.dark(r, c)) row[x >> 3] |= 0x80 >> (x & 7);
    }
    for (let i = 0; i < wBytes; i++) out.push(row[i]);
  }
  return out;
}

/** 云端返回的 GS v 0 光栅（base64）→ 字节数组；小程序里用 wx.base64ToArrayBuffer，Node 测试里用 Buffer */
function fromBase64(b64) {
  if (!b64) return null;
  try {
    if (typeof wx !== 'undefined' && wx.base64ToArrayBuffer) return Array.from(new Uint8Array(wx.base64ToArrayBuffer(b64)));
    return Array.from(Buffer.from(b64, 'base64'));
  } catch (e) {
    return null;
  }
}

/** 按模式生成二维码字节；mode: 'native'（默认）| 'image'。小票上的小程序码走 fromBase64，这里的两种方式留给普通链接二维码 */
function qrBytes(data, mode, paperWidth) {
  if (mode === 'image') return rasterBytes(data, 5, paperWidth === 48 ? 576 : 384);
  return nativeBytes(data, 6);
}

module.exports = { validData, matrixOf, nativeBytes, rasterBytes, qrBytes, fromBase64 };
