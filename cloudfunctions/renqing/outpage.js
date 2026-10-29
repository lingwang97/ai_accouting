// outpage.js — 「送出的礼」分页合并（纯函数，便于本地模拟测试）
// 两路数据：手动登记（gifts_out，数据库按 date、createdAt、_id 倒序取前 N 条）+ 自动送礼（宾客随礼入簿，条数少，整体取回内存）
// 统一排序键：date 降序 → createdAt 降序 → _id 降序（全序，无并列），两路各自内部同序，所以合并后取 [offset, offset+size) 与「全量排序后切片」完全一致：
// 合并页只需要手动前 offset+size 条（更靠后的不可能进入本页）+ 自动全部。翻页不重不漏。

const ts = v => { const t = v ? new Date(v).getTime() : 0; return isNaN(t) ? 0 : t; };

/** 比较器：返回负数表示 a 排在 b 前（倒序） */
function cmp(a, b) {
  const da = String(a.date || ''), db = String(b.date || '');
  if (da !== db) return da < db ? 1 : -1;
  const ta = ts(a.createdAt), tb = ts(b.createdAt);
  if (ta !== tb) return ta < tb ? 1 : -1;
  const ia = String(a._id || ''), ib = String(b._id || '');
  if (ia === ib) return 0;
  return ia < ib ? 1 : -1;
}

/**
 * manualTop：手动登记按同序取的前 N 条（N >= offset + size，或已取完）
 * auto：自动送礼全部（已按关键字过滤）
 */
function mergePage(manualTop, auto, offset, size) {
  const a = auto.slice().sort(cmp);
  const out = [];
  let i = 0, j = 0;
  const end = offset + size;
  while (out.length < end && (i < manualTop.length || j < a.length)) {
    if (j >= a.length || (i < manualTop.length && cmp(manualTop[i], a[j]) <= 0)) out.push(manualTop[i++]);
    else out.push(a[j++]);
  }
  return out.slice(offset, end);
}

module.exports = { cmp, mergePage };
