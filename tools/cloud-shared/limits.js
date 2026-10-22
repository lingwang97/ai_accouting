// 公共限额（由 tools/sync_shared.py 复制到 payment / renqing / account，勿在云函数目录里直接改）
// 前端输入框 maxlength="11"（如 10000000.00）与此一致

/** 单笔礼金上限（元）：1000 万；换算成分为 1e9，仍在安全整数内 */
const MAX_AMOUNT = 10000000;
const MAX_MSG = '单笔金额不能超过1000万元';

module.exports = { MAX_AMOUNT, MAX_MSG };
