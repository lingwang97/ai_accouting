// wxaraster.js — 小程序码图片（PNG / JPEG）→ 热敏打印机 1 位光栅（GS v 0）
// 放在 payment 云函数里：小程序码在这里生成（云调用）或由 system 经 HTTPS 取回后交给这里，解码转换只在云端做一次并缓存，
// 前端不需要 canvas、也不引入图片库；pngjs / jpeg-js 都是纯 JS（MIT / BSD），只有 payment 依赖，不增加小程序包体积。
// getUnlimited 实际返回的格式文档里没有保证（常见为 JPEG，透明背景时为 PNG），所以两种都支持，按文件头判断。
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const PRINT_DOTS = 280; // 打印宽度（点）：58mm 机 384 点宽，280 点约 3.5cm，与小程序码最小宽度 280px 一致，不缩放，边缘最清晰

function decode(buf) {
  if (!buf || buf.length < 8) throw new Error('decode:empty');
  if (buf[0] === 0x89 && buf[1] === 0x50) return PNG.sync.read(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  throw new Error('decode:format');
}

/** 按灰度二值化（阈值 128，透明视为白），缩放（面积平均）到 dots 点宽；返回 { bytes: Buffer(GS v 0 全部字节), wBytes, h, width, dark } */
function toRaster(buf, dots, threshold) {
  const img = decode(buf);
  const W = dots || PRINT_DOTS;
  const T = threshold || 128;
  const sw = img.width, sh = img.height;
  if (!sw || !sh) throw new Error('decode:size');
  const H = Math.max(1, Math.round(sh * W / sw));
  const gray = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    const a = img.data[i * 4 + 3] / 255;
    const g = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
    gray[i] = g * a + 255 * (1 - a);
  }
  const wBytes = Math.ceil(W / 8);
  const out = Buffer.alloc(8 + wBytes * H);
  out.set([0x1d, 0x76, 0x30, 0x00, wBytes & 0xff, wBytes >> 8, H & 0xff, H >> 8]);
  let dark = 0;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * sh / H), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sh / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * sw / W), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sw / W));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) for (let xx = x0; xx < x1 && xx < sw; xx++) { sum += gray[yy * sw + xx]; n++; }
      if (sum / n < T) { out[8 + y * wBytes + (x >> 3)] |= 0x80 >> (x & 7); dark++; }
    }
  }
  const ratio = dark / (W * H);
  if (ratio < 0.03 || ratio > 0.85) throw new Error('decode:blank'); // 全白 / 全黑：不是有效的码图，别打印
  return { bytes: out, wBytes, h: H, width: W, dark: ratio };
}

module.exports = { toRaster, decode, PRINT_DOTS };
