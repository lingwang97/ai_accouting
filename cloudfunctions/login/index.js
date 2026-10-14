// 云函数 login — 登录注册（文档 §6.1）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const users = db.collection('users');

/** 幂等建集合（init 未跑完时自愈；同一实例每个集合只尝试一次） */
const colReady = {};
async function ensureCol(name) {
  if (colReady[name]) return;
  try { await db.createCollection(name); } catch (e) { /* 已存在则忽略 */ }
  colReady[name] = true;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const userInfo = event.userInfo || {};

  try {
    await ensureCol('users');
    const found = await users.where({ openid: OPENID }).limit(1).get();
    // 静默检查登录态：已注册返回用户，未注册返回 null（不创建，付款方无需注册）
    if (event.action === 'check') {
      return ok({ openid: OPENID, user: found.data[0] || null });
    }
    const now = db.serverDate();
    if (found.data.length === 0) {
      const user = {
        openid: OPENID,
        nickname: String(userInfo.nickname || '微信用户').slice(0, 20),
        avatar: String(userInfo.avatar || '').slice(0, 500),
        createdAt: now,
        lastLoginAt: now
      };
      const added = await users.add({ data: user });
      return ok({ openid: OPENID, user: { _id: added._id, ...user }, isNew: true });
    }
    const u = found.data[0];
    await users.doc(u._id).update({
      data: {
        nickname: String(userInfo.nickname || u.nickname).slice(0, 20),
        avatar: String(userInfo.avatar || u.avatar).slice(0, 500),
        lastLoginAt: now
      }
    });
    return ok({ openid: OPENID, user: u, isNew: false });
  } catch (e) {
    return err('登录失败：' + e.message);
  }
};

const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });
