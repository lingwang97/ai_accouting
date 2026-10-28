// paycode.js — 收款码文件归属判断（v3.69.1 从 account / books / system 三处合并）。
// 源文件在 tools/cloud-shared/paycode.js，由 tools/sync_shared.py 复制到 account、books、system，勿在云函数目录里直接修改。
// 前端上传路径见 pages/account（paycodes/{openid}-{时间}.png）、pages/bookedit（paycodes/book-{openid}-{时间}.png）。

/** 是否为该用户本人上传到 paycodes/ 目录的收款码（收款码关系到钱进谁的账户：只认本人刚上传的文件） */
function ownPayCode(fileID, openid) {
  const esc = String(openid || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return !!esc && new RegExp(`^cloud://[^/]+/paycodes/(book-)?${esc}-\\d+\\.(png|jpe?g|webp)$`, 'i').test(String(fileID || ''));
}

module.exports = { ownPayCode };
