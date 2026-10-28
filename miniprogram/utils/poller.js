// utils/poller.js — 页面轮询：防重叠 + 智能刷新（有变化后加速一段时间）+ 连续无变化自动放慢 + 用户操作后恢复
// task() 返回 true 表示数据有变化；抛错按无变化处理
// create(task, { base: 标准起始间隔 ms, slow: false 时固定 base（只读家人）, boost: 加速间隔 ms（0 / 不传 = 不加速）,
//                peak: 高峰间隔 ms, hold: () => boolean 返回 true 时固定 peak（办事日高峰模式，优先级最高） })
// boost / peak 也可以传函数（每次排定时取值）：身份在页面停留期间才确定时（冷启动）不用重建轮询
// 智能刷新（v3.70.0，取代手动「工作台刷新频率」档位）：
//   检测到变化（新转账等）后 BOOST_WINDOW_MS（10 分钟）内固定 boost（5 秒）一次；加速窗口是全局的（工作台、待确认、礼簿页共用，换页面不丢）
//   窗口外按标准：base 起，约 1 分钟无变化 → 2~3 倍，连续 5 分钟无变化 → 60 秒一次
//   kick（用户操作 / 回到页面 / 手动刷新）：恢复为标准起始间隔 base；加速窗口仍有效时仍是 boost
//   高峰模式（hold() 为 true）：固定 peak（3 秒），不放慢
const DEEP_IDLE_MS = 5 * 60 * 1000;
const DEEP_MS = 60 * 1000;
const BOOST_WINDOW_MS = 10 * 60 * 1000;

let boostUntil = 0; // 加速窗口截止时间（全局：任一页面检测到变化都会让各页加速）

/** 加速窗口是否有效 */
function boosting() { return boostUntil > Date.now(); }
/** 开启 / 延长加速窗口（检测到变化时调用） */
function boostNow() { boostUntil = Date.now() + BOOST_WINDOW_MS; }
/** 清除加速窗口（切换身份 / 退出登录、测试用） */
function resetBoost() { boostUntil = 0; }

function create(task, opt) {
  const base = (opt && opt.base) || 10000;
  const fixed = opt && opt.slow === false;
  const num = v => { const n = typeof v === 'function' ? v() : v; return n > 0 ? n : 0; };
  const boostOf = () => num(opt && opt.boost);
  const peakOf = () => num(opt && opt.peak);
  const hold = (opt && typeof opt.hold === 'function') ? opt.hold : null;
  let timer = null;
  let stopped = true;
  let running = false;
  let idle = 0;
  let since = Date.now(); // 最近一次有变化 / 被唤醒的时间

  function interval() {
    if (fixed) return base;
    const peak = peakOf(), boost = boostOf();
    if (peak && hold && hold()) return peak; // 高峰模式：固定 3 秒
    if (boost && boosting()) return boost;   // 智能刷新：有变化后 10 分钟内固定 5 秒
    if (Date.now() - since >= DEEP_IDLE_MS) return Math.max(DEEP_MS, base * 3); // 5 分钟无变化
    if (idle >= 12) return base * 3; // 约 1 分钟无变化：放慢到 3 倍
    if (idle >= 6) return base * 2;
    return base;
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped) return;
    timer = setTimeout(tick, interval());
  }
  async function tick() {
    timer = null;
    if (stopped) return;
    if (!running) { // 上一次还没回来：本轮跳过，避免请求叠加
      running = true;
      try {
        if (await task()) {
          idle = 0; since = Date.now();
          if (boostOf() && !fixed) boostNow();
        } else idle++;
      } catch (e) { idle++; } finally { running = false; }
    }
    schedule();
  }
  return {
    start() { stopped = false; idle = 0; since = Date.now(); schedule(); },
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
    /** 用户操作 / 手动刷新后：恢复标准起始间隔（加速窗口仍有效时为加速间隔） */
    kick() { idle = 0; since = Date.now(); if (!stopped) schedule(); },
    get active() { return !stopped; },
    /** 下一次的间隔（测试 / 调试用） */
    get nextMs() { return interval(); }
  };
}

module.exports = { create, BOOST_WINDOW_MS, DEEP_MS, boosting, boostNow, resetBoost };
