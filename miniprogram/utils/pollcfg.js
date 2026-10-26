// utils/pollcfg.js — 待确认刷新频率（我的 → 高级功能）。设置存服务端 users.pollLevel（按人），这里只做本机缓存与取值
// 档位与 tools/cloud-shared/plans.js 的 POLL_LEVELS 一致：off 默认（10 秒起、自动放慢）/ low 8 秒 / mid 5 秒 / high 3 秒
// 只读家人、没有「确认收礼」权限的记账人不生效（服务端读取时也按 off）。
const KEY = 'poll_level';
const PEAK_KEY = 'poll_peak';
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

/** 办事日高峰模式的到期时间（毫秒，0 = 未开启）：服务端按权限 / 套餐校验后下发，到期由本机时间判断 */
function peakUntil() {
  const g = getApp().globalData;
  if (g.peakUntil === undefined) {
    let v = 0;
    try { v = Number(wx.getStorageSync(PEAK_KEY)) || 0; } catch (e) { /* 忽略 */ }
    g.peakUntil = v;
  }
  return g.peakUntil;
}
/** 高峰模式是否正生效（身份不符 / 已到期为 false） */
function peakOn() {
  const g = getApp().globalData;
  if (g.role === 'viewer' || g.role === 'none') return false;
  if (g.role === 'clerk' && !(g.perms && g.perms.indexOf('confirm') >= 0)) return false;
  return peakUntil() > Date.now();
}

function set(v, peak) {
  const g = getApp().globalData;
  const l = LEVELS.indexOf(v) >= 0 ? v : 'off';
  g.pollLevel = l;
  try { wx.setStorageSync(KEY, l); } catch (e) { /* 忽略 */ }
  if (peak !== undefined) { // 不传时保持原值（只改档位的调用不动高峰状态）
    g.peakUntil = Number(peak) > 0 ? Number(peak) : 0;
    try { wx.setStorageSync(PEAK_KEY, g.peakUntil); } catch (e) { /* 忽略 */ }
  }
}

/** 当前应使用的固定间隔（ms）；0 = 标准行为。身份未知（冷启动）时先按缓存，服务端会同步校正 */
function ms() {
  const g = getApp().globalData;
  if (g.role === 'viewer' || g.role === 'none') return 0;
  if (g.role === 'clerk' && !(g.perms && g.perms.indexOf('confirm') >= 0)) return 0;
  if (peakOn()) return MS.high; // 高峰模式期间固定 3 秒；到期后回到用户自己保存的档位
  return MS[level()] || 0;
}

/** 每次启动 / 切换身份后向服务端同步一次（按权限与套餐校验后的值）；返回是否有变化 */
function sync() {
  const g = getApp().globalData;
  if (g._pollSyncVer === g.identityVer) return Promise.resolve(false);
  g._pollSyncVer = g.identityVer;
  const before = level();
  const beforePeak = peakOn();
  return require('./request.js').pollLevelGet().then(r => {
    set(r.pollLevel, r.peakUntil || 0);
    return r.pollLevel !== before || peakOn() !== beforePeak;
  }).catch(() => false);
}

module.exports = { LEVELS, MS, level, set, ms, sync, peakUntil, peakOn };
