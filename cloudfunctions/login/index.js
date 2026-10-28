// 云函数 login — 登录注册（文档 §6.1）
const cloud = require('wx-server-sdk');
const { ok, err } = require('./common.js');
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
  // 预热：warmer 云函数按「系统设置」定时唤醒，保持实例常驻、减少冷启动；直接返回，不做任何读写
  if (event && (event.action === '__warm' || event.Type === 'Timer')) return { code: 0, msg: 'warm', data: null }; // Timer：兼容之前上传过的旧预热触发器
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return err('未获取到用户身份');
  const userInfo = event.userInfo || {};

  try {
    await ensureCol('users');
    // 只认云函数写入的用户记录（客户端直接写库伪造的带 _openid，忽略）
    const found = await users.where({ openid: OPENID, _openid: db.command.exists(false) }).limit(1).get();
    // 静默检查登录态：已注册返回用户，未注册返回 null（不创建，付款方无需注册）
    if (event.action === 'check') {
      return ok({ openid: OPENID, user: found.data[0] || null });
    }
    const now = db.serverDate();
    // 头像只接受本小程序云存储 avatars/ 下的文件（v3.68.1）；其他值（任意网址、临时路径）一律不存
    const avatar = await acceptAvatar(String(userInfo.avatar || ''), OPENID);
    if (found.data.length === 0) {
      const user = {
        openid: OPENID,
        nickname: String(userInfo.nickname || '微信用户').slice(0, 20),
        avatar: avatar || '',
        createdAt: now,
        lastLoginAt: now
      };
      // 文档 id 用 openid：并发首次登录只会建一条，重复的 add 报错后读回已建的
      try {
        await users.add({ data: { _id: OPENID, ...user } });
      } catch (e) {
        const again = await users.where({ openid: OPENID, _openid: db.command.exists(false) }).limit(1).get();
        if (again.data[0]) return ok({ openid: OPENID, user: again.data[0], isNew: false });
        throw e;
      }
      return ok({ openid: OPENID, user: { _id: OPENID, ...user }, isNew: true });
    }
    const u = found.data[0];
    const data = { nickname: String(userInfo.nickname || u.nickname).slice(0, 20), lastLoginAt: now };
    if (avatar && avatar !== u.avatar) data.avatar = avatar;
    await users.doc(u._id).update({ data });
    // 换了头像：删掉旧的头像文件（只删 avatars/ 下、没有别人在用的）
    if (data.avatar && isAvatarFile(u.avatar)) await removeAvatar(u.avatar, OPENID);
    return ok({ openid: OPENID, user: { ...u, ...data, lastLoginAt: undefined }, isNew: false });
  } catch (e) {
    console.error('login', e);
    return err('登录失败，请稍后重试');
  }
};

/** 是否本小程序云存储 avatars/ 目录下的头像文件 */
function isAvatarFile(v) {
  return /^cloud:\/\/[^/\s]+\/avatars\/[A-Za-z0-9_.-]{1,80}\.(jpg|jpeg|png|webp)$/i.test(String(v || ''));
}

/** 可接受的头像：avatars/ 下的文件，且没有被别的用户使用（防止把别人的头像文件挂到自己名下，清除数据时误删）；否则返回空 */
async function acceptAvatar(v, openid) {
  if (!isAvatarFile(v) || v.length > 300) return '';
  try {
    const n = (await users.where({ avatar: v, openid: db.command.neq(openid) }).count()).total;
    return n ? '' : v;
  } catch (e) { return ''; }
}

/** 删除不再使用的头像文件（失败忽略） */
async function removeAvatar(fileID, openid) {
  try {
    const n = (await users.where({ avatar: fileID, openid: db.command.neq(openid) }).count()).total;
    if (!n) await cloud.deleteFile({ fileList: [fileID] });
  } catch (e) { console.warn('删除旧头像失败', e.message); }
}
