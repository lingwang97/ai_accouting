// utils/pvfont.js — 示意图字体预览（v3.83.0）：懒加载云存储里的预览小字体（约 800 个常用字的子集），让导出页示意图按所选字体显示
// 链接取自 export.fontPreview（https 临时链接，2 小时有效，这里缓存 90 分钟）；loaded 由调用页面持有，同一页面同一字体只加载一次；
// 没上传 / 加载失败 / 基础库没有 loadFontFace 一律返回 ''，调用方回退系统字体，不影响使用
const req = require('./request.js');

const META_TTL = 90 * 60 * 1000;
let meta = null;
let metaAt = 0;
let metaP = null;

/** { sans: {url, v}, serif, brush }；没上传返回 {} */
function getMeta() {
  if (meta && Date.now() - metaAt < META_TTL) return Promise.resolve(meta);
  if (metaP) return metaP;
  metaP = req.fontPreview()
    .then(r => { meta = r && r.ready && r.fonts ? r.fonts : {}; metaAt = Date.now(); return meta; })
    .catch(() => ({}))
    .then(m => { metaP = null; return m; });
  return metaP;
}

const familyOf = (key, v) => `hljpv-${key}-${v || '0'}`;

/** 加载一个预览字体：返回 family 名，失败返回 ''；结果（Promise）记在 loaded[key]，同一页面不重复加载 */
function load(key, loaded) {
  if (loaded[key] !== undefined) return loaded[key];
  loaded[key] = getMeta().then(m => {
    const f = m[key];
    if (!f || !f.url || typeof wx.loadFontFace !== 'function') return '';
    const family = familyOf(key, f.v);
    return new Promise(resolve => {
      wx.loadFontFace({ family, source: `url("${f.url}")`, success: () => resolve(family), fail: () => resolve('') });
    });
  }).catch(() => '');
  return loaded[key];
}

/** 示意图要用的字体 key（与 PDF 的分工一致）：主字体；毛笔体的小字用黑体；囍水印 / 毛笔体的水印用宋体 */
function keysFor(main, mark) {
  const keys = [main];
  if (main === 'brush') keys.push('sans');
  if (mark === '囍' || main === 'brush') keys.push('serif');
  return [...new Set(keys)];
}

const css = f => (f ? `font-family:'${f}',sans-serif;` : '');

module.exports = { load, keysFor, css, familyOf, getMeta };
