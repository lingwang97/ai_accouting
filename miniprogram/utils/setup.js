// utils/setup.js — 新用户引导：登录后选的身份（intent）与主家创建向导的草稿（只存本机）
// intent：host 办事收礼 | guest 去随礼 | clerk 帮别人记账；未选为空
// 草稿：{ name, payCodeFileID, book: { name, type, date, location } }；收款码可以先跳过，主家信息要有收款码才能创建，
// 所以跳过时先存草稿，首页显示进度卡片，补上收款码后再创建
const INTENT_KEY = 'start_intent';
const DRAFT_KEY = 'host_draft';

const read = (k, d) => { try { return wx.getStorageSync(k) || d; } catch (e) { return d; } };
const write = (k, v) => { try { wx.setStorageSync(k, v); } catch (e) { /* 忽略 */ } };
const remove = k => { try { wx.removeStorageSync(k); } catch (e) { /* 忽略 */ } };

module.exports = {
  intent: () => read(INTENT_KEY, ''),
  setIntent: v => (v ? write(INTENT_KEY, v) : remove(INTENT_KEY)),
  draft: () => read(DRAFT_KEY, null),
  saveDraft: d => write(DRAFT_KEY, d),
  clearDraft: () => remove(DRAFT_KEY),
  /** 进度：三步各自是否完成 */
  progress(d) {
    d = d || {};
    return { name: !!d.name, code: !!d.payCodeFileID, book: !!(d.book && d.book.name) };
  }
};
