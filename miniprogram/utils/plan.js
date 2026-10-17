// utils/plan.js — 当前套餐（付费订阅预留接口）
// 用法：await plan.load() 后 plan.has('warmup') / plan.limit('maxBooks')；目前所有功能均开放，未做限制
const req = require('./request.js');

let current = null; // { plan, name, features, expiresAt, isAdmin }

/** 拉取当前套餐（记账人跟随所服务的主家）；失败时按免费版处理 */
async function load(force) {
  if (current && !force) return current;
  try {
    current = await req.planGet();
  } catch (e) {
    current = { plan: 'free', name: '免费版', features: {}, expiresAt: null, isAdmin: false };
  }
  return current;
}

/** 功能开关：未定义的功能视为开放（预留阶段不限制） */
function has(feature) {
  const f = current && current.features && current.features[feature];
  return f === undefined ? true : !!f;
}

/** 额度：0 或未定义为不限 */
function limit(feature) {
  const n = current && current.features && Number(current.features[feature]);
  return n > 0 ? n : Infinity;
}

function reset() { current = null; }

module.exports = { load, has, limit, reset, get: () => current };
