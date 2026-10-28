// utils/qroff.js — 礼簿码离线副本的本机文件（v3.66.0 起 qrcode 页保存，见 pages/qrcode/qrcode.js saveOffline）
// 文件放在 wx.env.USER_DATA_PATH，名为 qroff_{礼簿 id 或 main}_{qr|pay}.png（pay 是收款码图片）；索引在页面缓存（cache.js 的 pc_qroff_*）。
// 切换身份、退出登录、清除数据时（app.resetIdentity）连同文件一起删掉，避免换了身份 / 换了人还留着上一位主家的收款码（v3.69.1）
const PREFIX = 'qroff_';

/** 删除本机保存的全部礼簿码离线副本文件；返回删除的个数（失败忽略） */
function clearFiles() {
  let n = 0;
  try {
    const fs = wx.getFileSystemManager();
    const dir = wx.env.USER_DATA_PATH;
    (fs.readdirSync(dir) || []).forEach(name => {
      if (String(name).indexOf(PREFIX) !== 0) return;
      try { fs.unlinkSync(`${dir}/${name}`); n++; } catch (e) { /* 已不存在 */ }
    });
  } catch (e) { /* 读目录失败：忽略 */ }
  return n;
}

module.exports = { PREFIX, clearFiles };
