// utils/confirm.js — 主家确认/拒绝礼金（礼簿页与待确认页共用）
// 批次录入的礼金以"组"处理：group.records 为同一批次的多位随礼人，确认 / 拒绝整批，金额不符时逐人改金额
const req = require('./request.js');
const { REC } = require('./status.js');
const printer = require('./printer.js');
const fmt = require('./format.js');
const notify = require('./notify.js');

/**
 * 确认收到 → 自动打印；金额不符时可按实际到账入簿。返回是否已确认
 * 批次（record.records 多于 1 人）选「金额不符」时返回 'edit'，由页面打开逐人改金额
 */
function confirmTransfer(record) {
  notify.renewSilently(); // 在点击中顺带续订下一笔提醒
  const amount = fmt.money(record.amount);
  const isBatch = isGroup(record);
  const who = isBatch
    ? `${record.payerName}（${record.records.map(r => r.payerName + ' ￥' + fmt.money(r.amount)).join('、')}）`
    : record.payerName;
  const mixed = !!record.mixed; // 批次混合支付：部分转账、部分现金
  const cash = !mixed && record.payMethod === 'cash';
  return new Promise(resolve => {
    wx.showModal({
      title: `${mixed ? '转账+现金' : (cash ? '现金' : '宾客登记')} ￥${amount}`,
      content: mixed
        ? `请核对 ${who}：微信转账 ￥${record.wechatSumStr}、现金 ￥${record.cashSumStr} 是否都已收到`
        : (cash ? `请清点 ${who} 交来的现金是否为 ￥${amount}` : `请核对微信收到 ${who} 的转账金额是否为 ￥${amount}`),
      confirmText: '一致入簿', // 按钮文字最多 4 个字，超出弹窗会直接失败
      cancelText: '金额不符',
      success: res => {
        if (res.confirm) return resolve(doConfirm(record));
        if (res.cancel) return resolve(isBatch ? 'edit' : askActual(record));
        resolve(false);
      },
      fail: () => resolve(false)
    });
  });
}

/** 金额不符：输入实际到账金额 */
function askActual(record) {
  return new Promise(resolve => {
    wx.showModal({
      title: '实际到账金额',
      editable: true,
      placeholderText: `宾客登记 ￥${fmt.money(record.amount)}，请输入实际收到的金额`,
      confirmText: '按此入簿',
      success: res => {
        if (!res.confirm) return resolve(false);
        const actual = Number(String(res.content || '').replace(/[,，\s]/g, '')); // 去掉千分位逗号与空格
        if (!(actual > 0)) {
          wx.showToast({ title: '金额不正确', icon: 'none' });
          return resolve(false);
        }
        resolve(doConfirm(record, actual));
      },
      fail: () => resolve(false)
    });
  });
}

async function doConfirm(record, actual) {
  let r;
  try {
    r = await req.payConfirm(record._id, actual);
  } catch (e) {
    return false; // request.js 已 toast
  }
  wx.showToast({ title: '已记入礼簿', icon: 'success' }); // 成功图标最多显示 7 个字
  getApp().refreshBadge();
  // 打印放到后台（v3.65.2）：不等打印 / 重连，马上可以确认下一笔；打印异常时合并成一条提示
  printLater(r.list || [r.record || { ...record, amount: actual || record.amount }], '已记入礼簿');
  return true;
}

/** 后台自动打印，有异常时提示（不抛错） */
function printLater(list, head) {
  autoPrint(list).then(note => {
    if (note) wx.showToast({ title: `${head}（${note}）`, icon: 'none', duration: 2500 });
  }).catch(() => {});
}

/** 批次按逐人实际金额入簿：amounts 为 {rid: 金额}，只需列出与登记不一致的 */
async function confirmGroupAmounts(group, amounts) {
  let r;
  try {
    r = await req.payConfirm(group._id, undefined, amounts);
  } catch (e) {
    return false;
  }
  wx.showToast({ title: '已按实收入簿', icon: 'success' });
  getApp().refreshBadge();
  printLater(r.list || [r.record], '已按实收入簿');
  return true;
}

const isGroup = r => !!(r && r.records && r.records.length > 1);

