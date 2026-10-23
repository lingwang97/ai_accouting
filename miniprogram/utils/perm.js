// utils/perm.js — 记账人权限：每位记账人有各自的权限列表（主家拥有全部权限，家人共享没有任何权限）
// 页面按权限显示入口；服务端同样校验，这里只决定显示

const NAMES = {
  confirm: '确认收礼',
  desk: '礼台记账',
  show: '礼簿码与打印',
  export: '对账与导出',
  paycode: '申请更换收款码',
  style: '回执与打印样式',
  members: '邀请与管理记账人',
  void: '作废已入簿礼金',
  books: '管理礼簿',
  info: '修改主家信息'
};
const ALL = Object.keys(NAMES);
// 新邀请记账人的默认权限
const DEFAULT = ['confirm', 'desk', 'show', 'export', 'paycode', 'style', 'members'];
// 一键模板
const TEMPLATES = {
  礼台记账员: ['confirm', 'desk', 'show', 'export', 'paycode'],
  管理助手: ALL
};

/** 当前身份是否有权限 p：主家永远有；读取 globalData.perms（身份刷新时写入） */
function can(p) {
  const g = getApp().globalData;
  if (g.role === 'owner') return true;
  return !!(g.perms && g.perms.indexOf(p) >= 0);
}

/** 按权限列表生成页面用的布尔表 { confirm: true, ... } */
function map(perms, role) {
  const m = {};
  ALL.forEach(k => { m[k] = role === 'owner' || !!(perms && perms.indexOf(k) >= 0); });
  return m;
}

/** 当前身份的权限布尔表 */
function current() {
  const g = getApp().globalData;
  return map(g.perms, g.role);
}

/**
 * 页面权限守卫（onLoad 里 `if (!(await perm.guard(...))) return;`）：没有权限提示 msg 并返回上一页
 * msg 与服务端拒绝时的文案保持一致；opts.viewer=true 表示家人共享（只读）也可进入（服务端允许的只读功能）
 * 身份读取失败 / 尚无主家信息时不拦（交给服务端校验）
 */
async function guard(p, msg, opts) {
  const role = await getApp().ensureRole();
  if (!role || role === 'none') return true;
  if (role === 'viewer' ? !!(opts && opts.viewer) : can(p)) return true;
  wx.showToast({ title: msg, icon: 'none', duration: 1500 });
  setTimeout(() => {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  }, 1500);
  return false;
}

module.exports = { can, map, current, guard, NAMES, ALL, DEFAULT, TEMPLATES };
