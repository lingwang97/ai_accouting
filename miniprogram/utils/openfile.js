// utils/openfile.js — 下载云存储文件，以可读文件名保存后打开预览（右上角可转发 / 保存）
const KEEP_MS = 24 * 3600 * 1000; // 保存在本地的导出文件保留 1 天，之后下次下载时顺带清理

/** 清理 USER_DATA_PATH 下超过 1 天的 pdf / xlsx（每次启动只扫一次，失败忽略） */
let swept = false;
function sweep(keepName) {
  if (swept) return;
  swept = true;
  try {
    const fs = wx.getFileSystemManager();
    const now = Date.now();
    fs.readdirSync(wx.env.USER_DATA_PATH).forEach(name => {
      if (name === keepName || !/\.(pdf|xlsx)$/i.test(name)) return;
      try {
        const p = `${wx.env.USER_DATA_PATH}/${name}`;
        if (now - fs.statSync(p).lastModifiedTime * 1000 > KEEP_MS) fs.unlinkSync(p);
      } catch (e) { /* 忽略 */ }
    });
  } catch (e) { /* 忽略 */ }
}

function download(fileID, fileName) {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      fileID,
      success: res => {
        // 文件名去掉 & 空格等特殊字符，部分安卓机打开含这些字符的路径会失败
        const safe = String(fileName).replace(/[\\/:*?"<>|&#%\s]+/g, '_');
        const target = `${wx.env.USER_DATA_PATH}/${safe}`;
        const fs = wx.getFileSystemManager();
        sweep(safe);
        try { fs.unlinkSync(target); } catch (e) { /* 不存在 */ }
        fs.saveFile({
          tempFilePath: res.tempFilePath,
          filePath: target,
          success: () => resolve(target),
          fail: () => resolve(res.tempFilePath) // 存储空间不足等，退回临时路径
        });
      },
      fail: () => {
        wx.showToast({ title: '下载失败，请重试', icon: 'none' });
        reject(new Error('download failed'));
      }
    });
  });
}

function open(filePath, fileName) {
  wx.openDocument({
    filePath,
    fileType: /\.xlsx$/i.test(fileName) ? 'xlsx' : 'pdf',
    showMenu: true, // 右上角菜单可转发给好友 / 文件传输助手
    fail: () => wx.showModal({ title: '提示', content: '文件已生成，但当前设备无法预览', showCancel: false })
  });
}

/** 导出失败时用弹窗显示完整原因（toast 会截断） */
function showError(e) {
  const msg = (e && e.message) || '';
  if (msg && msg !== 'download failed') wx.showModal({ title: '导出未成功', content: msg, showCancel: false });
}

module.exports = { download, open, showError };
