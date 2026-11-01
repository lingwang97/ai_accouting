// 云函数 fontsetup — 一次性工具：把导出用中文字体上传到云存储（v3.47.0，文档 §139）
//   { action:'status' }  管理员：查看云存储里的字体登记情况
//   { action:'upload' }  管理员：把本函数代码包里的三个字体（font-*.js，base64）上传到云存储 export-fonts/，
//                        校验下载回来的 sha256，登记到 settings.export_fonts（export 云函数据此下载）
// 字体 JS 模块由 python tools/gen_font_js.py 生成（不入库）；上传成功后可在云开发控制台删除本函数。
// 只有 settings.admins 里的管理员能调用；不返回任何 openid / 密钥。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const FONTS = [
  { key: 'sans', file: './font-sans.js', name: 'NotoSansSC-Subset.ttf', label: '黑体' },
  { key: 'serif', file: './font-serif.js', name: 'NotoSerifSC-Subset.ttf', label: '宋体' },
  { key: 'brush', file: './font-brush.js', name: 'MaShanZheng-Subset.ttf', label: '毛笔字体' }
];
// 示意图字体预览用的小子集（约 800 个常用字，tools/gen_preview_fonts.py 生成，tools/gen_font_js.py --preview 打包成 pvfont-*.js）
const PV_FONTS = [
  { key: 'sans', file: './pvfont-sans.js', name: 'NotoSansSC-Preview.ttf', label: '黑体' },
  { key: 'serif', file: './pvfont-serif.js', name: 'NotoSerifSC-Preview.ttf', label: '宋体' },
  { key: 'brush', file: './pvfont-brush.js', name: 'MaShanZheng-Preview.ttf', label: '毛笔字体' }
];
const PV_DIR = 'preview-fonts';
const DIR = 'export-fonts';
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

exports.main = async (event) => {
  if (event && event.action === '__warm') return { code: 0, msg: 'warm', data: null };
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return err('未获取到用户身份');
  try {
    if (!(await isAdmin(OPENID))) return err('无管理员权限');
    if (event.action === 'status') return ok(await registered());
    if (event.action === 'upload') return ok(await upload());
    if (event.action === 'uploadPreview') return ok(await uploadPreview());
    return err('未知 action');
  } catch (e) {
    console.error('fontsetup', event && event.action, e && e.stack);
    return err('操作失败：' + ((e && e.message) || '请稍后重试'));
  }
};

async function isAdmin(openid) {
  try {
    const d = (await db.collection('settings').doc('admins').get()).data;
    return !d._openid && Array.isArray(d.openids) && d.openids.includes(openid);
  } catch (e) { return false; }
}

async function registered() {
  let meta = null;
  try { meta = (await db.collection('settings').doc('export_fonts').get()).data; } catch (e) { /* 未登记 */ }
  const fonts = (meta && !meta._openid && meta.fonts) || {};
  let pvMeta = null;
  try { pvMeta = (await db.collection('settings').doc('preview_fonts').get()).data; } catch (e) { /* 未登记 */ }
  const pv = (pvMeta && !pvMeta._openid && pvMeta.fonts) || {};
  return {
    previewReady: PV_FONTS.every(f => pv[f.key] && pv[f.key].fileID),
    ready: FONTS.every(f => fonts[f.key] && fonts[f.key].fileID),
    fonts: FONTS.map(f => ({ key: f.key, label: f.label, uploaded: !!(fonts[f.key] && fonts[f.key].fileID), size: (fonts[f.key] && fonts[f.key].size) || 0 })),
    updatedAt: (meta && meta.updatedAt) || null
  };
}

async function upload() {
  const out = {};
  const results = [];
  for (const f of FONTS) {
    let b64;
    try { b64 = require(f.file); } catch (e) {
      throw new Error('代码包里没有字体数据，请先运行 python tools/gen_font_js.py 再重新部署 fontsetup');
    }
    const buf = Buffer.from(b64, 'base64');
    const hash = sha256(buf);
    const up = await cloud.uploadFile({ cloudPath: `${DIR}/${f.name}`, fileContent: buf });
    // 下载回来校验：确认云存储里的文件完整，再登记
    const back = (await cloud.downloadFile({ fileID: up.fileID })).fileContent;
    if (!Buffer.isBuffer(back) || back.length !== buf.length || sha256(back) !== hash) throw new Error(`${f.label}上传后校验失败，请重试`);
    out[f.key] = { fileID: up.fileID, name: f.name, size: buf.length, sha256: hash };
    results.push({ key: f.key, label: f.label, size: buf.length });
  }
  try { await db.createCollection('settings'); } catch (e) { /* 已存在 */ }
  await db.collection('settings').doc('export_fonts').set({ data: { fonts: out, updatedAt: new Date() } });
  return { uploaded: results };
}

/** 上传预览小字体到云存储 preview-fonts/，校验后登记到 settings.preview_fonts（export.fontPreview 据此返回临时链接） */
async function uploadPreview() {
  const out = {};
  const results = [];
  for (const f of PV_FONTS) {
    let b64;
    try { b64 = require(f.file); } catch (e) {
      throw new Error('代码包里没有预览字体数据，请先运行 python tools/gen_font_js.py --preview 再重新部署 fontsetup');
    }
    const buf = Buffer.from(b64, 'base64');
    const hash = sha256(buf);
    const up = await cloud.uploadFile({ cloudPath: `${PV_DIR}/${f.name}`, fileContent: buf });
    const back = (await cloud.downloadFile({ fileID: up.fileID })).fileContent;
    if (!Buffer.isBuffer(back) || back.length !== buf.length || sha256(back) !== hash) throw new Error(`${f.label}预览字体上传后校验失败，请重试`);
    out[f.key] = { fileID: up.fileID, name: f.name, size: buf.length, sha256: hash };
    results.push({ key: f.key, label: f.label, size: buf.length });
  }
  try { await db.createCollection('settings'); } catch (e) { /* 已存在 */ }
  await db.collection('settings').doc('preview_fonts').set({ data: { fonts: out, updatedAt: new Date() } });
  return { uploaded: results };
}

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
