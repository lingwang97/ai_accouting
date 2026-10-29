// 往来人标识密钥：环境变量 PERSON_KEY_SECRET > 集合 sys_config 文档 person_key（自动生成）> 旧内置默认值（仅数据库读不到时的兜底）
// 密钥只留在内存，不写日志、不返回前端
const crypto = require('crypto');

const COL = 'sys_config';
const DOC_ID = 'person_key';
const STATE_ID = 'person_key_state'; // 来源状态（只含来源和时间，供管理员「上线前检查」展示，不含密钥）
const LEGACY = 'huilj.person-key.v1';
const FALLBACK_TTL = 10 * 1000; // 兜底（数据库读不到）只缓存 10 秒，之后重试

const sha = s => crypto.createHash('sha256').update(String(s)).digest();

/**
 * @param {object} db     云数据库实例
 * @param {object} env    环境变量（默认 process.env）
 */
function create(db, env) {
  env = env || process.env;
  let cached = null; // { key: Buffer, source, until }
  let pending = null;
  let stateWritten = '';

  async function readDoc() {
    const r = await db.collection(COL).doc(DOC_ID).get();
    const d = r && r.data;
    if (!d || d._openid || typeof d.secret !== 'string' || d.secret.length < 32) return null; // 带 _openid 的是伪造文档，忽略
    return d;
  }

  async function load() {
    if (env.PERSON_KEY_SECRET) return { key: sha(env.PERSON_KEY_SECRET), source: 'env' };
    // 读库，不存在时生成；并发创建靠固定 _id，只有一个 add 成功，其余重新读取
    let missing = false;
    for (let i = 0; i < 3; i++) {
      try {
        const d = await readDoc();
        if (d) return { key: sha(d.secret), source: 'db' };
        missing = true; // 文档存在但内容无效：不覆盖，按读不到处理
        break;
      } catch (e) {
        if (/not exist|not found|-502005|-502004|DATABASE_COLLECTION_NOT_EXIST|DOCUMENT_NOT_EXIST/i.test(String((e && (e.errMsg || e.message)) || '') + String((e && e.errCode) || ''))) {
          missing = true;
          break;
        }
        await new Promise(r => setTimeout(r, 150));
      }
    }
    if (!missing) return { key: sha(LEGACY), source: 'default', fallback: true }; // 数据库读失败：不生成、不写入
    try { await db.createCollection(COL); } catch (e) { /* 已存在 */ }
    for (let i = 0; i < 3; i++) {
      try {
        await db.collection(COL).add({ data: { _id: DOC_ID, secret: crypto.randomBytes(32).toString('hex'), createdAt: new Date() } });
      } catch (e) { /* 重复 _id（别的实例已创建）或集合刚建好尚未就绪：下面重新读取 */ }
      try {
        const d = await readDoc();
        if (d) return { key: sha(d.secret), source: 'db' };
      } catch (e) { /* 重试 */ }
      await new Promise(r => setTimeout(r, 300));
    }
    return { key: sha(LEGACY), source: 'default', fallback: true };
  }

  async function recordState(source) {
    if (stateWritten === source) return;
    stateWritten = source;
    try {
      await db.collection(COL).doc(STATE_ID).set({ data: { source, at: new Date() } });
    } catch (e) { /* 仅展示用，失败忽略 */ }
  }

  /** 取得密钥（实例内缓存） */
  async function getKey() {
    if (cached && (!cached.fallback || cached.until > Date.now())) return cached.key;
    if (!pending) {
      pending = load().then(r => {
        cached = { ...r, until: Date.now() + FALLBACK_TTL };
        if (!r.fallback) recordState(r.source);
        return r;
      }).finally(() => { pending = null; });
    }
    return (await pending).key;
  }

  const IV = Buffer.alloc(16, 0); // 固定 IV：同一个人每次得到同一个标识，前端可用来比较

  function hideKeyWith(key, k) {
    const m = /^o:([\w-]{1,64}):(.*)$/.exec(k);
    if (!m) return k;
    const c = crypto.createCipheriv('aes-256-cbc', key, IV);
    const enc = Buffer.concat([c.update(m[1], 'utf8'), c.final()]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `h:${enc}:${m[2]}`;
  }
  function showKeyWith(key, k) {
    const m = /^h:([\w-]{1,128}):(.*)$/.exec(k);
    if (!m) return k;
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', key, IV);
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const oid = Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
      return /^[\w-]{1,64}$/.test(oid) ? `o:${oid}:${m[2]}` : '';
    } catch (e) { return ''; } // 解密失败（旧密钥的标识等）：返回空串，业务按「标识无效」处理，不抛错
  }

  return { getKey, hideKeyWith, showKeyWith };
}

module.exports = { create, COL, DOC_ID, STATE_ID, LEGACY };
