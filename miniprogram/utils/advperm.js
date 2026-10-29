// utils/advperm.js — 「我的 → 高级功能」各项的可用性（纯函数，无 wx 依赖，tests/advanced.test.js 校验）
// 返回 { enabled, reason, contact, vip }：
//   enabled 能否操作；reason 不能操作时显示在项目下方、点击时弹窗说明的原因；
//   contact 原因是「需要开通套餐」时弹窗带「联系我们」按钮（权限 / 角色原因只说明）；vip 旁边显示「会员」小标签。
// 云端仍会校验（account.setOrgMode / setPeak 等），这里只决定界面显示。
// v3.70.0 去掉「工作台刷新频率」（改为智能刷新，见 utils/poller.js），pollItem / pollOptionEnabled 已删除。

/**
 * 机构模式：只有主家本人、且套餐含机构版才能打开；已开启的账号照常使用，关闭任何时候都可以（套餐到期也能关）
 * @param {{role:string, orgMode:boolean, features:object}} s
 */
function orgItem(s) {
  const has = !!(s.features && s.features.org);
  const vip = !has;
  if (s.role !== 'owner') return { enabled: false, reason: '仅主家可设置', contact: false, vip };
  if (has || s.orgMode) return { enabled: true, reason: '', contact: false, vip };
  return { enabled: false, reason: '机构版功能，开通后可使用', contact: true, vip };
}

/**
 * 新礼金微信提醒（v3.66.3，默认关闭，不是会员功能）：主家与有「确认收礼」权限的记账人可开启；家人共享只读、没有确认权限的记账人置灰
 * @param {{role:string, perms:string[]|null}} s
 */
function giftItem(s) {
  if (s.role === 'viewer') return { enabled: false, reason: '家人共享为只读，无需设置', contact: false, vip: false };
  const can = s.role === 'owner' || (s.role === 'clerk' && !!s.perms && s.perms.indexOf('confirm') >= 0);
  if (!can) return { enabled: false, reason: '需要「确认收礼」权限', contact: false, vip: false };
  return { enabled: true, reason: '', contact: false, vip: false };
}

/**
 * 去广告状态卡（v3.62.0，纯展示）：只在主家 / 记账人侧显示；会员（套餐不是 free）不展示广告，免费版展示广告位
 * 宾客页面的广告不随主家，保持按免费显示（8B）
 * @param {{role:string, plan:string}} s plan 为套餐 key（free / pro ...）
 */
function adItem(s) {
  if (s.role !== 'owner' && s.role !== 'clerk') return { show: false };
  const member = !!s.plan && s.plan !== 'free';
  return {
    show: true,
    member,
    text: member ? '已开通会员，小程序内不再显示广告' : '开通会员后，主家与记账人使用的页面不再显示广告'
  };
}

/**
 * 回收站保留时间（v3.63.0）：只有主家本人可设置；选项 15 / 30 / 60 天，套餐 features.trashDays 限制最长天数（缺项 / 0 = 60，全部开放）
 * @param {{role:string, features:object}} s
 */
function trashItem(s) {
  if (s.role !== 'owner') return { enabled: false, reason: '仅主家可设置', contact: false, vip: false, max: 15 };
  const n = Number(s.features && s.features.trashDays);
  const max = n > 0 ? n : 60;
  const partial = max < 60;
  return partial
    ? { enabled: true, partial: true, max, reason: '免费版回收站保留 15 天，30 / 60 天为会员功能，开通会员后可选', contact: true, vip: true }
    : { enabled: true, max, reason: '', contact: false, vip: false };
}
/** 某个天数能否选：15 天始终可选；其余要求权限且不超过套餐上限 */
function trashOptionEnabled(item, days) {
  if (!item.enabled) return false;
  return days <= 15 || days <= item.max;
}

/**
 * 数量额度卡（v3.63.0）：礼簿数 / 记账人数与上限（0 = 当前不限）；只在主家侧显示
 * @param {{role:string, orgMode:boolean, adv:{books:number, clerks:number, maxBooks:number, maxClerks:number}|null}} s
 */
function quotaItem(s) {
  if (s.role !== 'owner' || !s.adv) return { show: false };
  const a = s.adv, org = !!s.orgMode;
  const bw = org ? '场次' : '礼簿', cw = org ? '礼台人员' : '记账人';
  const bu = org ? '个' : '本', cu = '位';
  const limited = a.maxBooks > 0 || a.maxClerks > 0;
  const full = (a.maxBooks > 0 && a.books >= a.maxBooks) || (a.maxClerks > 0 && a.clerks >= a.maxClerks);
  return {
    show: true, limited, full,
    bookLine: a.maxBooks > 0 ? `${bw} ${a.books}/${a.maxBooks} ${bu}` : `${bw} ${a.books} ${bu}，不限`,
    clerkLine: a.maxClerks > 0 ? `${cw} ${a.clerks}/${a.maxClerks} ${cu}` : `${cw} ${a.clerks} ${cu}，不限`,
    reason: '已达到当前套餐的上限，开通会员可添加更多；已有的数据不受影响，只是不能再新增'
  };
}

/** 高峰模式剩余时间文案：「7 小时 30 分钟」「20 分钟」；已到期或未开启返回空串（工作台提示条与高级功能页共用） */
function peakLeftText(peakUntil, now) {
  const t = now || Date.now();
  if (!(peakUntil > t)) return '';
  const left = peakUntil - t;
  let hh = Math.floor(left / 3600000), mm = Math.ceil((left % 3600000) / 60000);
  if (mm >= 60) { hh += 1; mm = 0; } // 59 分钟多进位，不显示「60 分钟」
  return hh > 0 ? `${hh} 小时 ${mm} 分钟` : `${Math.max(1, mm)} 分钟`;
}

/**
 * 办事日高峰模式（v3.64.0）：只有主家本人能开关；记账人（有确认收礼权限）自动跟随主家，不单独设置；套餐 features.peakMode === false 时不能开启
 * @param {{role:string, features:object, peakUntil:number, now:number}} s peakUntil 毫秒，0 = 未开启
 */
function peakItem(s) {
  const now = s.now || Date.now();
  const on = s.peakUntil > now;
  const leftText = peakLeftText(s.peakUntil, now);
  const closed = !!(s.features && s.features.peakMode === false);
  if (s.role !== 'owner') return { enabled: false, on, leftText, reason: s.role === 'clerk' ? '仅主家可开关，主家开启后礼台人员自动变快' : '仅主家可设置', contact: false, vip: false };
  // 已开启的可以随时关闭（套餐到期也能关）
  if (closed && !on) return { enabled: false, on, leftText, reason: '会员功能，开通后可使用', contact: true, vip: true };
  return { enabled: true, on, leftText, reason: '', contact: false, vip: closed };
}

module.exports = { peakLeftText, peakItem, orgItem, giftItem, adItem, trashItem, trashOptionEnabled, quotaItem };
