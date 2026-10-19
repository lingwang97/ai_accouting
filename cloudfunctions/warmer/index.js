// 云函数 warmer — 预热调度：定时触发器每 5 分钟调用一次，按 settings.warmup 配置唤醒常用云函数，减少冷启动
// 另外每天北京时间 9:00 那一轮推送到期的亲友办事提醒（reminders，见 remind.js），与预热开关无关
// 配置在小程序「我的 → 系统设置」修改（system 云函数），无需重新上传触发器
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { DEFAULT_WARMUP, readSetting, writeSetting, normalizeWarmup } = require('./plans.js');

exports.main = async (event) => {
  // 只认定时触发（没有用户身份）；用户调用直接拒绝，避免被刷
  if (cloud.getWXContext().OPENID || !(event && (event.Type === 'Timer' || event.TriggerName === 'warm'))) {
    return { code: 1, msg: '仅限定时触发', data: null };
  }
  // 北京时间 9:00～21:59 每一轮都推送当天到期、尚未推送的提醒（pushed 保证只推一次；某轮失败下一轮补推）
  const bjHour = (new Date().getUTCHours() + 8) % 24;
  if (bjHour >= 9 && bjHour < 22) {
    try { await pushReminders(); } catch (e) { console.warn('提醒推送失败', e.message); }
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
    } else if (cfg.mode === 'paid' && !(await hasPaidSubscription())) {
      // 跳过时每小时只记一次状态，减少写库
      if (new Date().getMinutes() >= 5) return { code: 0, msg: 'skip no paid', data: null };
      status.skipped = '暂无有效付费订阅';
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
async function pushReminders() {
  const remind = require('./remind.js');
  if (!remind.TMPL_ID) return;
  const _ = db.command;
  const t = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 北京时间今天
  const col = db.collection('reminders');
  for (let round = 0; round < 4; round++) { // 每轮最多 200 条，避免超出 20 秒超时；没推完的下一轮继续
    const res = await col.where({ done: false, pushed: false, subscribed: true, notifyDay: _.lte(t), date: _.gte(t), _openid: _.exists(false) })
      .limit(50).get();
    if (!res.data.length) break;
    await Promise.all(res.data.map(async r => {
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
      await col.doc(r._id).update({ data: { pushed: final, pushTries: (r.pushTries || 0) + 1, pushResult: { ...result, at: new Date() } } });
    }));
    if (res.data.length < 50) break;
  }
}

/** 是否存在未过期的非免费订阅 */
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
