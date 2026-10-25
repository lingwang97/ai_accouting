// utils/qrprint.js — 小票二维码的 ESC/POS 字节
// 小票上的小程序码由云端（payment.issueQr）生成并转成 GS v 0 光栅，这里只做 base64 → 字节（fromBase64）。
// nativeBytes（原生指令 GS ( k）留给以后的普通链接二维码（需备案域名），目前未启用。
// v3.59.1：去掉前端二维码矩阵库（qrcode-lib.js，约 56KB，主包）与前端光栅生成（rasterBytes / qrBytes），小程序码只能在云端生成，用不到。

const GS = 0x1d;

/** 只允许可打印 ASCII（链接都是 ASCII），长度 ≤ 120，防止二维码过大 */
function validData(s) {
  return typeof s === 'string' && /^[\x20-\x7e]{1,120}$/.test(s);
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

module.exports = { validData, nativeBytes, fromBase64 };
