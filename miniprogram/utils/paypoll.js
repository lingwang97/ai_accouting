// utils/paypoll.js — 宾客等待页（pay）轮询退避（v3.71.0）：前 1 分钟每 3 秒，之后每 5 秒，3 分钟后每 10 秒，最长 10 分钟后停止
const MAX_MS = 10 * 60 * 1000;

/** 已等待 elapsedMs 毫秒时，距离下一次查询的间隔（毫秒） */
function delay(elapsedMs) {
  if (elapsedMs < 60 * 1000) return 3000;
  if (elapsedMs < 180 * 1000) return 5000;
  return 10000;
}

module.exports = { MAX_MS, delay };
