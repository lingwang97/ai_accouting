// utils/samename.js — 重名区分：同名宾客 / 往来人选择、区分备注输入（礼台记账、记送礼、往来详情共用）
// 取消任何一步返回 null，调用方据此中止，不提示错误

const NEW_ITEM = '新的一位（填区分备注）';
const SHEET_MAX = 6; // wx.showActionSheet 最多 6 项

/** 区分备注规整：去掉 # : 空白，最多 12 字（与云函数一致） */
const cleanTag = s => String(s || '').trim().replace(/[#:\s]/g, '').slice(0, 12);

/** 显示名：张伟（李村）；无备注时原样 */
const nameStr = (name, tag) => (tag ? `${name || ''}（${tag}）` : (name || ''));

/** 截断到 n 字（ActionSheet 一行放不下） */
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 操作菜单：返回选中下标，取消返回 -1（alertText 仅安卓显示） */
function sheet(itemList, alertText) {
  return new Promise(resolve => {
    wx.showActionSheet({
      itemList,
      ...(alertText ? { alertText } : {}),
      success: res => resolve(res.tapIndex),
      fail: () => resolve(-1)
    });
  });
}

/**
 * 输入区分备注（必填）：空则重新输入，取消返回 null
 * opts.guest：宾客扫码登记时的同名提醒（标题提示同名，提示填村名、单位）
 */
function askTag(name, opts = {}) {
  return new Promise(resolve => {
    const ask = () => wx.showModal({
      title: opts.guest ? `已有同名「${name}」` : '区分备注',
      content: '',
      editable: true,
      placeholderText: opts.guest ? '填村名、单位等，方便主家辨认' : '如：李村、公司同事',
      success: res => {
        if (!res.confirm) return resolve(null);
        const t = cleanTag(res.content);
        if (t) return resolve(t);
        wx.showToast({ title: `请填写区分备注${name ? '，区分' + name : ''}`, icon: 'none' });
        setTimeout(ask, 800);
      },
      fail: () => resolve(null)
    });
    ask();
  });
}

/**
 * 从已有同名的人里选择，或选「新的一位」并填区分备注
 * people: [{ label, ... }]（最多取前 SHEET_MAX-1 位，调用方先按最近排好）
 * 返回 { person } | { tag } | null（取消）
 */
async function choose(name, people) {
  const list = people.slice(0, SHEET_MAX - 1);
  const idx = await sheet(list.map(p => cut(p.label, 22)).concat(NEW_ITEM), `已有同名「${name}」，是哪一位？`);
  if (idx < 0) return null;
  if (idx < list.length) return { person: list[idx] };
  const tag = await askTag(name);
  return tag ? { tag } : null;
}

/**
 * 礼台记账同名判断（纯函数，可测）。people 为 nameCheck 返回的某个姓名下的人 [{ ref, tag, scanned, relation, count, inBook, lastDay }]
 *  - none：没有同名的人，直接记
 *  - ask：弹窗选。本场（inBook > 0）已有同名（可能重复登记或同名不同人），或以前的礼簿里有两位及以上
 *    people 返回排好序的副本：本场的在前（标 inBook），其余按最近往来倒序
 *  - auto：本场没有、以前的礼簿只有一位：不弹窗，按同一个人处理（personRef / tag 取这一位的）
 * 旧云函数没有 inBook 字段时无法判断本场，一律按 ask（原行为）
 */
function decide(people) {
  const list = (people || []).slice().sort((a, b) =>
    ((b.inBook > 0) - (a.inBook > 0)) || String(b.lastDay || '').localeCompare(String(a.lastDay || '')));
  if (!list.length) return { type: 'none', people: list };
  const known = list.every(p => typeof p.inBook === 'number');
  if (!known || list.some(p => p.inBook > 0) || list.length > 1) return { type: 'ask', people: list };
  return { type: 'auto', people: list, person: list[0] };
}

/** 弹窗里一位的文字：张伟（李村） · 本场 · 亲戚 · 2笔；有 inBook 字段才区分本场 / 以前的礼簿 */
function labelOf(name, p) {
  const where = typeof p.inBook !== 'number' ? '' : (p.inBook > 0 ? '本场' : '以前的礼簿');
  return [`${name}（${p.tag || (p.scanned ? '扫码' : '未区分')}）`, where, p.relation, `${p.count}笔`].filter(Boolean).join(' · ');
}

/** 自动归并后的提示（批次多人合成一条）：notes [{ name, person }] */
function autoNotice(notes) {
  if (!notes.length) return '';
  const one = n => `${nameStr(n.name, n.person.tag)}（${[n.person.relation, n.person.count + '笔'].filter(Boolean).join(' · ')}）`;
  return `已归到以前随过礼的 ${notes.map(one).join('、')}。如果其实是不同的人，可到「往来」页区分。`;
}

module.exports = { decide, labelOf, autoNotice, NEW_ITEM, SHEET_MAX, cleanTag, nameStr, sheet, askTag, choose };
