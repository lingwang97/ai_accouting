// utils/batch.js — 批次录入：名单校验（随礼页与现金登记页共用，组件见 components/batch-list）
const MAX = 10; // 与云函数 payment 批次上限一致

/**
 * 校验名单，返回 { items } 或 { error }（页面提交前调用）
 * 空行忽略；至少 1 人；姓名不重复；每人金额 > 0
 */
function validate(rows) {
  const items = [];
  for (const r of rows || []) {
    const name = (r.name || '').trim();
    const raw = String(r.amount || '').trim();
    if (!name && !raw && !(r.remark || '').trim()) continue;
    if (!name) return { error: '请填写每位随礼人的姓名' };
    if (!(Number(raw) > 0)) return { error: `请填写 ${name} 的金额` };
    if (items.some(x => x.name === name)) return { error: `${name} 重复填写` };
    items.push({ name, amount: Math.round(Number(raw) * 100) / 100, relation: r.relation || '', remark: (r.remark || '').trim() });
  }
  if (!items.length) return { error: '请填写随礼人' };
  if (items.length > MAX) return { error: `一次最多登记 ${MAX} 人` };
  return { items };
};

module.exports = { MAX, validate };
