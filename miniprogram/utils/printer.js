// utils/printer.js — 打印高阶封装：模板 + ESC/POS + BLE
// 打印样式跟礼簿走：每本礼簿可各自设置；未设置时按事由类型套用场景默认
const ble = require('./ble.js');
const escpos = require('./escpos.js');
const request = require('./request.js');
const scenes = require('./scenes.js');
const qrprint = require('./qrprint.js');

const tplCache = {}; // bookId -> 打印模板

/** 场景默认打印模板 */
function defaultTemplate(bookType, paperWidth) {
  return {
    paperWidth: paperWidth === 48 ? 48 : 32,
    fields: escpos.DEFAULT_FIELDS,
    showDivider: true,
    ...scenes.byType(bookType).print
  };
}

/** 取某本礼簿的打印模板（带缓存）；bookId 为空时取当前礼簿 */
async function getTemplate(force, bookId) {
  const key = bookId || '_active';
  if (tplCache[key] && !force) return tplCache[key];
  try {
    const r = await request.bookGetTpl(bookId);
    const t = r.printTpl || defaultTemplate(r.book.type, r.paperWidth);
    // 二维码开关：模板没设置过时默认关（v3.59.0）
    tplCache[key] = typeof t.qr === 'boolean' ? t : { ...t, qr: escpos.qrOn(t) };
  } catch (e) {
    // 拉取失败只本次用默认模板，不写缓存，下次打印再重试，避免一次网络抖动后一直用错样式
    return defaultTemplate('other', 32);
  }
  return tplCache[key];
}

/** 修改样式后清缓存 */
function clearTemplateCache() {
  Object.keys(tplCache).forEach(k => delete tplCache[k]);
}

function isConnected() {
  return !!ble.state.deviceId;
}

/** 打印任务串行队列：并发的打印 / 连接请求排队执行，避免多个任务交错写同一台打印机 */
let _queue = Promise.resolve();
function enqueue(fn) {
  const run = _queue.then(fn);
  _queue = run.catch(() => {});
  return run;
}

let _connecting = null; // 进行中的连接请求，重复调用共用同一个
/** 确保已连接：优先当前连接，其次记忆设备重连（冷启动后需先打开蓝牙适配器） */
function _ensure() {
  if (isConnected()) return Promise.resolve(true);
  if (_connecting) return _connecting;
  _connecting = (async () => {
    if (!ble.loadDevice()) return false;
    try {
      await ble.openAdapter();
    } catch (e) {
      return false;
    }
    const info = await ble.reconnectSaved();
    return !!info;
  })();
  const clear = () => { _connecting = null; };
  _connecting.then(clear, clear); // 不用 finally，兼容低版本基础库
  return _connecting;
}

function ensureConnected() {
  return enqueue(_ensure);
}

/** 打印一笔账目；成功后回写 printed 标记 */
function printRecord(record) {
  return enqueue(() => _printRecord(record));
}

async function _printRecord(record) {
  if (!(await _ensure())) {
    throw new Error('打印机未连接，请先到"我的 → 蓝牙打印机"连接');
  }
  const tpl = await getTemplate(false, record.bookId);
  // 小票上显示主家称呼；记账人取这笔礼金的确认人（刚确认时本地还没有，用当前登录人）
  const app = getApp();
  record = {
    ...record,
    // 同名区分备注：只印宾客自己填的；主家 / 礼台的私下备注不外露
    payerName: record.nameTag && record.nameTagBy === 'guest' ? `${record.payerName}（${record.nameTag}）` : record.payerName,
    accountName: record.hostName || record.accountName || (app.globalData.account && app.globalData.account.accountName) || '',
    handlerName: record.handlerName || (app.globalData.user && app.globalData.user.nickname) || ''
  };
  const qr = escpos.qrOn(tpl) && record._id ? await _qrBytes(record) : null;
  await _writeRetry(escpos.buildReceipt(record, tpl, qr ? { qr } : undefined));
  try {
    await request.markPrinted([record._id]);
  } catch (e) {
    // 回写失败不影响打印结果，下次会重复提示，可手动忽略
    console.warn('markPrinted 失败', e);
  }
  return true;
}

