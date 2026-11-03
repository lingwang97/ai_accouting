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
//   paid → void（作废；入簿 72 小时内可直接修改 / 作废，超期经随礼人同意，见 EDIT_MS）；礼台现金登记直接 transferred → paid / 直接 paid

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

/**
 * 已入簿礼金的修改 / 作废时限（v3.85.0）：从「确认收到」（paidAt）起 72 小时，不顺延（修改不重新计时；申诉入簿会重置 paidAt）。
 * 超期要「申请更正」，经随礼人同意后才生效（correction，CORR_MS 内未处理自动过期）。
 * LOCK_SINCE：功能上线时间；之前入簿的老记录，窗口取 max(paidAt, LOCK_SINCE) + 72 小时，给老用户一个缓冲。
 */
const EDIT_MS = 72 * HOUR;
const CORR_MS = 7 * 24 * HOUR;
const LOCK_SINCE = new Date('2026-11-04T00:00:00+08:00').getTime();
/** 可直接修改 / 作废的截止时间（毫秒）；没有 paidAt 的返回 0（已过期） */
const editDeadline = r => (r && r.paidAt ? Math.max(new Date(r.paidAt).getTime(), LOCK_SINCE) + EDIT_MS : 0);
/** 原子更新条件里用的 paidAt 下限：缓冲期内（now 早于 LOCK_SINCE + 72 小时）不需要，返回 null */
const editCut = now => (now < LOCK_SINCE + EDIT_MS ? null : new Date(now - EDIT_MS));

/** 礼簿页「全部」列表显示的状态：已入簿 + 待确认 + 宾客未点转账 */
const LISTED = [REC.PAID, REC.TRANSFERRED, REC.PENDING];
/** 对宾客端「已登记过」的口径（姓名查重、往来合并）：与 LISTED 相同 */
const COUNTED = LISTED;

/** 是否是「待确认」：宾客已点转账、等主家确认的记录（礼簿页确认按钮、角标、红点同一口径） */
const isToConfirm = r => !!r && r.status === REC.TRANSFERRED;

module.exports = { REC, MEMBER, PENDING_TTL, STALL_MS, STALL_KEEP_MS, UNREJECT_MS, EDIT_MS, CORR_MS, LOCK_SINCE, editDeadline, editCut, LISTED, COUNTED, isToConfirm };
