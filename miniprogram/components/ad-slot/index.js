// components/ad-slot — 流量主广告位（是否展示由 utils/ads.js 按配置决定；加载失败或用户关闭后隐藏）
const ads = require('../../utils/ads.js');

Component({
  properties: {
    slot: { type: String, value: '' },
    bookType: { type: String, value: '' }
  },

  data: { unit: '', hidden: false },

  lifetimes: {
    attached() { this.refresh(); }
  },

  observers: {
    bookType() { if (this._ready) this.refresh(); }
  },

  methods: {
    async refresh() {
      this._ready = true;
      const unit = await ads.unitFor(this.data.slot, this.data.bookType);
      this.setData({ unit });
    },
    onError(e) {
      console.warn('广告加载失败', e.detail && e.detail.errCode); // 1004 无合适广告等，静默隐藏
      this.setData({ hidden: true });
    },
    onClose() { this.setData({ hidden: true }); }
  }
});