// 熔断（v3.58.1）：生成小程序码失败时，后面的小票不再每张都等一遍
//  - 配置类原因（未配置 / 错误的 AppSecret、无生成权限、页面不存在、额度用完、码图解析失败）：30 分钟内直接跳过
//  - 偶发原因（超时、网络、云函数调用失败）：连续 2 次后 5 分钟内跳过
// 设置页「检测小程序码生成」成功时 resetQrBreaker() 清除
const QR_SKIP_LONG = 30 * 60 * 1000;
const QR_SKIP_SHORT = 5 * 60 * 1000;
const _qrBreak = { until: 0, fails: 0, reason: '' };
const _permanent = reason => /secret-missing|85407|token:|40001|40013|40125|41030|45009|decode:/.test(String(reason || ''));
function _qrFail(reason, now) {
  _qrBreak.reason = String(reason || 'timeout');
  if (_permanent(reason)) { _qrBreak.until = now + QR_SKIP_LONG; return; }
  _qrBreak.fails++;
  if (_qrBreak.fails >= 2) _qrBreak.until = now + QR_SKIP_SHORT;
}
function resetQrBreaker() { _qrBreak.until = 0; _qrBreak.fails = 0; _qrBreak.reason = ''; }

/** 取这一笔的小程序码光栅字节（云端已转好 GS v 0）；任何失败（无权限、额度、网络慢）都返回 null：这张小票不印二维码，打印照常 */
async function _qrBytes(record, now = Date.now()) {
  if (_qrBreak.until > now) return null; // 熔断中：不印二维码，不等待
  try {
    const r = await Promise.race([
      request.issueQr(record._id),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
    ]);
    const bytes = (r && qrprint.fromBase64(r.raster)) || null;
    if (bytes) { _qrBreak.fails = 0; return bytes; }
    if (r && r.reason) console.warn('小程序码生成失败', r.reason); // 原因码，不含敏感信息
    _qrFail(r && r.reason, now);
    return null;
  } catch (e) {
    // 超时 / 网络算偶发；这一笔本身被拒（如未入簿、无权）只影响这一笔，不计入熔断
    if (e && e.message === 'timeout') _qrFail('timeout', now);
    else if (e && e.errMsg) _qrFail('net', now); // wx.cloud.callFunction 失败（网络 / 云函数超时）；业务拒绝是 request.js 抛的 Error，没有 errMsg
    return null;
  }
}

/** 小程序码测试页：真实小程序码（指向首页，scene test=1），用于设置页实测识别率 */
function printQrTest() {
  return enqueue(async () => {
    if (!(await _ensure())) throw new Error('打印机未连接');
    const r = await request.qrCheck(true);
    if (!r.ok || !r.raster) { const e = new Error('小程序码生成失败'); e.reason = r.reason; throw e; }
    await _writeRetry(escpos.buildQrTest(qrprint.fromBase64(r.raster)));
    return true;
  });
}

function printTest() {
  return enqueue(async () => {
    if (!(await _ensure())) {
      throw new Error('打印机未连接');
    }
    await _writeRetry(escpos.buildTestLine());
    return true;
  });
}

/** 打印花边测试（v3.60.0）：按设置页当前（未必已保存）的样式印一张示例小票，用来在真机上确认花纹、侧边字符和排版 */
function printBorderSample(tpl, bookType) {
  return enqueue(async () => {
    if (!(await _ensure())) throw new Error('打印机未连接');
    const now = new Date();
    const rec = {
      _id: 'sample0000000', payerName: '张三', amount: 888, payMethod: 'wechat', paidAt: now, createdAt: now,
      accountName: '示例主家', handlerName: '示例记账', themeName: '花边测试', relation: '朋友', remark: '示例备注：花边测试',
      bookType: bookType || 'other'
    };
    await _writeRetry(escpos.buildReceipt(rec, tpl));
    return true;
  });
}

const PARTIAL_MSG = '打印中途中断，请检查小票后补打';

/** 中途中断的错误：已有部分内容出纸，不自动重打整张，避免出两张 */
function _partialError(e) {
  const err = new Error(PARTIAL_MSG);
  err.partial = true;
  err.errCode = e && e.errCode;
  return err;
}

/** 仅第一包就失败（尚未出纸）才断开重连并整单重试 1 次（文档 §8）；中途失败不重打 */
async function _writeRetry(buffer) {
  try {
    await ble.writeBuffer(buffer);
  } catch (e) {
    ble.disconnect();
    if (e && e.written > 0) throw _partialError(e);
    if (!(await _ensure())) throw new Error('打印机连接已断开');
    try {
      await ble.writeBuffer(buffer);
    } catch (e2) {
      ble.disconnect();
      if (e2 && e2.written > 0) throw _partialError(e2);
      throw e2;
    }
  }
}

module.exports = { getTemplate, defaultTemplate, clearTemplateCache, isConnected, ensureConnected, printRecord, printTest, printQrTest, printBorderSample, resetQrBreaker, _qrBytes };
