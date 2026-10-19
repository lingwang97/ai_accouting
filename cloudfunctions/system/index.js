// 云函数 system — 系统设置（管理员）与付费订阅接口（预留）
//   plan         任何登录用户：当前套餐（记账人跟随所服务的主家），并返回自己是否管理员
//   adminGet     管理员：预热配置、上次预热结果、套餐定义
//   adminSetWarmup 管理员：保存预热配置
//   adminSetPlan 管理员：给某位主家开通 / 延期 / 取消套餐（以后接支付回调时由支付流程调用同一逻辑）
//   ads          任何人：广告位配置（前端据此决定是否展示，宾客也会调用）
//   adminSetAds  管理员：保存广告位配置
//   adminIndexes 管理员：一键创建数据库索引（调用云开发 HTTP API updateIndex，需在本函数环境变量配置 WX_APPSECRET）
const cloud = require('wx-server-sdk');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { resolveCtx } = require('./ctx.js');
const P = require('./plans.js');

exports.main = async (event) => {
  if (event && event.action === '__warm') return { code: 0, msg: 'warm', data: null };
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return err('未获取到用户身份');
  try {
    switch (event.action) {
      case 'plan': return await myPlan(OPENID);
      case 'ads': return ok(P.normalizeAds(await P.readSetting(db, 'ads', P.DEFAULT_ADS)));
      case 'adminSetAds': return await guard(OPENID, () => adminSetAds(event.ads));
      case 'adminGet': return await guard(OPENID, adminGet);
      case 'adminSetWarmup': return await guard(OPENID, () => adminSetWarmup(event.warmup));
      case 'adminSetPlan': return await guard(OPENID, () => setPlan(event.ownerOpenid, event.plan, event.days, 'admin'));
      case 'adminFindHosts': return await guard(OPENID, () => findHosts(event.keyword));
      case 'adminIndexes': return await guard(OPENID, () => ensureIndexes());
      default: return err('未知 action');
    }
  } catch (e) {
    console.error('system', event.action, e);
    return err('操作失败，请稍后重试');
  }
};

async function guard(openid, fn) {
  if (!(await P.isAdmin(db, openid))) return err('无管理员权限');
  return fn();
}

/** 当前套餐：数据属于主家，记账人按主家的套餐 */
async function myPlan(openid) {
  const ctx = await resolveCtx(db, openid);
  const plan = await P.planOf(db, ctx.ownerOpenid);
  return ok({ ...plan, isAdmin: await P.isAdmin(db, openid) });
}

async function adminGet() {
  const [warmup, status, plans, ads] = await Promise.all([
    P.readSetting(db, 'warmup', P.DEFAULT_WARMUP),
    P.readSetting(db, 'warmup_status', {}),
    P.readSetting(db, 'plans', P.DEFAULT_PLANS),
    P.readSetting(db, 'ads', P.DEFAULT_ADS)
  ]);
  return ok({
    warmup: P.normalizeWarmup(warmup), status, plans, warmable: P.WARMABLE,
    ads: P.normalizeAds(ads), adSlots: P.AD_SLOTS
  });
}

async function adminSetAds(a) {
  const raw = a || {};
  if (raw.bannerUnit && !/^adunit-[a-zA-Z0-9]{4,40}$/.test(String(raw.bannerUnit))) return err('广告单元 ID 格式不正确（应为 adunit- 开头）');
  const ads = P.normalizeAds(raw);
  if (ads.enabled && !ads.bannerUnit) return err('开启广告前请先填写广告单元 ID');
  await P.writeSetting(db, 'ads', ads);
  return ok({ ads });
}

async function adminSetWarmup(w) {
  const warmup = P.normalizeWarmup(w || {});
  await P.writeSetting(db, 'warmup', warmup);
  return ok({ warmup });
}

