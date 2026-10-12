// utils/printer.js — 打印高阶封装：模板 + ESC/POS + BLE
const ble = require('./ble.js');
const escpos = require('./escpos.js');
const request = require('./request.js');

let tplCache = null;

/** 取打印模板（带缓存），无则用默认模板 */
async function getTemplate(force) {
  if (tplCache && !force) return tplCache;
  try {
    tplCache = (await request.tplGet()).tpl; // 云函数返回 { tpl }
  } catch (e) {
    tplCache = {
      paperWidth: 32,
      fields: escpos.DEFAULT_FIELDS,
      title: '收款凭证',
      showDivider: true,
      thanks: '谢谢惠顾'
    };
  }
  return tplCache;
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
  const tpl = await getTemplate();
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

module.exports = { getTemplate, isConnected, ensureConnected, printRecord, printTest };
