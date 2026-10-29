// secure.js — 内容安全审核（v3.71.0）：文本 security.msgSecCheck（v2）、图片 security.imgSecCheck。
// 源文件在 tools/cloud-shared/secure.js，由 tools/sync_shared.py 复制到各云函数目录，勿在副本里直接修改。
// 原则：只拦截接口明确判定违规的内容；超时、无权限（-604101）、额度、接口异常、图片过大等一律放行并 console.warn，不因审核服务问题阻断用户。
const MSG = '内容含有不适宜信息，请修改后再提交';
const TEXT_TIMEOUT = 3000;
const IMG_TIMEOUT = 3500;
const IMG_MAX = 1024 * 1024; // imgSecCheck 单图上限 1MB，超过的跳过（放行并记日志）
const TEXT_MAX = 2000;       // msgSecCheck 单次最长 2500 字，留余量
const RISKY_IMG_CODE = 87014; // imgSecCheck 命中违规时抛出的 errCode

function withTimeout(p, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** 把多个字段合并成若干段（每段不超过 TEXT_MAX），一次提交最多调用 1~2 次接口 */
function pack(list) {
  const parts = (list || []).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p0 of parts) {
    const p = p0.slice(0, TEXT_MAX);
    if (cur && cur.length + p.length + 1 > TEXT_MAX) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 审核一组文本（空串跳过）。scene：1 资料（默认）2 评论 3 论坛 4 社交日志。
 * 返回 true 表示含违规内容（suggest === 'risky'）；review 视为通过并记日志；任何异常放行。
 */
async function textRisky(cloud, openid, list, scene) {
  if (!openid) return false;
  for (const content of pack(list)) {
    try {
      const r = await withTimeout(cloud.openapi.security.msgSecCheck({ openid, scene: scene || 1, version: 2, content }), TEXT_TIMEOUT);
      const suggest = r && r.result && r.result.suggest;
      if (suggest === 'risky') return true;
      if (suggest === 'review') console.warn('secure: 文本建议人工复核', String(content).slice(0, 20));
    } catch (e) {
      // 接口未开通权限（-604101）、超时、额度等：放行
      console.warn('secure: msgSecCheck 放行', (e && (e.errCode || e.errMsg || e.message)) || e);
    }
  }
  return false;
}

/** 文本审核，命中违规返回错误对象 { code: 1, msg, data: null }，否则返回 null（调用处：const bad = await S.checkText(...); if (bad) return bad;） */
async function checkText(cloud, openid, list, scene) {
  return (await textRisky(cloud, openid, list, scene)) ? { code: 1, msg: MSG, data: null } : null;
}

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 2 && buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.length > 1 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return '';
}

/** 审核云存储图片：返回 true 表示违规。>1MB、格式不支持、下载或接口异常一律放行 */
async function imageRisky(cloud, fileID) {
  if (!fileID || !/^cloud:\/\//.test(String(fileID))) return false;
  try {
    return await withTimeout((async () => {
      const dl = await cloud.downloadFile({ fileID });
      const buf = dl && dl.fileContent;
      if (!buf || !buf.length) return false;
      if (buf.length > IMG_MAX) { console.warn('secure: 图片超过 1MB，跳过审核', buf.length); return false; }
      const contentType = sniff(buf);
      if (!contentType) { console.warn('secure: 图片格式不支持审核，跳过'); return false; }
      try {
        await cloud.openapi.security.imgSecCheck({ media: { contentType, value: buf } });
        return false;
      } catch (e) {
        if (e && Number(e.errCode) === RISKY_IMG_CODE) return true;
        throw e;
      }
    })(), IMG_TIMEOUT);
  } catch (e) {
    console.warn('secure: imgSecCheck 放行', (e && (e.errCode || e.errMsg || e.message)) || e);
    return false;
  }
}

/** 图片审核，违规时尽力删除该文件并返回错误对象，否则 null */
async function checkImage(cloud, fileID) {
  if (!(await imageRisky(cloud, fileID))) return null;
  try { await cloud.deleteFile({ fileList: [fileID] }); } catch (e) { /* 忽略 */ }
  return { code: 1, msg: MSG, data: null };
}

module.exports = { MSG, checkText, textRisky, checkImage, imageRisky, pack };
