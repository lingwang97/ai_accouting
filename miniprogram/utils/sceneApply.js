// utils/sceneApply.js — 一键把场景预设同时套用到某本礼簿的电子回执与打印样式
const req = require('./request.js');
const scenes = require('./scenes.js');
const receipt = require('./receipt.js');
const printer = require('./printer.js');

/** 保留已选字段与纸宽，只替换标题、配色、印章、致谢语等场景相关项 */
async function applyScene(type, bookId) {
  const scene = scenes.byType(type);
  const r = await req.bookGetTpl(bookId);
  const curReceipt = receipt.normalizeTpl(r.receiptTpl, r.book.type);
  const curPrint = r.printTpl || printer.defaultTemplate(r.book.type, r.paperWidth);
  await req.bookSaveTpl(r.book._id, {
    receiptTpl: { ...curReceipt, ...scene.receipt },
    printTpl: { ...curPrint, ...scene.print }
  });
  printer.clearTemplateCache();
}

/** 弹窗询问是否套用（新建礼簿 / 修改事由类型后调用） */
function askApply(type, bookId) {
  const scene = scenes.byType(type);
  return new Promise(resolve => {
    wx.showModal({
      title: '套用场景样式',
      content: `是否将这本礼簿的电子回执和打印小票设为「${scene.label}」样式？（${scene.receipt.title}${type === 'funeral' ? '，素色无红章' : ''}）`,
      confirmText: '套用',
      cancelText: '暂不',
      success: async res => {
        if (!res.confirm) return resolve(false);
        try {
          await applyScene(type, bookId);
          wx.showToast({ title: '已套用', icon: 'success' });
          resolve(true);
        } catch (e) {
          resolve(false);
        }
      },
      fail: () => resolve(false)
    });
  });
}

module.exports = { applyScene, askApply };
