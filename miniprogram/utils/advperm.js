// utils/advperm.js — 「我的 → 高级功能」各项的可用性（纯函数，无 wx 依赖，tests/advanced.test.js 校验）
// 返回 { enabled, reason, contact, vip }：
//   enabled 能否操作；reason 不能操作时显示在项目下方、点击时弹窗说明的原因；
//   contact 原因是「需要开通套餐」时弹窗带「联系我们」按钮（权限 / 角色原因只说明）；vip 旁边显示「会员」小标签。
// 云端仍会校验（account.setOrgMode / setPollLevel），这里只决定界面显示。

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
 * 待确认刷新频率：主家与有「确认收礼」权限的记账人可设置；家人共享只读；套餐关闭 fastRefresh 时高档不可选（标准档始终可选）
 * @param {{role:string, perms:string[]|null, features:object}} s
 */
function pollItem(s) {
  const vip = !!(s.features && s.features.fastRefresh === false);
  if (s.role === 'viewer') return { enabled: false, reason: '家人共享为只读，无需设置', contact: false, vip: false };
  const can = s.role === 'owner' || (s.role === 'clerk' && !!s.perms && s.perms.indexOf('confirm') >= 0);
  if (!can) return { enabled: false, reason: '需要「确认收礼」权限', contact: false, vip: false };
  if (vip) return { enabled: true, partial: true, reason: '会员功能，暂未开通高频刷新', contact: true, vip: true };
  return { enabled: true, reason: '', contact: false, vip: false };
}

/** 某一档是否可选：标准档（off）在有权限时始终可选；其余档要求权限且套餐含该功能 */
function pollOptionEnabled(item, key) {
  if (!item.enabled) return false;
  return key === 'off' || !item.partial;
}

module.exports = { orgItem, pollItem, pollOptionEnabled };
