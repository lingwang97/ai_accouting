// 云函数 init — 一键初始化数据库集合（幂等，可重复调用）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = ['users', 'accounts', 'records', 'print_templates', 'books', 'gifts_out', 'exports', 'members', 'invites', 'settings', 'subscriptions', 'reminders'];

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 1, msg: '未获取到用户身份', data: null };
  const created = [], existed = [];

  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (e) {
      // 已存在/并发创建等一律视为已存在（各云函数另有幂等自愈兜底）
      existed.push(name);
    }
  }

  // 权限说明：云函数不受集合权限限制；控制台须把全部集合设为「所有用户不可读写」（前端不直连数据库）
  return {
    code: 0, msg: 'ok',
    data: { openid: OPENID, created, existed }
  };
};
