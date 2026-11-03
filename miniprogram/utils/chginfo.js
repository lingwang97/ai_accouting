// utils/chginfo.js — 礼簿页「有改动」：每笔的改动类型标签与改动前后的值（v3.85.2）
// 数据取自记录上的 amendLog（修改记录，最近 20 次）、correction / corrState（更正申请）、voidedAt / status（作废）。纯函数，无 wx 依赖。
const fmt = require('./format.js');
const trail = require('./trail.js');
const { REC } = require('./status.js');

const t = x => (x ? new Date(x).getTime() : 0);
const NAMES = { amount: '金额', payerName: '姓名', relation: '关系', remark: '备注' };

/** amendLog 一条的改动：金额 ￥200 → ￥300；姓名 张三 → 张山 */
function diffText(changes) {
  return Object.keys(changes || {}).map(k => {
    const [b, n] = changes[k];
    return k === 'amount' ? `金额 ￥${fmt.money(b)} → ￥${fmt.money(n)}` : `${NAMES[k] || k} ${b || '空'} → ${n || '空'}`;
  }).join('；');
}

/** 更正申请的内容：申请 金额 ￥200 → ￥300；理由：… */
function corrText(r) {
  const c = r.correction || {};
  const what = c.kind === 'amount' ? `申请 金额 ￥${fmt.money(r.amount)} → ￥${fmt.money(c.newAmount)}`
    : (c.kind === 'name' ? `申请 姓名 ${r.payerName} → ${c.newName}` : '申请作废这笔');
  return what + (c.reason ? `；理由：${c.reason}` : '');
}

/** 一笔记录最近一次改动：{ tag 类型标签, cls 颜色, text 改动前后的值 }；没有改动返回 null */
function of(r) {
  if (!r) return null;
  const log = Array.isArray(r.amendLog) ? r.amendLog : [];
  const am = log.length ? log[log.length - 1] : null;
  const cs = r.corrState;
  if (cs === 'pending' && r.correction) return { tag: '更正待确认', cls: 'warn', text: corrText(r) };
  const corrT = t(r.corrDecidedAt) || t(r.corrAt);
  // 拒绝 / 过期的更正申请：晚于最近一次修改 / 作废时，显示申请结果（原记录没变）
  if ((cs === 'declined' || cs === 'expired') && r.correction && corrT >= Math.max(t(r.amendedAt), t(r.voidedAt))) {
    return { tag: cs === 'declined' ? '随礼人拒绝' : '已过期', cls: 'gray', text: corrText(r) + (cs === 'declined' ? '（对方没同意，记录不变）' : '（7 天没处理，记录不变）') };
  }
  const byGuest = r.correction && cs === 'agreed' ? '（随礼人同意）' : '';
  if (r.status === REC.VOID) return { tag: '已作废', cls: 'bad', text: `作废前 金额 ￥${fmt.money(r.amount)}${r.voidedAt ? '，' + fmt.dateTime(r.voidedAt) : ''}${byGuest}` };
  if (am) return { tag: '已更正', cls: 'ok', text: (diffText(am.changes) || '已修改') + (am.by === '随礼人同意更正' ? '（随礼人同意）' : '') };
  return null;
}

/** 点开详情：完整的修改记录（amendLog）+ 处理经过（trail，家人共享看不到）；新的在前 */
function detail(r) {
  const log = (Array.isArray(r.amendLog) ? r.amendLog : []).slice().reverse().map(l => `${fmt.dateTime(l.at)} ${l.by || ''}\n${diffText(l.changes)}`);
  const tr = trail.lines(r.trail).reverse();
  const parts = [];
  if (log.length) parts.push('【修改记录】\n' + log.join('\n'));
  if (tr.length) parts.push('【处理经过】\n' + tr.join('\n'));
  return parts.join('\n\n') || '暂无';
}

module.exports = { of, detail, diffText, corrText };
