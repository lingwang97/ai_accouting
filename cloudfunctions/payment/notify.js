// 订阅消息配置
// 1) 新礼金提醒（给主家 / 记账人）：宾客点"我已完成转账"后通过微信服务通知提醒
//    模板：一次性订阅，字段 name4 / amount3 / time1 / thing5；TMPL_ID 需与 miniprogram/config.js 中 NOTIFY_TMPL_ID 一致
// 2) 入簿通知（给宾客，v3.66.1）：主家确认收到后通知随礼的宾客，点开看电子回执
//    模板：一次性订阅，字段 thing6 主家+事由 / amount3 金额 / time1 记账时间 / thing8 支付方式 / thing5 备注；
//    GUEST_TMPL_ID 需与 miniprogram/config.js 中 GUEST_NOTIFY_TMPL_ID 一致
// 模板 ID 为空时不发送，不影响主流程
const G = require('./guestnotify.js');
module.exports = {
  TMPL_ID: 'eC0vKfrKjT6oBR187PU8HRIO85tW1EM8W-gqe9xjSqc',
  build: (r, timeStr) => ({
    // name：10 个以内纯汉字或 20 个以内纯字母，混排时去掉不合规字符
    name4: { value: nameValue(r.payerName) },
    amount3: { value: `${Number(r.amount).toFixed(2)}元` },
    time1: { value: timeStr },
    // thing：20 个字以内；优先礼品/备注，否则写礼簿名
    thing5: { value: String(r.remark || (r.themeName ? `${r.themeName} 待确认` : '新礼金待确认')).slice(0, 20) }
  }),
  // 宾客入簿通知：模板与内容在共享模块 guestnotify.js（payment 发送、warmer 补发共用），这里转出供旧引用
  GUEST_TMPL_ID: G.GUEST_TMPL_ID,
  buildGuest: G.buildGuest,
  thingValue: G.thingValue
};

function nameValue(name) {
  const s = String(name || '').trim();
  const cn = s.replace(/[^一-龥]/g, '');
  if (cn) return cn.slice(0, 10);
  const en = s.replace(/[^A-Za-z ]/g, '').trim();
  return (en || '宾客').slice(0, 20);
}
