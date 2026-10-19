// utils/printer.js — 打印高阶封装：模板 + ESC/POS + BLE
// 打印样式跟礼簿走：每本礼簿可各自设置；未设置时按事由类型套用场景默认
const ble = require('./ble.js');
const escpos = require('./escpos.js');
const request = require('./request.js');
const scenes = require('./scenes.js');

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
    tplCache[key] = r.printTpl || defaultTemplate(r.book.type, r.paperWidth);
  } catch (e) {
    tplCache[key] = defaultTemplate('other', 32);
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

/** 确保已连接：优先当前连接，其次记忆设备重连（冷启动后需先打开蓝牙适配器） */
async function ensureConnected() {
  if (isConnected()) return true;
  if (!ble.loadDevice()) return false;
  try {
    await ble.openAdapter();
  } catch (e) {
    return false;
  }
  const info = await ble.reconnectSaved();
  return !!info;
}

/** 打印一笔账目；成功后回写 printed 标记 */
async function printRecord(record) {
  if (!(await ensureConnected())) {
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
  await _writeRetry(escpos.buildReceipt(record, tpl));
  try {
    await request.markPrinted([record._id]);
  } catch (e) {
    // 回写失败不影响打印结果，下次会重复提示，可手动忽略
    console.warn('markPrinted 失败', e);
  }
  return true;
}

async function printTest() {
  if (!(await ensureConnected())) {
    throw new Error('打印机未连接');
  }
  await _writeRetry(escpos.buildTestLine());
  return true;
}

/** 失败自动重试 1 次（文档 §8） */
async function _writeRetry(buffer) {
  try {
    await ble.writeBuffer(buffer);
  } catch (e) {
    ble.disconnect();
    if (!(await ensureConnected())) throw new Error('打印机连接已断开');
    await ble.writeBuffer(buffer);
  }
}

module.exports = { getTemplate, defaultTemplate, clearTemplateCache, isConnected, ensureConnected, printRecord, printTest };
