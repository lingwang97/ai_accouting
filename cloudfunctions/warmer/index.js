// 云函数 warmer — 预热调度：定时触发器每 5 分钟调用一次，按 settings.warmup 配置唤醒常用云函数，减少冷启动
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
