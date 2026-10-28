// 云函数 warmer — 预热调度：定时触发器每 5 分钟调用一次，按 settings.warmup 配置唤醒常用云函数，减少冷启动
// 另外每轮推送到期的亲友办事提醒（reminders，见 remind.js），每小时清理一次回收站里过期的礼簿（见 trash.js），都与预热开关无关
// 配置在小程序「我的 → 系统设置」修改（system 云函数），无需重新上传触发器
const cloud = require('wx-server-sdk');
const { bjDay, bjHour } = require('./common.js');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { DEFAULT_WARMUP, readSetting, writeSetting, normalizeWarmup, planOf, featureOpen } = require('./plans.js');

// 超时 60 秒：各阶段按时间预算执行，剩余时间不足就跳过，留到下一轮（5 分钟后）
const TOTAL_MS = 50 * 1000;

exports.main = async (event) => {
  const deadline = Date.now() + TOTAL_MS;
  const left = () => deadline - Date.now();
  // 只认定时触发（没有用户身份）；用户调用直接拒绝，避免被刷
  if (cloud.getWXContext().OPENID || !(event && (event.Type === 'Timer' || event.TriggerName === 'warm'))) {
    return { code: 1, msg: '仅限定时触发', data: null };
  }
  // 每一轮都推送已到提醒时间、尚未推送的提醒（pushed 保证只推一次；某轮失败下一轮补推）
  {
    // 每小时第一轮要给回收站清理留出约 30 秒预算，避免提醒很多时清理长期被挤掉
    const pushDeadline = new Date().getMinutes() < 5 ? deadline - 30 * 1000 : deadline;
    try { await pushReminders(pushDeadline); } catch (e) { console.warn('提醒推送失败', e.message); }
  }
  // 宾客入簿通知补发（v3.68.1）：确认时没发出（可重试的失败 / 实例中断）的，每轮最多补 10 批
  const hourly = new Date().getMinutes() < 5; // 每小时第一轮给回收站清理留出时间
  if (left() > (hourly ? 40 : 15) * 1000) {
    try { await require('./guestnotify.js').create(db, cloud).retryPending(10, deadline - (hourly ? 35 : 10) * 1000); } catch (e) { console.warn('入簿通知补发失败', e.message); }
  }
  // 每小时第一轮：永久删除回收站里超过保留期的礼簿（每次最多 5 本，没删完的下个小时继续）
  if (new Date().getMinutes() < 5) {
    const trash = require('./trash.js');
    // 先续跑卡住的删除 / 恢复（moveToTrash 单次最多 12 秒），再清理过期的；时间不够就留到下个小时
    if (left() > 25 * 1000) {
      try { await trash.resumeStuck(db, 2); } catch (e) { console.warn('回收站续跑失败', e.message); }
    }
    if (left() > 15 * 1000) {
      try { await trash.purgeExpired(db, cloud, 5); } catch (e) { console.warn('回收站清理失败', e.message); }
    }
    // 小程序码一次性凭据（settings.urlnonce_*，payment 写、system 用后即删）：payment 中途超时会留下，清掉 10 分钟前的（v3.59.1）
    if (left() > 5 * 1000) {
      try { await cleanNonces(); } catch (e) { console.warn('凭据清理失败', e.message); }
    }
  }
  const cfg = normalizeWarmup(await readSetting(db, 'warmup', DEFAULT_WARMUP));
  // 关闭时不做任何读写（不再每 5 分钟写一次状态）
  if (!cfg.enabled) return { code: 0, msg: 'disabled', data: null };
  const status = { at: new Date(), called: [], skipped: '' };
  try {
    if (!cfg.enabled) {
      status.skipped = '已关闭';
    } else if (Math.floor(Date.now() / 60000 / 5) % (cfg.intervalMin / 5) !== 0) {
      // 触发器固定每 5 分钟，间隔 10/15/30 分钟时按轮次跳过
      return { code: 0, msg: 'skip interval', data: null };
    } else if ((cfg.mode === 'paid' && !(await hasPaidSubscription()) && !(await hasPeak())) || (cfg.mode === 'peak' && !(await hasPeak()))) {
      // 跳过时每小时只记一次状态，减少写库
      if (new Date().getMinutes() >= 5) return { code: 0, msg: 'skip no paid', data: null };
      status.skipped = cfg.mode === 'peak' ? '暂无人开启高峰模式' : '暂无有效付费订阅或高峰模式';
    } else if (left() < 8 * 1000) {
      status.skipped = '本轮时间不足，留到下一轮';
    } else {
      const res = await Promise.all(cfg.functions.map(name =>
        cloud.callFunction({ name, data: { action: '__warm' } })
          .then(() => name)
          .catch(e => `${name}(失败:${e.errCode || e.message})`)));
      status.called = res;
    }
    await writeSetting(db, 'warmup_status', status);
  } catch (e) {
    console.warn('预热失败', e.message);
  }
  return { code: 0, msg: 'ok', data: status };
};

