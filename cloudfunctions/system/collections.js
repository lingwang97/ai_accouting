// collections.js — 数据库集合清单：init（一键建集合）、system（上线前检查）共用，保证两处一致。
// 源文件在 tools/cloud-shared/collections.js，由 tools/sync_shared.py 复制到 init、system 云函数目录，勿在副本里直接修改。
// 新增集合时：加到 COLLECTIONS；用户数据要同时加到 purge.js 的 targets，否则（不属于用户的）写进 NOT_PURGED 并说明原因。
// tests/collections.test.js 会检查这三处是否一致。

const COLLECTIONS = ['users', 'accounts', 'records', 'print_templates', 'books', 'gifts_out', 'exports', 'members', 'invites', 'settings', 'subscriptions', 'reminders', 'person_alias', 'admin_logs', 'book_codes', 'trash_books', 'trash_records', 'rate_limits', 'sys_config'];

/** 不由 purge.targets 清除的集合及原因（清除账户时不需要 / 另有处理） */
const NOT_PURGED = {
  settings: '系统设置（管理员 / 预热 / 广告），不属于用户',
  admin_logs: '管理员操作日志',
  rate_limits: '限流计数（短期自清理）',
  sys_config: '往来人标识密钥，注销与清除测试数据都不能动',
  exports: 'purge.run 里单独处理（先删文件再删登记）',
  subscriptions: '用户注销保留开通记录，管理员清除时由 opts.subscription 删'
};

module.exports = { COLLECTIONS, NOT_PURGED };