/** 批量确认收到 → 逐张自动打印；返回成功笔数 */
const BATCH = 20; // 与云函数 payment.confirmBatch 单次上限一致
function confirmBatch(records) {
  notify.renewSilently();
  const fen = records.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  return new Promise(resolve => {
    wx.showModal({
      title: `确认收到 ${records.length} 份礼金`,
      content: `合计 ￥${fmt.money(fen / 100)}，请核对微信已全部收到`,
      confirmText: '全部收到',
      success: async res => {
        if (!res.confirm) return resolve(0);
        const done = [];
        const failed = [];
        wx.showLoading({ title: '正在入簿…', mask: true });
        try {
          // 分批提交，避免单次云函数超时
          for (let i = 0; i < records.length; i += BATCH) {
            const r = await req.payConfirmBatch(records.slice(i, i + BATCH).map(x => x._id));
            done.push(...r.list);
            failed.push(...r.failed);
          }
        } catch (e) { /* 网络或超时：已提交的批次已入簿，下面按实际结果提示 */ }
        wx.hideLoading();

        // 逐张打印；没配过打印机不打印也不提示；连不上时暂停自动打印 10 分钟，结果统一在最后弹窗说明
        let printNote = '';
        const st = done.length ? await printer.autoConnect() : 'none';
        if (st === 'ok') {
          let printed = 0;
          let partial = false;
          for (let i = 0; i < done.length; i++) {
            wx.showLoading({ title: `打印 ${i + 1}/${done.length}`, mask: true });
            try {
              await printer.printRecord({ ...done[i], status: REC.PAID });
              printed++;
            } catch (e) {
              partial = !!(e && e.partial);
              break; // 打印机多半已断开，不再逐张重连；其余的到礼簿页补打
            }
          }
          wx.hideLoading();
          const failedPrint = done.length - printed;
          if (failedPrint) {
            printNote = `\n${failedPrint} 张未打印成功，可在礼簿页补打。` + (partial ? '其中一张可能只打了一半，请检查小票。' : '');
          }
        } else if (st === 'failed') {
          printNote = '\n打印机未连上，10 分钟内不再自动打印，可在礼簿页补打。';
        } else if (st === 'paused') {
          printNote = '\n自动打印已暂停（打印机未连上），可在礼簿页补打。';
        }
        getApp().refreshBadge();
        const notDone = records.length - done.length;
        if (notDone || printNote) {
          wx.showModal({
            title: `已入簿 ${done.length} 份`,
            content: ((notDone ? `${notDone} 份未入簿（状态已变化或网络中断），请刷新后查看。` : '') + printNote).replace(/^\n/, ''),
            showCancel: false
          });
        } else {
          wx.showToast({ title: `已入簿 ${done.length} 份`, icon: 'none' });
        }
        resolve(done.length);
      },
      fail: () => resolve(0)
    });
  });
}

/** 未收到款；返回是否已标记 */
function rejectTransfer(record) {
  const amount = fmt.money(record.amount);
  return new Promise(resolve => {
    wx.showModal({
      title: '未收到礼金',
      content: `确定未收到 ${record.payerName} 的 ￥${amount} ？${isGroup(record) ? '整批都将标记为未收到，' : ''}宾客将看到"主家未确认收到"。点错了 24 小时内可在待确认页撤销`,
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return resolve(false);
        try {
          await req.payReject(record._id);
          wx.showToast({ title: '已标记', icon: 'success' });
          getApp().refreshBadge();
          resolve(true);
        } catch (e) {
          resolve(false);
        }
      },
      fail: () => resolve(false)
    });
  });
}

/** 确认后自动打印（批次每人一张）；返回给调用方合并提示用的说明，打印正常返回空串。打印异常不阻断确认流程 */
async function autoPrint(list) {
  const st = await printer.autoConnect();
  if (st === 'none' || st === 'paused') return ''; // 没配过打印机 / 暂停期内：不打扰
  if (st === 'failed') return '打印机未连上，10 分钟内不再自动打印';
  try {
    for (const record of list) await printer.printRecord({ ...record, status: REC.PAID });
    return '';
  } catch (e) {
    return e && e.partial ? '打印中断，请检查小票后补打' : '打印失败，可补打';
  }
}

module.exports = {
  confirmTransfer,
  confirmDirect: doConfirm,       // 不弹核对框直接入簿（逐笔大字模式，卡片上已显示金额）
  askActualAmount: askActual,     // 金额不符：输入实际到账金额入簿
  confirmGroupAmounts,            // 批次：逐人按实际金额入簿
  confirmBatch,
  rejectTransfer
};
