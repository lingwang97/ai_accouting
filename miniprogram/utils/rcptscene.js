// utils/rcptscene.js — 小票小程序码的 scene 约定：scene = 't=' + 12 位 token（共 14 位，≤32，字符合法）
// 扫小程序码进入页面时参数在 options.scene（URL 编码）；也兼容 ?t=token
const TOKEN_RE = /^[0-9A-Za-z]{12}$/;

const sceneOf = token => `t=${token}`;

/** 从页面 options 取 token；取不到返回空串 */
function tokenFromOptions(options) {
  const o = options || {};
  if (TOKEN_RE.test(String(o.t || ''))) return o.t;
  if (o.scene) {
    let sc = String(o.scene);
    try { sc = decodeURIComponent(sc); } catch (e) { /* 不是合法编码就按原文解析 */ }
    const m = /(?:^|&)t=([0-9A-Za-z]{12})(?:&|$)/.exec(sc);
    if (m) return m[1];
  }
  return '';
}

module.exports = { TOKEN_RE, sceneOf, tokenFromOptions };
