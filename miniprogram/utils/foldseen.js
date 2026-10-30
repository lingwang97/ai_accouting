// utils/foldseen.js — 可折叠分组「出现新记录自动展开一次」的判断（待确认页「最近标记未收到」，v3.77.2）
// seen：之前见过的记录 _id；cur：这次列表里的 _id；folded：当前是否收起
// 返回 { folded, seen, opened }：出现没见过的 _id 时展开（opened=true），seen 合并并只保留最近 200 个
function next(seen, cur, folded) {
  const old = Array.isArray(seen) ? seen : [];
  const set = new Set(old);
  const fresh = (cur || []).filter(id => !set.has(id));
  if (!fresh.length) return { folded: !!folded, seen: old, opened: false };
  return { folded: false, seen: old.concat(fresh).slice(-200), opened: !!folded };
}

module.exports = { next };
