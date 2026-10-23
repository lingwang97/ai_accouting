// utils/poller.js — 页面轮询：防重叠 + 连续无变化自动放慢 + 用户操作后恢复
// task() 返回 true 表示数据有变化；抛错按无变化处理
// create(task, { base: 起始间隔 ms, slow: false 时固定间隔 })
// 放慢档：连续无变化约 1 分钟 → 2~3 倍；连续 5 分钟无变化 → 60 秒一次（新转账最多延迟 60 秒）；有变化 / 用户操作 / 切回页面立即恢复
const DEEP_IDLE_MS = 5 * 60 * 1000;
const DEEP_MS = 60 * 1000;
function create(task, opt) {
  const base = (opt && opt.base) || 10000;
  const fixed = opt && opt.slow === false;
  let timer = null;
  let stopped = true;
  let running = false;
  let idle = 0;
  let since = Date.now(); // 最近一次有变化 / 被唤醒的时间

  function interval() {
    if (fixed) return base;
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
      try { if (await task()) { idle = 0; since = Date.now(); } else idle++; } catch (e) { idle++; } finally { running = false; }
    }
    schedule();
  }
  return {
    start() { stopped = false; idle = 0; since = Date.now(); schedule(); },
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
    /** 用户操作 / 手动刷新后：恢复起始间隔 */
    kick() { idle = 0; since = Date.now(); if (!stopped) schedule(); },
    get active() { return !stopped; }
  };
}

module.exports = { create };
