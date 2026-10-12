// 新转账订阅消息配置（需求 B：店主不在前台时也能收到提醒）
// 1. 小程序后台 → 功能 → 订阅消息 → 公共模板库，选用"收款通知"类模板
// 2. 把模板 ID 填入 TMPL_ID（miniprogram/config.js 中也要填同一个 ID）
// 3. 按模板详情里的关键词 key（如 thing1、amount2）调整 build 的字段名
// TMPL_ID 为空时不发送，不影响主流程
module.exports = {
  TMPL_ID: '',
  build: (r, timeStr) => ({
    thing1: { value: String(r.payerName).slice(0, 20) },
    amount2: { value: `${Number(r.amount).toFixed(2)}元` },
    time3: { value: timeStr },
    thing4: { value: String(r.remark || '无').slice(0, 20) }
  })
};
