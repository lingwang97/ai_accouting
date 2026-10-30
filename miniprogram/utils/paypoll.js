// utils/paypoll.js — 宾客等待页（pay）轮询退避（v3.75.0）：前 1 分钟每 5 秒，1～3 分钟每 10 秒，3～6 分钟每 20 秒，之后每 30 秒，10 分钟后停止
const MAX_MS = 10 * 60 * 1000;

/** 已等待 elapsedMs 毫秒时，距离下一次查询的间隔（毫秒） */
function delay(elapsedMs) {
  if (elapsedMs < 60 * 1000) return 5000;
  if (elapsedMs < 180 * 1000) return 10000;
  if (elapsedMs < 360 * 1000) return 20000;
  return 30000;
}

module.exports = { MAX_MS, delay };
