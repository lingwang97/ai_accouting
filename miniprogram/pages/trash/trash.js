// pages/trash/trash.js — 回收站：删除的礼簿默认保留 15 天（高级功能可选 30 / 60 天），期间可恢复（仍为已归档）或彻底删除；到期自动永久删除
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');

Page({
  data: {
    list: [],
    days: 0,              // 0 = 接口未返回前不显示天数，避免先闪「15 天」
    loading: true,
    busy: false,
    themeStyle: ''
  },

  onShow() {
    theme.apply(this);
    this.load();
  },

  async load() {
    try {
      const { list, days } = await req.trashList();
      const now = Date.now();
      this.setData({
        days,
        list: list.map(t => ({
          ...t,
          title: t.hostName ? `${t.hostName} · ${t.name}` : t.name,
          typeLabel: scenes.label(t.type),
          sumStr: fmt.money(t.sum || 0),
          deletedStr: fmt.day(t.deletedAt),
          // 还剩几天（不足 1 天按 1 天显示）
          leftDays: Math.max(1, Math.ceil((new Date(t.purgeAt).getTime() - now) / 86400000)),
          busyText: t.trashStatus === 'moving' ? '删除中' : (t.trashStatus === 'restoring' ? '恢复中' : '')
        }))
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  /** 恢复：礼簿和礼金记录原样放回，仍为已归档；数据多时分批，done=false 时接着调用 */
  onRestore(e) {
    const t = this.data.list[e.currentTarget.dataset.i];
    if (!t || this.data.busy) return;
    wx.showModal({
      title: '恢复礼簿',
      content: `恢复「${t.title}」及其 ${t.count} 份礼金记录？恢复后在「礼簿管理」的已归档礼簿里。`,
      confirmText: '恢复',
      success: async res => {
        if (!res.confirm) return;
        this.setData({ busy: true });
        wx.showLoading({ title: '正在恢复…', mask: true });
        try {
          for (let i = 0; i < 50; i++) {
            if ((await req.trashRestore(t._id)).done) break;
          }
          wx.hideLoading();
          wx.showToast({ title: '已恢复', icon: 'success' });
          this.load();
        } catch (err) {
          wx.hideLoading(); // request.js 已提示；没恢复完的再点一次恢复会接着进行
        } finally {
          this.setData({ busy: false });
        }
      }
    });
  },

  /** 彻底删除：输入礼簿名称确认，立即永久删除 */
  onPurge(e) {
    const t = this.data.list[e.currentTarget.dataset.i];
    if (!t || this.data.busy) return;
    // 先用普通弹窗完整显示礼簿名称与后果（editable 弹窗的 content 是输入框初始值，不能放说明），再弹输入框
    wx.showModal({
      title: '彻底删除',
      content: `将彻底删除「${t.name}」及其全部记录，删除后不可恢复。`,
      confirmText: '继续',
      confirmColor: '#FA5151',
      success: res1 => {
        if (!res1.confirm) return;
        // 上一个弹窗关闭动画结束后再弹（部分机型在 success 里立刻弹第二个会不显示）
        setTimeout(() => wx.showModal({
          title: '输入礼簿名称确认',
          editable: true,
          placeholderText: '输入礼簿名称',
          confirmText: '删除',
          confirmColor: '#FA5151',
          success: async res => {
            if (!res.confirm) return;
            if ((res.content || '').trim() !== t.name) return wx.showToast({ title: '名称不一致，未删除', icon: 'none' });
            this.setData({ busy: true });
            try {
              await req.trashPurge(t._id, t.name);
              wx.showToast({ title: '已删除', icon: 'success' });
              this.load();
            } catch (err) { /* toast 已提示 */ } finally {
              this.setData({ busy: false });
            }
          }
        }), 300);
      }
    });
  }
});
