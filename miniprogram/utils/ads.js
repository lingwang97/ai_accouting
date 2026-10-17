// utils/ads.js — 流量主广告位：按位置、礼簿事由（白事不展示）、套餐（付费不展示）决定是否展示
// 配置由管理员在「系统设置」修改，本地缓存 10 分钟
const req = require('./request.js');
const plan = require('./plan.js');

const TTL = 10 * 60 * 1000;
let cache = null; // { cfg, at }

async function config() {
  if (cache && Date.now() - cache.at < TTL) return cache.cfg;
  let cfg = { enabled: false };
  try { cfg = await req.adsConfig(); } catch (e) { /* 读不到就不展示 */ }
  cache = { cfg, at: Date.now() };
  return cfg;
}

/**
 * 该位置应展示的广告单元 ID；不展示返回 ''
 * @param {string} slot 位置（myreceipts / receipt / paySuccess / exportDone / workbench）
 * @param {string} [bookType] 相关礼簿的事由，白事不展示
 */
async function unitFor(slot, bookType) {
  const cfg = await config();
  if (!cfg.enabled || !cfg.bannerUnit || !(cfg.slots || {})[slot]) return '';
  if (cfg.hideFuneral && bookType === 'funeral') return '';
  if (cfg.paidHide) {
    const p = await plan.load();
    if (p && p.plan && p.plan !== 'free') return '';
  }
  return cfg.bannerUnit;
}

function reset() { cache = null; }

module.exports = { unitFor, reset };
