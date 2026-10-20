// utils/confirm.js — 主家确认/拒绝礼金（礼簿页与待确认页共用）
// 批次录入的礼金以"组"处理：group.records 为同一批次的多位随礼人，确认 / 拒绝整批，金额不符时逐人改金额
const req = require('./request.js');
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
        const actual = Number(String(res.content || '').trim());
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
  try {
    const r = await req.payConfirm(record._id, actual);
    wx.showToast({ title: actual ? `已按 ￥${fmt.money(actual)} 入簿` : '已记入礼簿', icon: 'success' });
    await autoPrint(r.list || [r.record || { ...record, amount: actual || record.amount }]);
    getApp().refreshBadge();
    return true;
  } catch (e) {
    return false; // request.js 已 toast
  }
}

/** 批次按逐人实际金额入簿：amounts 为 {rid: 金额}，只需列出与登记不一致的 */
async function confirmGroupAmounts(group, amounts) {
  try {
    const r = await req.payConfirm(group._id, undefined, amounts);
    wx.showToast({ title: '已按实收入簿', icon: 'success' });
    await autoPrint(r.list || [r.record]);
    getApp().refreshBadge();
    return true;
  } catch (e) {
    return false;
  }
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

        // 逐张打印；打印机未连接时不打印，结果统一在最后弹窗说明
        let printNote = '';
        if (done.length && (await printer.ensureConnected())) {
          for (const r of done) {
            try { await printer.printRecord({ ...r, status: 'paid' }); } catch (e) { /* 失败的可在礼簿页补打 */ }
          }
        } else if (done.length) {
          printNote = '\n打印机未连接，可在礼簿页补打。';
        }
        getApp().refreshBadge();
        const notDone = records.length - done.length;
        if (notDone || printNote) {
          wx.showModal({
            title: `已入簿 ${done.length} 份`,
            content: (notDone ? `${notDone} 份未入簿（状态已变化或网络中断），请刷新后查看。` : '') + printNote,
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
      content: `确定未收到 ${record.payerName} 的 ￥${amount} ？${isGroup(record) ? '整批都将标记为未收到，' : ''}宾客将看到"主家未确认收到"`,
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

/** 确认后自动打印（批次每人一张）；打印机未连接时仅提示，不阻断确认流程 */
async function autoPrint(list) {
  if (!(await printer.ensureConnected())) {
    wx.showToast({ title: '打印机未连接，可在礼簿页补打', icon: 'none' });
    return false;
  }
  try {
    for (const record of list) await printer.printRecord({ ...record, status: 'paid' });
    return true;
  } catch (e) {
    wx.showToast({ title: '自动打印失败，可在礼簿页补打', icon: 'none' });
    return false;
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
