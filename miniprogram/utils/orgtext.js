// utils/orgtext.js — 机构模式称呼：礼簿 → 场次、记账人 → 礼台人员（js 里拼文案用；wxml 用 utils/orgtext.wxs，规则相同）
const KEEP = ['礼簿码', '礼簿共享', '传统礼簿', '礼簿页', '礼簿类型']; // 固定名称，不替换

function t(s, org) {
  if (!org) return s;
  let r = String(s);
  KEEP.forEach((k, i) => { r = r.split(k).join(`#K${i}#`); });
  r = r.split('礼簿').join('场次').split('记账人').join('礼台人员');
  KEEP.forEach((k, i) => { r = r.split(`#K${i}#`).join(k); });
  return r;
}

module.exports = { t };
