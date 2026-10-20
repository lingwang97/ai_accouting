// utils/group.js — 待确认礼金按批次分组（待确认页、礼簿页共用）
// 批次录入的多位随礼人合成一组（records 为各人记录），普通记录自成一组
const fmt = require('./format.js');
const samename = require('./samename.js');

/** 份数：批次按人数计 */
function countOf(groups) {
  return groups.reduce((n, g) => n + (g.records ? g.records.length : 1), 0);
}

/** 待确认记录按批次分组；普通记录自成一组 */
function groupRecords(list) {
  const map = new Map();
  for (const r of list) {
    const key = r.batchId || r._id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.values()].map(recs => {
    recs.sort((a, b) => (a.batchIdx || 0) - (b.batchIdx || 0));
    const first = recs[0];
    const fen = recs.reduce((s, r) => s + Math.round(r.amount * 100), 0);
    const batch = recs.length > 1;
    // 混合支付（服务端标记 batchPay: 'mixed'）：每人各自 payMethod，分别小计
    const mixed = recs.some(r => r.batchPay === 'mixed');
    const cashFen = recs.filter(r => r.payMethod === 'cash').reduce((s, r) => s + Math.round(r.amount * 100), 0);
    return {
      ...first,
      batch,
      mixed,
      methodLabel: mixed ? '转账+现金' : (first.payMethod === 'cash' ? '现金' : '转账'),
      // 列表说明行：付款方式只写一次（转账+现金写明各多少）
      methodText: mixed ? `转账 ￥${fmt.money((fen - cashFen) / 100)} + 现金 ￥${fmt.money(cashFen / 100)}` : (first.payMethod === 'cash' ? '宾客现金' : '已转账'),
      othersStr: recs.slice(1).map(r => samename.nameStr(r.payerName, r.nameTag)).join('、'),
      wechatSumStr: fmt.money((fen - cashFen) / 100),
      cashSumStr: fmt.money(cashFen / 100),
      records: recs.map(r => ({ ...r, amountStr: fmt.money(r.amount), nameStr: samename.nameStr(r.payerName, r.nameTag) })),
      payerName: batch ? `${first.payerName} 等 ${recs.length} 人` : first.payerName,
      nameStr: batch ? `${samename.nameStr(first.payerName, first.nameTag)} 等 ${recs.length} 人` : samename.nameStr(first.payerName, first.nameTag),
      amount: fen / 100,
      amountStr: fmt.money(fen / 100),
      relation: batch ? '' : first.relation,
      remark: batch ? '' : first.remark,
      timeStr: fmt.time(first.transferredAt || first.createdAt)
    };
  });
}

module.exports = { countOf, groupRecords };