/** 按主家称呼 / 机构名称 / openid 搜索主家，附当前套餐（开通时直接选，不用手填 openid） */
async function findHosts(keyword) {
  const k = String(keyword || '').trim().slice(0, 30);
  if (!k) return err('请输入主家称呼');
  const _ = db.command;
  const reg = db.RegExp({ regexp: k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
  const res = await db.collection('accounts')
    .where(_.or([{ accountName: reg }, { orgName: reg }, { ownerOpenid: k }]))
    .field({ accountName: true, orgName: true, ownerOpenid: true, orgMode: true })
    .limit(20).get();
  const list = await Promise.all(res.data
    .filter(a => !String(a.ownerOpenid || '').startsWith('merged:')) // 已合并的别名
    .map(async a => {
      const plan = await P.planOf(db, a.ownerOpenid);
      return {
        ownerOpenid: a.ownerOpenid,
        accountName: a.accountName,
        orgName: a.orgName || '',
        orgMode: !!a.orgMode,
        plan: plan.plan,
        planName: plan.name,
        expiresAt: plan.expiresAt
      };
    }));
  return ok({ list });
}

/**
 * 开通 / 延期 / 取消套餐（订阅接口预留）
 * days > 0：在当前到期时间（未过期）或现在的基础上延长；plan='free' 为取消
 */
async function setPlan(ownerOpenid, plan, days, source) {
  ownerOpenid = String(ownerOpenid || '').trim();
  if (!/^[a-zA-Z0-9_-]{10,64}$/.test(ownerOpenid)) return err('openid 不正确');
  const plans = await P.readSetting(db, 'plans', P.DEFAULT_PLANS);
  if (!plans[plan]) return err('套餐不存在');
  try { await db.createCollection('subscriptions'); } catch (e) { /* 已存在 */ }
  const col = db.collection('subscriptions');
  let cur = null;
  try { cur = (await col.doc(ownerOpenid).get()).data; } catch (e) { /* 无订阅 */ }
  let expiresAt = null;
  if (plan !== 'free') {
    const n = Math.max(1, Math.min(3660, Number(days) || 30));
    const base = cur && cur.plan === plan && cur.expiresAt && new Date(cur.expiresAt) > new Date()
      ? new Date(cur.expiresAt) : new Date();
    expiresAt = new Date(base.getTime() + n * 24 * 3600 * 1000);
  }
  await col.doc(ownerOpenid).set({ data: { plan, expiresAt, source, updatedAt: new Date() } });
  // 读回确认已生效
  const now = await P.planOf(db, ownerOpenid);
  return ok({ ownerOpenid, plan: now.plan, planName: now.name, expiresAt: now.expiresAt });
}

// —— 数据库索引 ——
// 与 docs/提审与隐私说明.md 第 1 条一致；direction "1" 升序、"-1" 降序
const INDEXES = [
  ['records', 'owner_status_time', [['ownerOpenid', 1], ['status', 1], ['createdAt', -1]]],
  ['records', 'owner_day_status', [['ownerOpenid', 1], ['payDay', 1], ['status', 1]]],
  ['records', 'owner_book_status', [['ownerOpenid', 1], ['bookId', 1], ['status', 1]]],
  ['records', 'payer_status_paid', [['payerOpenid', 1], ['status', 1], ['paidAt', -1]]],
  ['records', 'payer_time', [['payerOpenid', 1], ['createdAt', -1]]],
  ['records', 'batch', [['batchId', 1]]],
  ['members', 'member', [['memberOpenid', 1]]],
  ['members', 'aid', [['aid', 1]]],
  ['accounts', 'owner', [['ownerOpenid', 1]]],
  ['users', 'openid', [['openid', 1]]],
  ['books', 'owner_time', [['ownerOpenid', 1], ['createdAt', -1]]],
  ['gifts_out', 'owner_name', [['ownerOpenid', 1], ['toName', 1]]],
  ['gifts_out', 'owner_date', [['ownerOpenid', 1], ['date', -1]]],
  ['exports', 'owner_file', [['ownerOpenid', 1], ['fileID', 1]]],
  ['exports', 'keep_time', [['keep', 1], ['createdAt', 1]]],
  ['reminders', 'owner_done_date', [['ownerOpenid', 1], ['done', 1], ['date', 1]]],
  ['reminders', 'push', [['pushed', 1], ['notifyDay', 1]]]
];

/**
 * 一键创建索引：逐条调用 updateIndex（一条失败不影响其他）；已存在的视为成功
 * access_token 用小程序 AppSecret 换取（stable_token），AppSecret 放在本云函数的环境变量 WX_APPSECRET，不写进代码
 */
async function ensureIndexes() {
  const secret = process.env.WX_APPSECRET;
  if (!secret) return err('未配置 AppSecret：云开发控制台 → 云函数 → system → 配置 → 环境变量，添加 WX_APPSECRET');
  const { APPID, ENV } = cloud.getWXContext(); // ENV：当前云环境 ID
  const env = ENV || process.env.TCB_ENV || '';
  if (!env) return err('未获取到云环境 ID');
  const tk = await postJSON('https://api.weixin.qq.com/cgi-bin/stable_token', { grant_type: 'client_credential', appid: APPID, secret });
  if (!tk.access_token) return err(`获取 access_token 失败（${tk.errcode} ${tk.errmsg || ''}），请核对 AppSecret`);

  // 并行创建（串行 15 次请求最坏会超过函数超时）
  const results = await Promise.all(INDEXES.map(async ([col, name, keys]) => {
    try { await db.createCollection(col); } catch (e) { /* 已存在 */ }
    const r = await postJSON(`https://api.weixin.qq.com/tcb/updateindex?access_token=${tk.access_token}`, {
      env,
      collection_name: col,
      create_indexes: [{ name, unique: false, keys: keys.map(([k, d]) => ({ name: k, direction: String(d) })) }],
      drop_indexes: []
    }).catch(e => ({ errcode: -1, errmsg: e.message }));
    const exists = r.errcode !== 0 && /exist|duplicate|already/i.test(r.errmsg || '');
    return { col, name, ok: r.errcode === 0 || exists, existed: exists, msg: r.errcode === 0 || exists ? '' : `${r.errcode} ${r.errmsg || ''}` };
  }));
  return ok({ env, results, created: results.filter(x => x.ok && !x.existed).length, failed: results.filter(x => !x.ok).length });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 8000 }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('返回解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(data);
  });
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
