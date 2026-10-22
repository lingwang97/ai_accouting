// config.js — 小程序前端配置
module.exports = {
  // 版本号：每次发布前更新，与小程序后台「上传代码」填写的版本号保持一致（变更记录见 docs/技术开发文档.md）
  VERSION: '3.42.1',

  // 新礼金订阅消息模板 ID（与 cloudfunctions/payment/notify.js 中 TMPL_ID 保持一致；为空则不启用提醒）
  NOTIFY_TMPL_ID: 'eC0vKfrKjT6oBR187PU8HRIO85tW1EM8W-gqe9xjSqc',
  // 亲友办事提醒订阅消息模板 ID（与 cloudfunctions/warmer/remind.js 中 TMPL_ID 保持一致；为空则只在小程序里提醒，不推送）
  REMIND_TMPL_ID: 'EXSCyuf8_kWTxR7huRzrG5EQHuAx4VDa25YwBAvLKZ8'
};
