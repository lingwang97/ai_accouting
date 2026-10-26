// utils/pollcfg.js — 待确认刷新频率（我的 → 高级功能）。设置存服务端 users.pollLevel（按人），这里只做本机缓存与取值
// 档位与 tools/cloud-shared/plans.js 的 POLL_LEVELS 一致：off 默认（10 秒起、自动放慢）/ low 8 秒 / mid 5 秒 / high 3 秒
// 只读家人、没有「确认收礼」权限的记账人不生效（服务端读取时也按 off）。
const KEY = 'poll_level';
const MS = { low: 8000, mid: 5000, high: 3000 };
const LEVELS = ['off', 'low', 'mid', 'high'];

function level() {
  const g = getApp().globalData;
  if (g.pollLevel === undefined) {
    let v = '';
    try { v = wx.getStorageSync(KEY); } catch (e) { /* 忽略 */ }
    g.pollLevel = LEVELS.indexOf(v) >= 0 ? v : 'off';
  }
  return g.pollLevel;
}

function set(v) {
  const l = LEVELS.indexOf(v) >= 0 ? v : 'off';
  getApp().globalData.pollLevel = l;
  try { wx.setStorageSync(KEY, l); } catch (e) { /* 忽略 */ }
}

/** 当前应使用的固定间隔（ms）；0 = 标准行为。身份未知（冷启动）时先按缓存，服务端会同步校正 */
function ms() {
  const g = getApp().globalData;
  if (g.role === 'viewer' || g.role === 'none') return 0;
  if (g.role === 'clerk' && !(g.perms && g.perms.indexOf('confirm') >= 0)) return 0;
  return MS[level()] || 0;
}

/** 每次启动 / 切换身份后向服务端同步一次（按权限与套餐校验后的值）；返回是否有变化 */
function sync() {
  const g = getApp().globalData;
  if (g._pollSyncVer === g.identityVer) return Promise.resolve(false);
  g._pollSyncVer = g.identityVer;
  const before = level();
  return require('./request.js').pollLevelGet().then(r => {
    set(r.pollLevel);
    return r.pollLevel !== before;
  }).catch(() => false);
}

module.exports = { LEVELS, MS, level, set, ms, sync };
