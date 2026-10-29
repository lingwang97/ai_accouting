// meta.js — 上线前检查用的 `__meta` 内部 action（v3.72.2）。源文件在 tools/cloud-shared/meta.js，
// 由 tools/sync_shared.py 复制到各云函数，勿在副本里直接修改。
//
// system.adminPreflight 逐个 callFunction(name, { action: '__meta', nonce })：
//   - 总是返回本函数的内存 / 超时配置（运行时 context.memory_limit_in_mb / time_limit_in_ms，取不到再看环境变量），无敏感信息；
//   - 带有效的一次性凭据 nonce（system 写入 settings.metanonce_*，客户端读不到也伪造不出，带 _openid 的忽略，2 分钟内有效）时，
//     再用本函数的云调用权限探测各 openapi 是否已开通（-604101 = 没开）。探测不会真的发出消息：
//     订阅消息用不存在的模板 ID（有权限时报 40037 等业务错误），文字审核送一句固定的安全文本，图片审核送 1x1 空白图，小程序码只生成不保存。
// 返回值：{ fn, memory(MB|0), timeout(秒|0), perms: { api: 'ok' | 'denied' | 'timeout' | 'error:<码>' } | null }

// 1x1 白色 PNG
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
const NONCE_RE = /^metanonce_[0-9a-f]{24}$/;
const NONCE_TTL = 2 * 60 * 1000;

const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

/** 运行时配置：内存（MB）、超时（秒）；取不到为 0（上线前检查列为手动确认） */
function runtimeOf(context, env) {
  env = env || process.env;
  const c = context || {};
  const memory = num(c.memory_limit_in_mb) || num(env.SCF_FUNCTIONMEMORYSIZE) || num(env.SCF_MEMORY_SIZE) || num(env.TENCENTCLOUD_MEMORY_SIZE);
  const ms = num(c.time_limit_in_ms);
  const timeout = ms ? Math.round(ms / 1000) : (num(env.SCF_FUNCTIONTIMEOUT) || num(env.SCF_TIMEOUT));
  return { memory, timeout };
}

const denied = e => {
  const code = e && (e.errCode !== undefined ? e.errCode : e.code);
  return code === -604101 || String(code) === '-604101' || /-604101|no permission|not authorized|permission denied/i.test(String((e && (e.errMsg || e.message)) || ''));
};

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { __timeout: true })), ms))]);
}

const PROBES = {
  'security.msgSecCheck': (cloud, openid) => cloud.openapi.security.msgSecCheck({ content: '慧礼记上线前检查', version: 2, scene: 1, openid }),
  'security.imgSecCheck': cloud => cloud.openapi.security.imgSecCheck({ media: { contentType: 'image/png', value: TINY_PNG } }),
  'subscribeMessage.send': (cloud, openid) => cloud.openapi.subscribeMessage.send({ touser: openid, templateId: 'preflight-probe-not-exist', data: {} }),
  'wxacode.getUnlimited': cloud => cloud.openapi.wxacode.getUnlimited({ scene: 'preflight', page: 'pages/index/index', checkPath: false, width: 280 })
};

async function probe(cloud, api, openid) {
  try {
    await withTimeout(Promise.resolve().then(() => PROBES[api](cloud, openid)), 8000);
    return 'ok';
  } catch (e) {
    if (e && e.__timeout) return 'timeout';
    if (denied(e)) return 'denied';
    // 有权限、但业务参数不合规（如模板不存在 40037、用户近期未访问 61010）：说明接口可调，算已开通
    const code = e && (e.errCode !== undefined ? e.errCode : e.code);
    if (code !== undefined && code !== null && code !== -1 && String(code) !== '-1') return 'ok';
    return 'error:' + String((e && (e.errMsg || e.message)) || 'unknown').slice(0, 40);
  }
}

/**
 * @param {object} cloud   wx-server-sdk
 * @param {object} event   { action: '__meta', nonce }
 * @param {object} context 云函数第二个参数
 * @param {string[]} apis  本函数需要的云调用权限（与 config.json 的 permissions.openapi 一致）
 */
async function handle(cloud, event, context, apis) {
  const data = { fn: (context && context.function_name) || process.env.SCF_FUNCTIONNAME || '', ...runtimeOf(context), perms: null };
  const id = String((event && event.nonce) || '');
  if (NONCE_RE.test(id) && Array.isArray(apis) && apis.length) {
    let doc = null;
    try { doc = (await cloud.database().collection('settings').doc(id).get()).data; } catch (e) { /* 不存在 */ }
    if (doc && !doc._openid && doc.kind === 'metaprobe' && Date.now() - Number(doc.createdAt || 0) < NONCE_TTL && doc.openid) {
      data.perms = {};
      const res = await Promise.all(apis.map(a => (PROBES[a] ? probe(cloud, a, doc.openid) : Promise.resolve('error:unknown-api'))));
      apis.forEach((a, i) => { data.perms[a] = res[i]; });
    }
  }
  return { code: 0, msg: 'ok', data };
}

module.exports = { handle, runtimeOf, probe, TINY_PNG, NONCE_RE };
