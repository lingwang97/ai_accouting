// plans.js — 系统配置与付费订阅（预留）。源文件在 tools/cloud-shared/plans.js，
// 由 tools/sync_shared.py 复制到 system、warmer 云函数目录，勿在云函数目录里直接修改。
//
// 配置存 settings 集合（文档 id 即配置名）：
//   warmup  预热调度：{ enabled, mode: 'always' | 'paid', intervalMin, functions: [] }
//   plans   套餐定义（可选，覆盖下方默认值）：{ free: {...}, pro: {...} }
//   admins  管理员：{ openids: [] }（首次需在云开发控制台手动创建）
//   ads     流量主广告位：{ enabled, bannerUnit, hideFuneral, paidHide, slots: { 位置: 是否展示 } }
// 订阅存 subscriptions 集合，文档 id = 主家 openid：{ plan, expiresAt, source, updatedAt }
// 目前只有机构版（features.org）按套餐开放，其余功能不按套餐限制。
// 安全：settings / subscriptions 只由云函数写入（无 _openid）；带 _openid 的是客户端直接写库伪造的，一律忽略。

// export 首次调用要加载字体与 PDF 库，预热只唤醒实例、不加载这些，收益很小，不列入
const WARMABLE = ['login', 'account', 'records', 'payment', 'books', 'renqing'];

const DEFAULT_WARMUP = {
  enabled: true,
  mode: 'paid',       // always 始终预热 | paid 仅存在有效付费订阅时预热（默认，免费阶段不产生预热调用）
  intervalMin: 5,     // 5 / 10 / 15 / 30（调度器每 5 分钟触发一次，按间隔跳过）
  functions: ['login', 'account', 'records', 'payment', 'books']
};

/** 广告位（流量主）：默认关闭，开通流量主后在「系统设置」填广告单元 ID 再开启 */
const AD_SLOTS = {
  myreceipts: '宾客 · 我的随礼记录',
  receipt: '电子回执页',
  paySuccess: '宾客 · 随礼成功页',
  exportDone: '导出页底部',
  workbench: '工作台底部'
};
const DEFAULT_ADS = {
  enabled: false,
  bannerUnit: '',     // 广告单元 ID（adunit-xxxx），流量主后台创建
  hideFuneral: true,  // 白事礼簿相关页面不展示
  paidHide: true,     // 付费套餐不展示
  slots: { myreceipts: true, receipt: false, paySuccess: false, exportDone: true, workbench: false }
};

function normalizeAds(a) {
  const slots = {};
  Object.keys(AD_SLOTS).forEach(k => { slots[k] = !!((a.slots || {})[k]); });
  return {
    enabled: a.enabled === true,
    bannerUnit: /^adunit-[a-zA-Z0-9]{4,40}$/.test(String(a.bannerUnit || '')) ? a.bannerUnit : '',
    hideFuneral: a.hideFuneral !== false,
    paidHide: a.paidHide !== false,
    slots
  };
}

/**
 * 套餐定义：features 为功能开关 / 额度，后续付费功能按这里判断（plan.has / plan.limit）
 * 现阶段免费版也全部开放，等于不限制
 */
const DEFAULT_PLANS = {
  free: {
    name: '免费版',
    features: { warmup: true, maxBooks: 0, maxClerks: 0, exportPdf: true, receiptAppCode: true, org: false } // 0 = 不限；org 机构版
  },
  pro: {
    name: '专业版',
    features: { warmup: true, maxBooks: 0, maxClerks: 0, exportPdf: true, receiptAppCode: false, org: true }
  }
};

// 同一实例内缓存 30 秒（管理员、套餐、广告位几乎不变，省掉每次调用的读库）；本实例写入时立即失效
const SETTING_TTL = 30 * 1000;
const settingCache = new Map();

async function readSetting(db, id, def) {
  const hit = settingCache.get(id);
  if (hit && Date.now() - hit.at < SETTING_TTL) return { ...def, ...hit.data };
  let data = {};
  try {
    const d = (await db.collection('settings').doc(id).get()).data;
    if (!d._openid) { const { _id, ...rest } = d; data = rest; } // 带 _openid 的是客户端伪造，忽略
  } catch (e) { /* 尚未设置 */ }
  settingCache.set(id, { at: Date.now(), data });
  return { ...def, ...data };
}

async function writeSetting(db, id, data) {
  try { await db.createCollection('settings'); } catch (e) { /* 已存在 */ }
  await db.collection('settings').doc(id).set({ data: { ...data, updatedAt: new Date() } });
  settingCache.delete(id);
}

/** 规范化预热配置（管理员保存时校验） */
function normalizeWarmup(w) {
  const intervals = [5, 10, 15, 30];
  return {
    enabled: w.enabled !== false,
    mode: w.mode === 'always' ? 'always' : 'paid',
    intervalMin: intervals.includes(Number(w.intervalMin)) ? Number(w.intervalMin) : 5,
    functions: (Array.isArray(w.functions) ? w.functions : DEFAULT_WARMUP.functions).filter(f => WARMABLE.includes(f))
  };
}

async function isAdmin(db, openid) {
  const a = await readSetting(db, 'admins', { openids: [] });
  return Array.isArray(a.openids) && a.openids.includes(openid);
}

/** 主家当前套餐：无订阅或已过期为 free */
async function planOf(db, ownerOpenid) {
  const plans = await readSetting(db, 'plans', DEFAULT_PLANS);
  let sub = null;
  try { sub = (await db.collection('subscriptions').doc(ownerOpenid).get()).data; } catch (e) { /* 无订阅 */ }
  if (sub && sub._openid) sub = null; // 客户端伪造
  const active = sub && plans[sub.plan] && (!sub.expiresAt || new Date(sub.expiresAt) > new Date());
  const key = active ? sub.plan : 'free';
  return {
    plan: key,
    name: (plans[key] || {}).name || key,
    features: (plans[key] || {}).features || {},
    expiresAt: active ? (sub.expiresAt || null) : null
  };
}

module.exports = {
  WARMABLE, DEFAULT_WARMUP, DEFAULT_PLANS, AD_SLOTS, DEFAULT_ADS,
  readSetting, writeSetting, normalizeWarmup, normalizeAds, isAdmin, planOf
};
