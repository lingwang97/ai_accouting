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
// qrcode：办事当天出示礼簿码（v3.67.0）
const WARMABLE = ['login', 'account', 'records', 'payment', 'books', 'renqing', 'qrcode'];

const DEFAULT_WARMUP = {
  enabled: true,
  mode: 'paid',       // always 始终预热 | paid 仅存在有效付费订阅（或有人开着高峰模式）时预热（默认）| peak 仅有人开着办事日高峰模式时预热
  intervalMin: 5,     // 5 / 10 / 15 / 30（调度器每 5 分钟触发一次，按间隔跳过）
  functions: ['login', 'account', 'records', 'payment', 'books', 'renqing', 'qrcode'] // v3.67.0 起默认含往来、礼簿码；已保存的 settings.warmup 不迁移，由管理员手动勾选
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
    features: { warmup: true, maxBooks: 3, maxClerks: 3, exportPdf: true, receiptAppCode: true, org: false, fastRefresh: true, refreshMinSec: 8,
      pdfThemePremium: true, receiptStylePremium: true, trashDays: 15, peakMode: false, bookMax: 3000 } // refreshMinSec（v3.69.0）：工作台刷新最快几秒一次，免费 8（可选标准 / 8 秒），会员 3（5 秒 / 3 秒）；缺项 = 3（全部开放，兼容旧 settings/plans 文档） // v3.66.7 免费版：最多 3 本礼簿、3 位记账人，回收站最长 15 天（30 / 60 天仅会员）；0 = 不限；peakMode 办事日高峰模式（v3.65.1 起仅会员：free 为 false，pro 为 true）；bookMax 传统礼簿 PDF 单次最多笔数（免费 3000，专业版 6000；缺项 = 3000）；trashDays 回收站可选的最长保留天数（缺项 / 0 视为 60，即全部开放——兼容 settings/plans 里没有该项的旧文档）；org 机构版；fastRefresh 待确认高频刷新；pdfThemePremium 礼簿 PDF 会员主题 / 自定义 / 宋体毛笔 / 尾页设置；receiptStylePremium 电子回执会员样式（现阶段全部免费开放，只有 === false 才限制）
  },
  pro: {
    name: '专业版',
    features: { warmup: true, maxBooks: 0, maxClerks: 0, exportPdf: true, receiptAppCode: false, org: true, fastRefresh: true, refreshMinSec: 3,
      pdfThemePremium: true, receiptStylePremium: true, trashDays: 60, peakMode: true, bookMax: 6000 }
  }
};

/**
 * 待确认刷新频率（我的 → 高级功能）：存 users.pollLevel，取值只能是下面几档，其余一律按 off。
 * 套餐 features.fastRefresh === false 时不能设置高档，读取时也按 off；v3.69.0 起另按 features.refreshMinSec 限制最快一档（见 refreshMinSec）。
 * 毫秒数只有前端用（miniprogram/utils/pollcfg.js 同表）。
 */
const POLL_LEVELS = ['off', 'low', 'mid', 'high'];
const POLL_SEC = { low: 8, mid: 5, high: 3 }; // 各档固定间隔（秒），与 miniprogram/utils/pollcfg.js 的 MS 一致
function normalizePollLevel(v) { return POLL_LEVELS.includes(v) ? v : 'off'; }
function fastRefreshAllowed(features) { return !features || features.fastRefresh !== false; }
/**
 * v3.69.0 套餐允许的最快刷新间隔（秒）：fastRefresh === false 时只能用标准档（Infinity）；
 * 否则 features.refreshMinSec（免费 8、会员 3）；缺项 / 非正数 = 3（全部开放，兼容管理员已保存的旧套餐文档）
 */
function refreshMinSec(features) {
  if (!fastRefreshAllowed(features)) return Infinity;
  const n = Number(features && features.refreshMinSec);
  return n > 0 ? n : 3;
}
/** 某一档套餐是否允许：标准档（off）始终允许 */
function pollLevelAllowed(level, features) {
  const l = normalizePollLevel(level);
  return l === 'off' || POLL_SEC[l] >= refreshMinSec(features);
}
/** 实际生效的档位：非法值 → off；超出套餐的降到允许的最快一档（免费版存过 5 秒 / 3 秒的按 8 秒），一档都不允许为 off */
function effectivePollLevel(v, features) {
  const l = normalizePollLevel(v);
  if (pollLevelAllowed(l, features)) return l;
  const order = ['high', 'mid', 'low'];
  return order.slice(order.indexOf(l)).find(x => pollLevelAllowed(x, features)) || 'off';
}

/** 会员功能开关：features 里没有该项视为开放，只有明确为 false 才限制（兼容管理员已保存的旧套餐文档） */
function featureOpen(features, key) { return !features || features[key] !== false; }

/**
 * v3.63.0 额度：features.maxBooks / maxClerks 为礼簿数（含已归档，不含回收站）/ 记账人数上限，0 或缺项为不限。
 * v3.66.7 起默认 free 为 3 本礼簿、3 位记账人（家人共享只读不计），pro 为 0（不限）；settings/plans 文档若存在会整体覆盖默认值，需在里面写全。
 * 只限制新增，已超额的老用户保留全部数据，不删不冻结。
 */
