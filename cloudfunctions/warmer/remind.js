// 亲友办事提醒的订阅消息配置（warmer 每天北京时间 9 点推送到期的提醒）
// 模板：小程序后台「订阅消息」选用的一次性订阅模板，字段 thing2 标题 / thing10 对方姓名 / thing12 事由 / time11 办事日期 / thing4 备注（每个字段都要填）；
// TMPL_ID 与 miniprogram/config.js 的 REMIND_TMPL_ID 一致；为空时不推送，提醒仍在小程序「往来」顶部显示
const TYPE_LABEL = { wedding: '婚礼', birthday: '寿宴', baby: '满月/周岁', house: '乔迁', funeral: '白事', other: '办事' };
const cut = (s, n) => String(s || '').slice(0, n);

module.exports = {
  TMPL_ID: 'EXSCyuf8_kWTxR7huRzrG5EQHuAx4VDa25YwBAvLKZ8',
  build(r) {
    const [y, m, d] = String(r.date).split('-');
    const type = TYPE_LABEL[r.eventType] || '办事';
    return {
      thing2: { value: '慧礼记好友办事提醒' },                                  // 标题
      thing10: { value: cut(r.name, 20) },                                    // 对方姓名
      thing12: { value: cut(r.event || type, 20) },                           // 事由
      time11: { value: `${y}年${m}月${d}日` },                                // 办事日期
      thing4: { value: cut(r.note || (r.before ? `还有${r.before}天，记得回礼` : '今天办事，记得回礼'), 20) } // 备注
    };
  }
};
