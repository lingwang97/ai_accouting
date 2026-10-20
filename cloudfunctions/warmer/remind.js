// 亲友办事提醒的订阅消息配置（warmer 每天北京时间 9 点推送到期的提醒）
// 模板：小程序后台「订阅消息」选用的一次性订阅模板，字段 thing2 提醒内容（对方姓名）/ thing10 事项名称（事由）/ time11 举办时间 / thing12 详细地址 / thing4 备注（模板的每个字段都要填）；
// TMPL_ID 与 miniprogram/config.js 的 REMIND_TMPL_ID 一致；为空时不推送，提醒仍在小程序「往来」顶部显示
const TYPE_LABEL = { wedding: '婚礼', birthday: '寿宴', baby: '满月/周岁', house: '乔迁', funeral: '白事', other: '办事' };
const cut = (s, n) => String(s || '').slice(0, n);

module.exports = {
  TMPL_ID: 'EXSCyuf8_kWTxR7huRzrG5EQHuAx4VDa25YwBAvLKZ8',
  build(r) {
    const [y, m, d] = String(r.date).split('-');
    const type = TYPE_LABEL[r.eventType] || '办事';
    return {
      thing2: { value: cut(r.name, 20) },                       // 提醒内容：对方姓名
      thing10: { value: cut(r.event || type, 20) },             // 事项名称：事由（没填时为类型，如「婚礼」）
      time11: { value: `${y}年${m}月${d}日` },                  // 举办时间
      thing12: { value: cut(r.location || '未填写', 20) },      // 详细地址：模板必填字段，提醒没有地点时填「未填写」
      thing4: { value: cut(r.note || `${Number(m)}月${Number(d)}日办事，记得回礼`, 20) } // 备注
    };
  }
};
