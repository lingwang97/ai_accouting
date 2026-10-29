// utils/avatar.js — 头像：登录时把微信临时头像上传到云存储 avatars/，库里存 fileID（cloud://）；login 云函数只接受 avatars/ 下的文件
// 旧版本存的是 chooseAvatar 的临时路径（http://tmp/…、wxfile://…），重启后或别人手机上都打不开，统一当作「没有头像」显示默认图
const DEFAULT = '/assets/avatar-default.png';

/** 能长期使用的头像地址：云文件 / 线上图片 */
const isValid = u => /^(cloud:\/\/|https:\/\/)/.test(String(u || '')) && !/^https:\/\/tmp\//.test(String(u || ''));

/** 显示用：旧的临时路径返回空串，页面回落到默认头像 */
const safe = u => (isValid(u) ? u : '');

/** 上传临时头像到云存储，返回 fileID；失败 reject */
function upload(tempPath) {
  return new Promise((resolve, reject) => {
    // 文件名只用时间与随机串，不含 openid 片段（fileID 会出现在成员列表里，v3.68.1）
    const rnd = () => Math.random().toString(36).slice(2, 10);
    const name = `${Date.now().toString(36)}-${rnd()}${rnd()}`;
    wx.cloud.uploadFile({
      cloudPath: `avatars/${name}.jpg`,
      filePath: tempPath,
      success: r => resolve(r.fileID),
      fail: reject
    });
  });
}

module.exports = { DEFAULT, isValid, safe, upload };
