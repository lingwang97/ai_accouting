// utils/poller.js — 页面轮询：防重叠 + 连续无变化自动放慢 + 用户操作后恢复
// task() 返回 true 表示数据有变化；抛错按无变化处理
// create(task, { base: 起始间隔 ms, slow: false 时固定间隔 })
function create(task, opt) {
  const base = (opt && opt.base) || 10000;
  const fixed = opt && opt.slow === false;
  let timer = null;
  let stopped = true;
  let running = false;
  let idle = 0;

  function interval() {
    if (fixed) return base;
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
      try { idle = (await task()) ? 0 : idle + 1; } catch (e) { idle++; } finally { running = false; }
    }
    schedule();
  }
  return {
    start() { stopped = false; idle = 0; schedule(); },
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
    /** 用户操作 / 手动刷新后：恢复起始间隔 */
    kick() { idle = 0; if (!stopped) schedule(); },
    get active() { return !stopped; }
  };
}

module.exports = { create };
