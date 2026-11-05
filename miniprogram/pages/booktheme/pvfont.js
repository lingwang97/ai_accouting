// utils/pvfont.js — 示意图字体预览（v3.83.0，v3.83.1 改为下载到本地再加载）：懒加载云存储里的预览小字体（约 800 个常用字的子集），让导出页示意图按所选字体显示
// 元信息取自 export.fontPreview（{url, fileID, v}，缓存 90 分钟）。v3.83.0 直接让 wx.loadFontFace 加载 https 临时链接，真机因跨域 / 域名失败；
// 现在的流程：wx.cloud.downloadFile(fileID)（不需要域名白名单）-> 复制到 USER_DATA_PATH/pvfont-<key>-<v>.ttf（下次直接用，版本变了清理旧文件）
// -> readFile 成 base64 -> loadFontFace(data URI)；data URI 失败再退回 https 链接。
// loaded 由调用页面持有，同一页面同一字体只加载一次；没上传 / 加载失败 / 基础库没有 loadFontFace 一律返回 ''，调用方回退系统字体
const req = require('../../utils/request.js');

const META_TTL = 90 * 60 * 1000;
let meta = null;
let metaAt = 0;
let metaP = null;
let metaState = 'ok'; // ok 有预览字体 / none 管理员还没上传 / error 取元信息失败（网络等）

/** { sans: {url, fileID, v}, serif, brush }；没上传返回 {} */
function getMeta() {
  if (meta && Date.now() - metaAt < META_TTL) return Promise.resolve(meta);
  if (metaP) return metaP;
  metaP = req.fontPreview()
    .then(r => {
      meta = r && r.ready && r.fonts ? r.fonts : {};
      metaAt = Date.now();
      metaState = Object.keys(meta).length ? 'ok' : 'none';
      return meta;
    })
    .catch(e => { metaState = 'error'; console.warn('pvfont meta failed', e && (e.errMsg || e.message)); return {}; })
    .then(m => { metaP = null; return m; });
  return metaP;
}

/** 预览字体状态：none = 管理员还没上传（不是故障）；error = 取元信息失败；ok = 已登记 */
const state = () => metaState;

const familyOf = (key, v) => `hljpv-${key}-${v || '0'}`;

const wrap = (fn, opts) => new Promise((resolve, reject) => { fn({ ...opts, success: resolve, fail: e => reject(e || new Error('fail')) }); });
const errOf = e => (e && (e.errMsg || e.message)) || String(e);

function fsm() { try { return wx.getFileSystemManager(); } catch (e) { return null; } }

/** 清掉这个字体 key 的旧版本文件（版本变了以后不再占用本地空间） */
function cleanOld(fs, dir, key, keepName) {
  try {
    fs.readdir({
      dirPath: dir,
      success: r => {
        const pre = `pvfont-${key}-`;
        (r.files || []).forEach(n => { if (n.indexOf(pre) === 0 && n !== keepName) fs.unlink({ filePath: `${dir}/${n}`, fail() {} }); });
      },
      fail() {}
    });
  } catch (e) { /* 清理失败不影响使用 */ }
}

/**
 * 取到本地字体文件路径：优先本地缓存（USER_DATA_PATH）；没有则 downloadFile(fileID) 再复制过去。
 * 复制 / 写入失败（空间不足等）时直接用下载下来的临时文件。返回 { path, fresh }（fresh = 刚下载，缓存可能损坏时用来判断是否重试）
 */
async function localFont(key, f, forceDownload) {
  const fs = fsm();
  const dir = wx.env && wx.env.USER_DATA_PATH;
  const name = `pvfont-${key}-${f.v || '0'}.ttf`;
  const dest = dir ? `${dir}/${name}` : '';
  if (fs && dest) {
    if (!forceDownload) {
      try { await wrap(fs.access.bind(fs), { path: dest }); cleanOld(fs, dir, key, name); return { path: dest, fresh: false }; } catch (e) { /* 没有缓存：下载 */ }
    } else {
      try { fs.unlink({ filePath: dest, fail() {} }); } catch (e) { /* 忽略 */ }
    }
  }
  if (!f.fileID || !wx.cloud || typeof wx.cloud.downloadFile !== 'function') throw new Error('no fileID');
  const d = await wrap(wx.cloud.downloadFile.bind(wx.cloud), { fileID: f.fileID });
  const tmp = d && d.tempFilePath;
  if (!tmp) throw new Error('download empty');
  if (fs && dest) {
    try {
      await wrap(fs.copyFile.bind(fs), { srcPath: tmp, destPath: dest });
      cleanOld(fs, dir, key, name);
      return { path: dest, fresh: true };
    } catch (e) { console.warn('pvfont cache write failed', key, errOf(e)); }
  }
  return { path: tmp, fresh: true };
}

const loadFace = (family, source) => wrap(wx.loadFontFace.bind(wx), { family, source });

/** 本地文件 -> base64 -> loadFontFace(data URI)；本地缓存读 / 加载失败时重新下载一次 */
async function viaLocal(key, f, family) {
  let lf = await localFont(key, f, false);
  for (let round = 0; ; round++) {
    try {
      const fs = fsm();
      const r = await wrap(fs.readFile.bind(fs), { filePath: lf.path, encoding: 'base64' });
      await loadFace(family, `url("data:font/ttf;base64,${r.data}")`);
      return;
    } catch (e) {
      if (lf.fresh || round > 0) throw e;
      console.warn('pvfont cached file unusable, redownload', key, errOf(e));
      lf = await localFont(key, f, true);
    }
  }
}

/** 加载一个预览字体：返回 family 名，失败返回 ''；结果（Promise）记在 loaded[key]，同一页面不重复加载 */
function load(key, loaded) {
  if (loaded[key] !== undefined) return loaded[key];
  const p = getMeta().then(async m => {
    const f = m[key];
    if (!f || (!f.url && !f.fileID) || typeof wx.loadFontFace !== 'function') return '';
    const family = familyOf(key, f.v);
    try {
      await viaLocal(key, f, family);
      return family;
    } catch (e) {
      console.warn('pvfont local load failed', key, errOf(e));
    }
    if (!f.url) return '';
    try {
      await loadFace(family, `url("${f.url}")`);
      return family;
    } catch (e) {
      console.warn('pvfont url load failed', key, errOf(e));
      return '';
    }
  }).catch(() => '');
  loaded[key] = p;
  // 失败结果不缓存（v3.83.2）：下次切字体 / 标签时可以重试；成功的（和「管理员没上传」）仍同一页面只加载一次
  p.then(v => { if (!v && loaded[key] === p && metaState !== 'none') delete loaded[key]; });
  return p;
}

/** 示意图要用的字体 key（与 PDF 的分工一致）：主字体；毛笔体的小字用黑体；囍水印 / 毛笔体的水印用宋体 */
function keysFor(main, mark) {
  const keys = [main];
  if (main === 'brush') keys.push('sans');
  if (mark === '囍' || main === 'brush') keys.push('serif');
  return [...new Set(keys)];
}

const css = f => (f ? `font-family:'${f}',sans-serif;` : '');

module.exports = { load, keysFor, css, familyOf, getMeta, state };
