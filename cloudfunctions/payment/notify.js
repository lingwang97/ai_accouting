// 订阅消息配置
// 1) 新礼金提醒（给主家 / 记账人）：宾客点"我已完成转账"后通过微信服务通知提醒
//    模板（v3.77.1 换新模板）：一次性订阅，字段 thing1 主家+礼簿事由 / thing4 随礼人 / amount7 金额 / time9 时间 / thing3 提醒事由；TMPL_ID 需与 miniprogram/config.js 中 NOTIFY_TMPL_ID 一致
// 2) 入簿通知（给宾客，v3.66.1）：主家确认收到后通知随礼的宾客，点开看电子回执
//    模板：一次性订阅，字段 thing6 主家+事由 / amount3 金额 / time1 记账时间 / thing8 支付方式 / thing5 备注；
//    GUEST_TMPL_ID 需与 miniprogram/config.js 中 GUEST_NOTIFY_TMPL_ID 一致
// 模板 ID 为空时不发送，不影响主流程
const G = require('./guestnotify.js');
module.exports = {
  TMPL_ID: 'sVsjMMXbw7ZiMu8rEG-8_Y4toUJ42ziyevx2NtVgng4',
  /**
   * r：{ hostName, themeName, payerName 随礼人（批次已写成「张三等3人」）, amount（批次合计）, reason 提醒事由 }
   * thing 类字段 20 字以内、去特殊字符（thingValue）；time9 为宾客点「我已完成转账」的时间（申诉提醒为申诉时间）
   */
  build: (r, timeStr) => ({
    thing1: { value: G.thingValue([r.hostName, r.themeName].filter(Boolean).join(' '), '慧礼记') },
    thing4: { value: G.thingValue(r.payerName, '宾客') },
    amount7: { value: `${(Math.round(Number(r.amount || 0) * 100) / 100).toFixed(2)}元` },
    time9: { value: timeStr },
    thing3: { value: G.thingValue(r.reason, '新礼金待确认') }
  }),
  // 宾客入簿通知：模板与内容在共享模块 guestnotify.js（payment 发送、warmer 补发共用），这里转出供旧引用
  GUEST_TMPL_ID: G.GUEST_TMPL_ID,
  buildGuest: G.buildGuest,
  thingValue: G.thingValue
};
