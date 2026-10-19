// pages/guide/guide.js — 使用说明：主家 / 记账人 / 宾客 三类身份的操作步骤
const theme = require('../../utils/theme.js');

// 每一步：标题、一行说明、可选跳转页面（tab=true 为底部菜单页，用 switchTab；go 为链接文字，默认「去设置」）
const STEPS = {
  host: [
    { title: '完善主家信息与收款码', desc: '填写主家称呼，上传微信个人收款码', url: '/pages/account/account' },
    { title: '新建礼簿并设为当前', desc: '每场办事建一本礼簿，礼金分开记', url: '/pages/books/books' },
    { title: '出示礼簿码 / 打印台卡', desc: '宾客扫码登记姓名礼金，再扫收款码转账', url: '/pages/qrcode/qrcode', go: '去出示' },
    { title: '确认收到礼金', desc: '核对微信到账后确认入簿，可一键全部确认', url: '/pages/pending/pending', go: '去确认' },
    { title: '连接打印机、设置回执样式', desc: '确认后自动打印小票，回执样式可自定义', url: '/pages/printer/printer' },
    { title: '邀请记账人、共享给家人', desc: '记账人分工记账，家人只读查看', url: '/pages/members/members' },
    { title: '对账与导出', desc: '按支付方式汇总核对，导出 PDF / Excel', url: '/pages/reconcile/reconcile', go: '去对账' },
    { title: '人情往来与回礼提醒', desc: '收礼送礼一本账，亲友办事到期提醒', url: '/pages/renqing/renqing', tab: true, go: '去看看' }
  ],
  clerk: [
    { title: '接受邀请', desc: '打开邀请卡，填写真实姓名接受，等主家同意' },
    { title: '切换到主家身份', desc: '在「我的」点「切换身份」，选择为谁记账' },
    { title: '礼台记账', desc: '现金 / 微信 / 转账+现金，当场登记入簿', url: '/pages/cash/cash', go: '去记账' },
    { title: '确认收到', desc: '核对宾客转账后确认入簿（需权限）', url: '/pages/pending/pending', go: '去确认' },
    { title: '补打小票', desc: '在「礼簿」找到礼金记录点「补打」', url: '/pages/records/records', tab: true, go: '去补打' },
    { title: '对账', desc: '散场后按支付方式核对现金与微信', url: '/pages/reconcile/reconcile', go: '去对账' }
  ],
  guest: [
    { title: '扫主家的礼簿码', desc: '填姓名和礼金，可多人一起登记' },
    { title: '保存收款码转账', desc: '微信「扫一扫」→ 相册选收款码转账' },
    { title: '回来点「我已完成转账」', desc: '等主家确认收到，礼金即入簿' },
    { title: '查看回执', desc: '在「我的随礼记录」查看电子回执', url: '/pages/myreceipts/myreceipts', go: '去查看' }
  ]
};
const TABS = ['host', 'clerk', 'guest'];

Page({
  data: {
    tab: 'host',
    steps: STEPS.host,
    themeStyle: ''
  },

  onLoad(options) {
    const tab = TABS.includes(options.tab) ? options.tab : 'host';
    this.setData({ tab, steps: STEPS[tab] });
  },

  onShow() {
    theme.apply(this);
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.t;
    if (tab !== this.data.tab) this.setData({ tab, steps: STEPS[tab] });
  },

  /** 去设置：底部菜单页用 switchTab */
  onGo(e) {
    const s = this.data.steps[e.currentTarget.dataset.i];
    if (!s || !s.url) return;
    if (s.tab) wx.switchTab({ url: s.url });
    else wx.navigateTo({ url: s.url });
  }
});
