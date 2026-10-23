// pages/contact/contact.js — 联系我们：在线客服（contact）+ 微信自带反馈（feedback），均由微信通道处理，不经过云函数
const theme = require('../../utils/theme.js');

Page({
  data: { themeStyle: '' },
  onShow() { theme.apply(this); }
});
