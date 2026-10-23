// fonts.js — 导出用的中文字体：存云存储，首次使用时下载到 /tmp 缓存（不再把约 15MB 的 base64 字体打进云函数代码包）。
//
// 字体（均为 GB2312 子集 TrueType，SIL OFL 1.1，授权文本见 tools/fonts/OFL-*.txt）：
//   sans   思源黑体（所有 PDF 都要用：表格 PDF 全部文字；传统礼簿的小字与回退字体）
//   serif  思源宋体（传统礼簿可选字体；囍水印、毛笔体的水印字也用它）
//   brush  马善政楷书（传统礼簿可选字体：毛笔风格）
// 云存储路径固定为 export-fonts/{文件名}；字体的 fileID / 大小 / sha256 登记在 settings 集合的 export_fonts 文档，
// 由管理员页「上线前检查」里的「上传导出字体」（fontsetup 云函数）一次性写入。
// 没有登记（NOT_READY）、下载失败（DOWNLOAD）、校验不通过（CORRUPT）都不抛到调用方整体失败：
// prepare() 返回 failed 明细，由 index.js 决定报错（黑体）还是回退到黑体（宋体 / 毛笔）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FONT_FILES = {
  sans: 'NotoSansSC-Subset.ttf',
  serif: 'NotoSerifSC-Subset.ttf',
  brush: 'MaShanZheng-Subset.ttf'
};
const FONT_LABEL = { sans: '黑体', serif: '宋体', brush: '毛笔字体' };
const STORAGE_DIR = 'export-fonts';
const META_TTL = 5 * 60 * 1000; // 登记信息在内存里缓存 5 分钟
const MISS_TTL = 15 * 1000;     // 还没登记时只缓存 15 秒，上传完成后很快就能用

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const isTtf = buf => Buffer.isBuffer(buf) && buf.length > 1024 && buf.readUInt32BE(0) === 0x00010000;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * @param {object} deps
 *   getMeta()    -> Promise<{ fonts: { sans: {fileID,size,sha256}, ... } } | null>  读登记信息（没有返回 null）
 *   download(id) -> Promise<Buffer>                                                下载云存储文件
 *   tmpDir       缓存目录（默认 /tmp/hlj-fonts）
 *   now()        测试用
 */
function createLoader(deps) {
  const tmpDir = deps.tmpDir || process.env.HLJ_FONT_TMP || '/tmp/hlj-fonts'; // HLJ_FONT_TMP 仅供本地测试
  const now = deps.now || Date.now;
  const mem = new Map();      // key -> Buffer
  const inflight = new Map(); // key -> Promise<Buffer>
  let metaCache = null;       // { at, ttl, meta }

  async function meta() {
    if (metaCache && now() - metaCache.at < metaCache.ttl) return metaCache.meta;
    let m = null;
    try { m = await deps.getMeta(); } catch (e) { m = null; }
    metaCache = { at: now(), ttl: m && m.fonts ? META_TTL : MISS_TTL, meta: m };
    return m;
  }

  /** 读 /tmp 缓存：大小与 sha256 都对得上才算有效（写到一半被中断的文件会被丢弃） */
  function readCache(file, info) {
    try {
      const buf = fs.readFileSync(file);
      if (isTtf(buf) && (!info.size || buf.length === info.size) && (!info.sha256 || sha256(buf) === info.sha256)) return buf;
    } catch (e) { /* 没有缓存 */ }
    return null;
  }

  async function loadOne(key) {
    if (mem.has(key)) return mem.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const m = await meta();
      const info = m && m.fonts && m.fonts[key];
      if (!info || !info.fileID) throw fail('NOT_READY', `${FONT_LABEL[key]}尚未上传到云存储`);
      const file = path.join(tmpDir, `${String(info.sha256 || 'x').slice(0, 12)}-${FONT_FILES[key]}`);
      let buf = readCache(file, info);
      if (!buf) {
        let got;
        try { got = await deps.download(info.fileID); } catch (e) { throw fail('DOWNLOAD', `${FONT_LABEL[key]}下载失败：${(e && e.message) || e}`); }
        got = Buffer.isBuffer(got) ? got : Buffer.from(got || '');
        if (!isTtf(got) || (info.size && got.length !== info.size) || (info.sha256 && sha256(got) !== info.sha256)) {
          throw fail('CORRUPT', `${FONT_LABEL[key]}文件校验不通过`);
        }
        buf = got;
        try { // 写缓存失败（/tmp 满等）不影响本次使用
          fs.mkdirSync(tmpDir, { recursive: true });
          const part = `${file}.${process.pid}.${Date.now()}.part`;
          fs.writeFileSync(part, buf);
          fs.renameSync(part, file);
        } catch (e) { /* 忽略 */ }
      }
      mem.set(key, buf);
      return buf;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }

  /** 并行准备若干字体；永不抛错，返回 { buffers: {key: Buffer}, failed: {key: {code, message}} } */
  async function prepare(keys) {
    const uniq = [...new Set(keys)];
    const buffers = {}, failed = {};
    await Promise.all(uniq.map(async k => {
      try { buffers[k] = await loadOne(k); } catch (e) { failed[k] = { code: e.code || 'DOWNLOAD', message: e.message }; }
    }));
    return { buffers, failed };
  }

  return { prepare, load: loadOne, _reset() { mem.clear(); inflight.clear(); metaCache = null; } };
}

/**
 * 按导出格式决定要哪些字体、失败怎么办。
 * @returns {{ keys: string[], resolve: (prepared) => { fonts, notes, error } }}
 *   resolve 返回：error（黑体不可用时的提示，非空则整体报错）、notes（回退说明）、fonts（给 buildPdf / buildBook 用的 Buffer）
 */
function planFor(format, bt) {
  if (format !== 'book') {
    return { keys: ['sans'], resolve: p => (p.buffers.sans ? { fonts: { sans: p.buffers.sans } } : { error: sansError(p) }) };
  }
  const mainKey = bt.font === 'serif' ? 'serif' : bt.font === 'brush' ? 'brush' : 'sans';
  const needSerifMark = !!bt.mark && (bt.mark === '囍' || bt.font === 'brush');
  const keys = ['sans'];
  if (mainKey !== 'sans') keys.push(mainKey);
  if (needSerifMark && !keys.includes('serif')) keys.push('serif');
  return {
    keys,
    resolve: p => {
      if (!p.buffers.sans) return { error: sansError(p) };
      const notes = [];
      const sans = p.buffers.sans;
      let main = p.buffers[mainKey];
      if (!main) { main = sans; notes.push(`${FONT_LABEL[mainKey]}暂时不可用，已改用黑体`); }
      let mark = main, dropMark = false;
      if (bt.mark) {
        if (needSerifMark) {
          if (p.buffers.serif) mark = p.buffers.serif;
          else if (bt.mark === '囍') { dropMark = true; notes.push('宋体暂时不可用，已省略水印'); } // 囍不在黑体字库里，画出来是空框
          else mark = sans;
        }
      }
      return { fonts: { main, mark, sub: bt.font === 'brush' ? sans : main, sans }, notes, dropMark };
    }
  };
}

function sansError(p) {
  const f = p.failed.sans;
  // 没登记 = 还没上传；其余 = 下载 / 校验失败，稍后重试
  return f && f.code === 'NOT_READY' ? '字体准备中，请稍后重试' : '字体加载失败，请重试';
}

module.exports = { createLoader, planFor, FONT_FILES, FONT_LABEL, STORAGE_DIR, sha256 };
