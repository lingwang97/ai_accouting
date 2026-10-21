// components/loading — 数据加载提示（骨架 / 转圈 / 全屏转圈遮罩）
// show 为真超过 delay 毫秒（默认 300）才显示动画，加载很快时不会闪一下；失败 / 完成时页面把 show 置假即退出
// type: skeleton 骨架（列表页，rows 行）| spinner 转圈 + 文案 | overlay 全屏遮罩转圈（表单页，加载期间不可操作）
Component({
  options: { addGlobalClass: false },
  properties: {
    show: { type: Boolean, value: false },
    type: { type: String, value: 'skeleton' },
    text: { type: String, value: '加载中…' },
    rows: { type: Number, value: 4 },
    delay: { type: Number, value: 300 }
  },
  data: { visible: false, blocking: false, list: [0, 1, 2, 3] },
  observers: {
    show(v) { this.sync(v); },
    rows(n) { this.setData({ list: Array.from({ length: Math.max(1, Math.min(n || 4, 10)) }, (_, i) => i) }); }
  },
  lifetimes: {
    attached() { this.sync(this.data.show); },
    detached() { this.clear(); }
  },
  methods: {
    noop() {},
    clear() { if (this._t) { clearTimeout(this._t); this._t = null; } },
    sync(v) {
      this.clear();
      if (!v) {
        if (this.data.visible || this.data.blocking) this.setData({ visible: false, blocking: false });
        return;
      }
      // 遮罩型：立即拦截操作（透明），300ms 后才出现转圈
      if (this.data.type === 'overlay') this.setData({ blocking: true });
      if (this.data.visible) return;
      this._t = setTimeout(() => { this._t = null; this.setData({ visible: true }); }, this.data.delay);
    }
  }
});
