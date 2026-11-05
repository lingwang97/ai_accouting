// pages/admin/preflight.js — 上线前检查里只能在手机上做的检测（v3.72.2）
// 1. 集合客户端权限：用小程序端 wx.cloud.database() 逐个试读，读不到（-502003 权限不足）= 已锁 ✓；能读到 = 未锁 ✗
// 2. 隐私保护指引：wx.getPrivacySetting 返回 privacyContractName 即已在后台配置
// 3. 基础库：本机基础库与最低要求 2.21.2 比较（控制台「最低基础库」设置本身查不到，列在手动清单）
const MIN_LIB = '2.21.2';

/** 版本号比较：a<b 负数，相等 0，a>b 正数 */
function compareVersion(a, b) {
  const x = String(a || '0').split('.'), y = String(b || '0').split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

const errText = e => String((e && (e.errMsg || e.message)) || '') + ' ' + String((e && e.errCode) || '');

/** 试读一个集合：返回 'locked' | 'open' | 'missing' | 'unknown' */
function probeOne(db, name) {
  return new Promise(resolve => {
    let done = false;
    const end = v => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => end('unknown'), 8000);
    try {
      db.collection(name).limit(1).get({
        success: () => end('open'),
        fail: e => {
          const t = errText(e);
          if (/-502003|permission|权限/i.test(t)) end('locked');
          else if (/-502005|not exist|不存在/i.test(t)) end('missing');
          else end('unknown');
        }
      });
    } catch (e) { end('unknown'); }
  });
}

const WRITE_TIP = '试读查不出「仅创建者可读写」（读不到但能写）：请在控制台确认全部集合为「所有用户不可读写」，guest_receipts（宾客随礼凭证）必须设为所有用户不可读写';

/** 各集合的客户端权限 → 一条检查项 */
async function collections(names) {
  let db;
  try { db = wx.cloud.database(); } catch (e) { db = null; }
  if (!db) return { group: '数据库', label: '集合权限（手机试读）', status: 'warn', text: '云开发未初始化，无法检测', fix: '在控制台逐个确认' };
  const res = await Promise.all(names.map(n => probeOne(db, n)));
  const open = names.filter((n, i) => res[i] === 'open');
  const unknown = names.filter((n, i) => res[i] === 'unknown' || res[i] === 'missing');
  if (open.length) return { group: '数据库', label: '集合权限（手机试读）', status: 'bad', text: '客户端能读到：' + open.join('、'), fix: '云开发控制台 → 数据库 → 这些集合 → 数据权限改为「所有用户不可读写」（guest_receipts 必须设为所有用户不可读写）' };
  if (unknown.length) return { group: '数据库', label: '集合权限（手机试读）', status: 'warn', text: `${names.length - unknown.length} 个已锁；${unknown.join('、')} 未能确认`, fix: '集合不存在先建集合；网络问题重试' };
  // 试读只能发现「客户端可读」；「仅创建者可读写」同样读不到但客户端能新建文档（可伪造凭证等），要在控制台核对（v3.86.10）
  return { group: '数据库', label: '集合权限（手机试读）', status: 'ok', text: `${names.length} 个都读不到。${WRITE_TIP}`, fix: '' };
}

function privacy() {
  return new Promise(resolve => {
    if (typeof wx.getPrivacySetting !== 'function') {
      return resolve({ group: '小程序后台', label: '用户隐私保护指引', status: 'manual', text: '本机基础库不支持检测', fix: '在小程序后台确认已配置' });
    }
    wx.getPrivacySetting({
      success: r => resolve(r && r.privacyContractName
        ? { group: '小程序后台', label: '用户隐私保护指引', status: 'ok', text: '已配置：' + r.privacyContractName, fix: '' }
        : { group: '小程序后台', label: '用户隐私保护指引', status: 'bad', text: '未检测到隐私指引', fix: '小程序后台 → 设置 → 服务内容声明 → 用户隐私保护指引' }),
      fail: () => resolve({ group: '小程序后台', label: '用户隐私保护指引', status: 'manual', text: '检测失败', fix: '在小程序后台确认已配置' })
    });
  });
}

function baseInfo() {
  let sdk = '', envVersion = '';
  try { sdk = (wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()).SDKVersion || ''; } catch (e) { /* 忽略 */ }
  try { envVersion = wx.getAccountInfoSync().miniProgram.envVersion; } catch (e) { /* 忽略 */ }
  return { sdk, envVersion };
}

/** 手机端全部检测 */
async function run(colNames, version) {
  const { sdk, envVersion } = baseInfo();
  const ENV = { develop: '开发版', trial: '体验版', release: '正式版' };
  const [cols, priv] = await Promise.all([collections(colNames), privacy()]);
  const lib = !sdk ? { group: '小程序后台', label: '基础库', status: 'manual', text: '读不到本机基础库', fix: '' }
    : compareVersion(sdk, MIN_LIB) >= 0
      ? { group: '小程序后台', label: '基础库', status: 'ok', text: `本机 ${sdk}（最低要求 ${MIN_LIB}）`, fix: '后台「最低基础库」需手动设为 ' + MIN_LIB }
      : { group: '小程序后台', label: '基础库', status: 'warn', text: `本机 ${sdk} 低于 ${MIN_LIB}`, fix: '升级微信后再测；后台「最低基础库」设为 ' + MIN_LIB };
  const ver = { group: '小程序后台', label: '当前版本', status: 'ok', text: `${ENV[envVersion] || envVersion || '未知'} · v${version}`, fix: '' };
  return [cols, priv, lib, ver];
}

module.exports = { run, compareVersion, probeOne, MIN_LIB };