function limitOf(features, key) { const n = Number(features && features[key]); return n > 0 ? n : Infinity; }
/** 额度已满时的提示（机构模式称场次 / 礼台人员） */
function quotaMsg(planName, kind, lim, orgMode) {
  const what = kind === 'books' ? (orgMode ? '个场次' : '本礼簿') : (orgMode ? '位礼台人员' : '位记账人');
  return `${planName || '免费版'}最多 ${lim} ${what}，开通会员可添加更多`;
}

/**
 * 回收站保留天数：用户可选 15 / 30 / 60 天（存 accounts.trashDays，默认 15）；套餐 features.trashDays 限制最长可选天数。
 * 只影响之后删除的礼簿（到期时间 purgeAt 在删除时固化），回收站里已有的按各自 purgeAt 到期
 */
const TRASH_DAYS_OPTIONS = [15, 30, 60];
const TRASH_DAYS_DEFAULT = 15;
function trashDaysMax(features) { const n = Number(features && features.trashDays); return n > 0 ? n : 60; }
function effectiveTrashDays(saved, features) {
  const want = TRASH_DAYS_OPTIONS.includes(Number(saved)) ? Number(saved) : TRASH_DAYS_DEFAULT;
  const cap = TRASH_DAYS_OPTIONS.filter(o => o <= trashDaysMax(features)).pop() || TRASH_DAYS_DEFAULT;
  return Math.max(TRASH_DAYS_DEFAULT, Math.min(want, cap));
}

/**
 * v3.64.0 传统礼簿 PDF 单次最多笔数：缺项 / 非正数 = 3000（原上限）；最高不超过 BOOK_MAX_CEIL（压测：6000 笔本地 17 秒、峰值内存约 610MB，见文档 §175）
 */
const BOOK_MAX_DEFAULT = 3000;
const BOOK_MAX_CEIL = 10000;
function bookMaxOf(features) {
  const n = Math.floor(Number(features && features.bookMax));
  return n > 0 ? Math.min(n, BOOK_MAX_CEIL) : BOOK_MAX_DEFAULT;
}

/** 办事日高峰模式：开启后 PEAK_HOURS 小时内刷新固定 3 秒、预热云函数，到点自动恢复（生效值读取时按时间计算，不改用户保存的档位） */
const PEAK_HOURS = 8;

/** 电子回执版式：免费 / 会员；白事只能用素雅、简约、票据 */
const RECEIPT_STYLES_FREE = ['card', 'ticket', 'simple', 'elegant'];
const RECEIPT_STYLES_PREMIUM = ['festive', 'longevity', 'guofeng', 'business'];
const RECEIPT_STYLES_FUNERAL = ['elegant', 'simple', 'ticket'];

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
    mode: w.mode === 'always' ? 'always' : w.mode === 'peak' ? 'peak' : 'paid', // paid：有付费订阅或有人开着高峰模式；peak：只有人开着高峰模式时
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

/**
 * 刷新档位与高峰到期（v3.66.0，工作台 dashboard 一并返回，省掉冷启动时单独一次 account.get）
 * 口径与 account.get 的 pollLevelOf / peakOf 相同：allowed 为调用方算好的「主家，或有确认收礼权限的记账人，且非只读」
 * 读套餐失败按开放处理；套餐只在需要时读一次
 */
async function refreshOf(db, ctx, allowed, now) {
  const t = now || Date.now();
  const saved = normalizePollLevel(ctx.user && ctx.user.pollLevel);
  const until = ctx.account && ctx.account.peakUntil ? new Date(ctx.account.peakUntil).getTime() : 0;
  if (!allowed || (saved === 'off' && !(until > t))) return { pollLevel: 'off', peakUntil: 0 };
  let features;
  try { features = (await planOf(db, ctx.ownerOpenid)).features; } catch (e) { features = undefined; }
  return {
    pollLevel: saved === 'off' ? 'off' : effectivePollLevel(saved, features),
    peakUntil: until > t && featureOpen(features, 'peakMode') ? until : 0
  };
}

module.exports = {
  refreshOf,
  WARMABLE, DEFAULT_WARMUP, DEFAULT_PLANS, AD_SLOTS, DEFAULT_ADS,
  bookMaxOf, BOOK_MAX_DEFAULT, PEAK_HOURS,
  limitOf, quotaMsg, TRASH_DAYS_OPTIONS, TRASH_DAYS_DEFAULT, trashDaysMax, effectiveTrashDays,
  featureOpen, RECEIPT_STYLES_FREE, RECEIPT_STYLES_PREMIUM, RECEIPT_STYLES_FUNERAL,
  POLL_LEVELS, POLL_SEC, normalizePollLevel, fastRefreshAllowed, refreshMinSec, pollLevelAllowed, effectivePollLevel,
  readSetting, writeSetting, normalizeWarmup, normalizeAds, isAdmin, planOf
};
