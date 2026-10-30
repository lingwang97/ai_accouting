// 宾客等待页查询状态的实例内短缓存（v3.75.0）
// 只缓存返回给宾客的脱敏结果；key 含 openid，不同人不共享；本实例内任何写操作后整体清空；
// 多实例下最多延迟 TTL_MS（3 秒）看到最新状态
const TTL_MS = 3000;
const MAX_SIZE = 2000;
const map = new Map(); // key -> { exp, value }（Map 保持插入顺序，满了先删最早的）

const keyOf = (openid, rid) => String(openid) + '|' + String(rid);

function get(openid, rid, now) {
  const k = keyOf(openid, rid);
  const e = map.get(k);
  if (!e) return null;
  if (e.exp <= (now || Date.now())) { map.delete(k); return null; }
  return e.value;
}

function set(openid, rid, value, now) {
  const t = now || Date.now();
  const k = keyOf(openid, rid);
  map.delete(k);
  if (map.size >= MAX_SIZE) {
    for (const [kk, e] of map) if (e.exp <= t) map.delete(kk); // 先清过期的
    while (map.size >= MAX_SIZE) map.delete(map.keys().next().value); // 仍满：删最早的
  }
  map.set(k, { exp: t + TTL_MS, value });
}

function clear() { map.clear(); }

module.exports = { TTL_MS, MAX_SIZE, get, set, clear, size: () => map.size };
