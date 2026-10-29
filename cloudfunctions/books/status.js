// status.js — 记录状态与时间阈值常量。源文件在 tools/cloud-shared/status.js，
// 由 tools/sync_shared.py 复制到各云函数目录和 miniprogram/utils/，勿在副本里直接修改。
//
// 注意：records.status 与 members.status 都有 'pending' 这个值，含义完全不同，所以分成两组常量：
//   REC     礼金记录（records）的状态
//   MEMBER  记账人 / 家人共享（members）的状态：pending = 通过邀请卡加入、等主家同意
//
// 礼金记录状态流转：
//   pending（宾客登记了，还没点「我已完成转账」）→ transferred（宾客点了，等主家确认）→ paid（已入簿）
//   pending 超过 PENDING_TTL 没点转账 → cancelled（autoCancelled=true，宾客之后仍可补点）
//   transferred / pending → rejected（主家点「未收到」，UNREJECT_MS 内可撤销）
//   paid → void（作废）；礼台现金登记直接 transferred → paid / 直接 paid

const REC = {
  PENDING: 'pending',
  TRANSFERRED: 'transferred',
  PAID: 'paid',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  VOID: 'void'
};

const MEMBER = {
  PENDING: 'pending',
  ACTIVE: 'active'
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** 宾客登记后超过这么久仍未点「我已完成转账」，自动取消（惰性执行） */
const PENDING_TTL = 30 * MIN;
/** 宾客登记后超过这么久还没点「我已完成转账」，主家在待确认页的「宾客未点完成」里能看到 */
const STALL_MS = 3 * MIN;
/** 自动取消的记录，在「宾客未点完成」里保留多久 */
const STALL_KEEP_MS = 24 * HOUR;
/** 主家点「未收到」后多久内可撤销，同时也是「未收到」分组的展示期 */
const UNREJECT_MS = 24 * HOUR;

/** 礼簿页「全部」列表显示的状态：已入簿 + 待确认 + 宾客未点转账 */
const LISTED = [REC.PAID, REC.TRANSFERRED, REC.PENDING];
/** 对宾客端「已登记过」的口径（姓名查重、往来合并）：与 LISTED 相同 */
const COUNTED = LISTED;

/** 是否是「待确认」：宾客已点转账、等主家确认的记录（礼簿页确认按钮、角标、红点同一口径） */
const isToConfirm = r => !!r && r.status === REC.TRANSFERRED;

module.exports = { REC, MEMBER, PENDING_TTL, STALL_MS, STALL_KEEP_MS, UNREJECT_MS, LISTED, COUNTED, isToConfirm };
