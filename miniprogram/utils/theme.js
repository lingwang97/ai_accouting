// utils/theme.js — 主题色：主家在「主家信息」选的主题色（未选过为中国红）；白事礼簿一律素灰（礼俗）
// 页面根节点写入 style="{{themeStyle}}" 覆盖 CSS 变量 --primary；导航栏与底部菜单同步
const DEFAULT = '#C8161D';
const GRAY = '#4A4A4A';
// 预设主题色 → 底部菜单选中图标的颜色版本（assets/icons/*-{key}.svg，由 tools/gen_icons.py 生成）
const ICON_KEYS = { '#C8161D': 'r', '#4A4A4A': 'd', '#07C160': 'n', '#B8860B': 'y', '#2B7FFF': 'b', '#333333': 'k' };
const STORE_KEY = 'theme_primary';
// 主家可选的预设主题色（外观设置页使用）
const PRESET_COLORS = ['#C8161D', '#07C160', '#B8860B', '#2B7FFF', '#333333'];

function hexSoft(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, .1)`;
}

function make(primary) {
  const p = /^#[0-9a-fA-F]{6}$/.test(primary || '') ? primary.toUpperCase() : DEFAULT;
  return { primary: p, soft: hexSoft(p), icon: ICON_KEYS[p] || 'r' };
}

/** 主家选的主题色（未选过返回空） */
function hostPrimary() {
  const app = getApp();
  let p = app && app.globalData.themePrimary;
  if (p === undefined || p === null) {
    try { p = wx.getStorageSync(STORE_KEY) || ''; } catch (e) { p = ''; }
    if (app) app.globalData.themePrimary = p;
  }
  return p || '';
}

/** 某个事由的主题：白事素灰，其余用主家主题色 */
function forType(type, primary) {
  if (type === 'funeral') return make(GRAY);
  return make(primary === undefined ? hostPrimary() : primary);
}

/** 当前主题（按 globalData.bookType） */
function current() {
  const app = getApp();
  return forType(app && app.globalData.bookType);
}

/** 记下当前主家的主题色（主家在主家信息页选过才算；登录、切换身份、保存主家信息后调用） */
function setAccount(account) {
  const t = account && account.theme;
  const p = t && t.chosen && t.primary ? t.primary : '';
  const app = getApp();
  app.globalData.themePrimary = p;
  try { wx.setStorageSync(STORE_KEY, p); } catch (e) { /* 忽略 */ }
}

/** 页面根节点用的样式串 */
const styleOf = t => `--primary:${t.primary};--primary-soft:${t.soft};`;

/**
 * 应用到页面：记下礼簿类型，设置 themeStyle、导航栏颜色，并刷新底部菜单
 * @param {object} page 页面实例
 * @param {string} [bookType] 不传则沿用当前
 */
function apply(page, bookType) {
  const app = getApp();
  if (bookType !== undefined) app.globalData.bookType = bookType || 'other';
  const t = current();
  // themeIcon：主题图标后缀（bell-{themeIcon}.svg 等）；themePrimary：switch 等原生组件的颜色（不能用 CSS 变量）
  if (page && (page.data.themeStyle !== styleOf(t) || page.data.themeIcon !== t.icon)) {
    page.setData({ themeStyle: styleOf(t), themeIcon: t.icon, themePrimary: t.primary });
  }
  wx.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: t.primary, fail() {} });
  app.refreshTabBar();
  return t;
}

/** 只设导航栏颜色（不套页面变量）：不走 apply 的页面（登录、邀请、我的随礼记录）也跟随当前主题 */
function applyNav() {
  wx.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: current().primary, fail() {} });
}

module.exports = { applyNav, forType, current, styleOf, apply, setAccount, make, PRESET_COLORS, DEFAULT };
