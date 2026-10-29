// utils/pollcfg.js — 工作台 / 待确认 / 礼簿页的轮询间隔（v3.70.0 智能刷新）
// 不再有手动「工作台刷新频率」档位（原 users.pollLevel；云端读取恒返回 'off'，旧前端也按标准刷新）。
// 现在的规则（见 utils/poller.js）：
//   标准：10 秒起，无变化逐步放慢到 60 秒；
//   智能刷新：能确认收礼的人（主家、有「确认收礼」权限的记账人）检测到新转账后 10 分钟内固定 5 秒（BOOST_MS）；
//   办事日高峰模式（会员，主家开启，记账人跟随）：到期前固定 3 秒（PEAK_MS），优先级最高；
//   只读家人：固定 30 秒（页面自己的 POLL_MS_READONLY），不加速。
const PEAK_KEY = 'poll_peak';
const BOOST_MS = 5000;
const PEAK_MS = 3000;

/** 当前身份能否确认收礼（智能刷新、高峰模式只对这些人生效） */
function canConfirm() {
  const g = getApp().globalData;
  if (g.role === 'owner') return true;
  return g.role === 'clerk' && !!(g.perms && g.perms.indexOf('confirm') >= 0);
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
  return canConfirm() && peakUntil() > Date.now();
}

/** 写入高峰到期时间（第一个参数是旧的档位，已不使用，保留参数位置兼容旧调用） */
function set(_unusedLevel, peak) {
  if (peak === undefined) return;
  const g = getApp().globalData;
  g.peakUntil = Number(peak) > 0 ? Number(peak) : 0;
  try { wx.setStorageSync(PEAK_KEY, g.peakUntil); } catch (e) { /* 忽略 */ }
}

/** 加速间隔：能确认收礼的人为 5 秒，其余 0（不加速） */
function boostMs() { return canConfirm() ? BOOST_MS : 0; }
/** 高峰间隔：能确认收礼的人为 3 秒（是否生效由 peakOn 判断），其余 0 */
function peakMs() { return canConfirm() ? PEAK_MS : 0; }

/** 每次启动 / 切换身份后向服务端同步一次高峰到期；返回高峰状态是否有变化 */
function sync() {
  const g = getApp().globalData;
  if (g._pollSyncVer === g.identityVer) return Promise.resolve(false);
  g._pollSyncVer = g.identityVer;
  const before = peakOn();
  return require('./request.js').pollLevelGet().then(r => {
    set(null, r.peakUntil || 0);
    return peakOn() !== before;
  }).catch(() => false);
}

/** 服务端已随工作台返回高峰到期（第一个参数为旧档位，忽略）：直接写入并记为本身份已同步；返回高峰状态是否有变化 */
function apply(_unusedLevel, peak) {
  const g = getApp().globalData;
  const before = peakOn();
  set(null, peak || 0);
  g._pollSyncVer = g.identityVer;
  return peakOn() !== before;
}

module.exports = { BOOST_MS, PEAK_MS, canConfirm, peakUntil, peakOn, set, boostMs, peakMs, sync, apply };
