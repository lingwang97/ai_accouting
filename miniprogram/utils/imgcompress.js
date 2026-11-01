// utils/imgcompress.js — 收款码图片压缩（v3.72.1）：主家信息、礼簿编辑、首次设置三处选图后共用
// 原图不超过 300KB 直接用（二维码最清晰）；否则 wx.compressImage 质量 80，仍超过 300KB 再压一次（质量 60）。
// 云端内容安全只审核 1MB 以内的图片（secure.js），手机原图常有 2~5MB，压缩后才能被审核，宾客打开也更快。
// 任何一步失败（低版本基础库没有 compressImage、压缩出错）都用上一步的图，不阻断上传。
const LIMIT = 300 * 1024;

function compress(src, quality) {
  return new Promise(resolve => {
    if (typeof wx.compressImage !== 'function') return resolve('');
    wx.compressImage({ src, quality, success: r => resolve(r.tempFilePath || ''), fail: () => resolve('') });
  });
}

function sizeOf(path) {
  return new Promise(resolve => {
    try {
      wx.getFileSystemManager().getFileInfo({ filePath: path, success: r => resolve(r.size), fail: () => resolve(-1) });
    } catch (e) { resolve(-1); }
  });
}

/**
 * @param {string} path 选图得到的临时路径
 * @param {number} [size] 原图大小（chooseMedia 的 tempFiles[i].size），没有时自己读
 * @returns {Promise<string>} 用于上传的临时路径
 */
async function payCode(path, size) {
  let sz = typeof size === 'number' && size > 0 ? size : await sizeOf(path);
  if (sz >= 0 && sz <= LIMIT) return path;
  let out = path;
  const c1 = await compress(out, 80);
  if (c1) { out = c1; sz = await sizeOf(out); }
  if (c1 && sz > LIMIT) {
    const c2 = await compress(out, 60);
    if (c2) out = c2;
  }
  return out;
}

// v3.79.0 封面照片：压到 1.5MB 以内（v3.80.0 由 900KB 放宽，整页封面更清晰；云端内容审核只审 1MB 以内，1~1.5MB 的照片跳过审核）。质量 80 -> 60 -> 40 逐级压；
// 任何一步失败用上一步的图；最终超过 3MB 返回空串（调用方提示换图）。同时统一转成 JPG（compressImage 输出 JPG）
const COVER_LIMIT = 1.5 * 1024 * 1024;
const COVER_HARD = 3 * 1024 * 1024;
/** 是不是 JPG：读文件头 2 字节（FF D8）；读不到（低版本不支持 position / length）按扩展名判断 */
function isJpeg(path) {
  return new Promise(resolve => {
    const byExt = () => resolve(/\.jpe?g$/i.test(String(path || '')));
    try {
      wx.getFileSystemManager().readFile({
        filePath: path, position: 0, length: 2,
        success: r => { const u = new Uint8Array(r.data); resolve(u.length >= 2 ? (u[0] === 0xff && u[1] === 0xd8) : false); },
        fail: byExt
      });
    } catch (e) { byExt(); }
  });
}

async function cover(path, size) {
  let out = path;
  let sz = typeof size === 'number' && size > 0 ? size : await sizeOf(path);
  // v3.83.2：已经是 JPG 且不超过 1.5MB 的照片不再重新压缩（二次压缩只会掉画质）；PNG / 超限的照旧压缩转 JPG
  if (sz > 0 && sz <= COVER_LIMIT && await isJpeg(path)) return path;
  for (const q of [80, 60, 40]) {
    const c = await compress(out, q);
    if (!c) break;
    out = c;
    sz = await sizeOf(out);
    if (sz >= 0 && sz <= COVER_LIMIT) break;
  }
  if (sz > COVER_HARD) return '';
  return out;
}

module.exports = { payCode, cover, isJpeg, LIMIT, COVER_LIMIT, COVER_HARD };