/**
 * 推送到期的提醒：提醒日已到、办事日未过、未推送、用户订阅过的；每条只推送一次
 * 未配置模板（remind.TMPL_ID 为空）时不推送，提醒仍在小程序里显示
 */
async function pushReminders(deadline) {
  const remind = require('./remind.js');
  if (!remind.TMPL_ID) return;
  const _ = db.command;
  const now = new Date();
  const t = bjDay(now); // 北京时间今天
  const col = db.collection('reminders');
  // 已到提醒时间（remindAt）；旧版提醒没有 remindAt，按提醒日 9:00
  const due = _.or([
    { remindAt: _.lte(now) },
    { remindAt: _.exists(false), notifyDay: bjHour(now) >= 9 ? _.lte(t) : _.lt(t) }
  ]);
  const tried = []; // 本次触发已尝试过的：失败的留到下一次触发（5 分钟后）再试
  for (let round = 0; round < 4; round++) { // 每轮最多 200 条；没推完（或时间预算用完）的下一轮继续
    if (deadline && deadline - Date.now() < 10 * 1000) break;
    const res = await col.where(_.and([{ done: false, pushed: false, subscribed: true, date: _.gte(t), _openid: _.exists(false) }, due,
      ...(tried.length ? [{ _id: _.nin(tried) }] : [])]))
      .limit(50).get();
    res.data.forEach(r => tried.push(r._id));
    if (!res.data.length) break;
    const pushOne = async r => {
      let result;
      try {
        await cloud.openapi.subscribeMessage.send({
          touser: r.ownerOpenid, templateId: remind.TMPL_ID, page: 'pages/renqing/renqing', miniprogramState: { develop: 'developer', trial: 'trial' }[r.envVersion] || 'formal', data: remind.build(r)
        });
        result = { ok: true };
      } catch (e) {
        result = { ok: false, code: e.errCode || -1 };
      }
      // 成功、或确定性失败（43101 未订阅 / 次数用完、47003 参数不符、40003 openid 无效）才标记已推送；其余（网络等）下一轮重试，最多 5 次
      const final = result.ok || [43101, 47003, 40003].includes(result.code) || (r.pushTries || 0) >= 4;
      // 标记失败不能中断同组其他推送；消息已发出时重试一次标记，仍失败只记日志（避免整组 Promise.all 中断）
      const mark = () => col.doc(r._id).update({ data: { pushed: final, pushTries: (r.pushTries || 0) + 1, pushResult: { ...result, at: new Date() } } });
      try { await mark(); } catch (e) {
        try { await mark(); } catch (e2) { console.warn('提醒推送标记失败', r._id, e2.message); }
      }
    };
    for (let k = 0; k < res.data.length; k += 10) { // 每组 10 条并发推送
      if (deadline && deadline - Date.now() < 5 * 1000) break;
      await Promise.all(res.data.slice(k, k + 10).map(pushOne));
    }
    if (res.data.length < 50) break;
  }
}

/** 删除过期的小程序码一次性凭据（有效期 60 秒，这里只删 10 分钟前的，不会和正在进行的生成冲突） */
async function cleanNonces() {
  const _ = db.command;
  const res = await db.collection('settings').where({ kind: 'urllink', createdAt: _.lt(Date.now() - 10 * 60 * 1000) }).remove();
  return (res.stats && res.stats.removed) || 0;
}

/** 是否存在未过期的非免费订阅 */
/** 是否有人正开着办事日高峰模式（accounts.peakUntil 未到期）；v3.64.0 */
async function hasPeak() {
  try {
    const _ = db.command;
    // v3.65.1 高峰模式仅会员：只算套餐含 peakMode 的主家（免费版遗留的 peakUntil 不触发预热）
    const rows = (await db.collection('accounts').where({ peakUntil: _.gt(new Date()), _openid: _.exists(false) }).limit(100).get()).data;
    for (const a of rows) {
      let features = {};
      try { features = (await planOf(db, a.ownerOpenid)).features; } catch (e) { /* 读套餐失败：按开放处理 */ }
      if (featureOpen(features, 'peakMode')) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function hasPaidSubscription() {
  try {
    const _ = db.command;
    const res = await db.collection('subscriptions')
      .where({ plan: _.neq('free'), expiresAt: _.gt(new Date()), _openid: _.exists(false) }).count();
    return res.total > 0;
  } catch (e) {
    return false; // 集合尚不存在
  }
}

// 仅供本地测试
exports._test = { cleanNonces, hasPeak };
