// pages/guide/guide.js — 使用教程：主家 / 记账人 / 宾客 三类身份，按办事流程分段讲解
// 每一步配一张示意图（mock，用代码画的简化界面，高亮要点的位置），不用截图、不占小程序体积；改界面时同步这里
const theme = require('../../utils/theme.js');

// 示意图里的界面元素（与实际页面保持一致）
const GRID = ['出示礼簿码', '待确认礼金', '礼台记账', '打印机', '一键对账', '礼簿管理']; // 工作台宫格（三行两列）
const MENU = ['主家信息与收款码', '记账人', '蓝牙打印机', '回执样式', '导出与备份']; // 「我的」菜单
const TABBAR = ['工作台', '礼簿', '往来', '我的'];
const GUEST_FLOW = ['扫礼簿码', '填写礼金', '扫一扫付款', '我已完成转账'];

/**
 * 示意图：
 *   grid  工作台宫格，hl 为高亮的格子
 *   menu  「我的」菜单，hl 为高亮的一行；head 为页面顶部的入口（如「切换身份」）
 *   page  某个底部菜单页：bar 为页面顶部的按钮，row 为列表里一行右侧的按钮，hl 为高亮的按钮，tab 为底部高亮的菜单
 *   flow  操作顺序，hl 为当前这一步
 */
const grid = hl => ({ type: 'grid', items: GRID, hl });
const menu = (hl, head) => ({ type: 'menu', items: MENU, hl, head: head || '' });
const page = (tab, bar, hl, row) => ({ type: 'page', tab, bar: bar || [], hl: hl || '', row: row || '' });
const flow = (items, hl) => ({ type: 'flow', items, hl });

// 每一步：标题、说明、在哪里操作、示意图、可选跳转页面（tab=true 为底部菜单页，用 switchTab；go 为链接文字，默认「去设置」）
const GUIDES = {
  host: [
    {
      sec: '办事前准备',
      steps: [
        { title: '完善主家信息与收款码', desc: '填写主家称呼，上传微信个人收款码，宾客转账就付到这里', where: '我的 → 主家信息与收款码', mock: menu('主家信息与收款码'), url: '/pages/account/account' },
        { title: '新建礼簿', desc: '一场办事建一本礼簿，礼金分开记；新建后设为当前礼簿', where: '工作台 → 礼簿管理', mock: grid('礼簿管理'), url: '/pages/books/books' },
        { title: '连接打印机、设置回执样式（可选）', desc: '连上蓝牙小票机，确认收礼后自动打印；电子回执和小票样式可以自定义', where: '工作台 → 打印机；我的 → 回执样式', mock: grid('打印机'), url: '/pages/printer/printer' },
        { title: '邀请记账人、共享给家人（可选）', desc: '记账人帮你确认、登记礼金，能做哪些事可以逐项设置；家人共享只能查看', where: '我的 → 记账人', mock: menu('记账人'), url: '/pages/members/members' }
      ]
    },
    {
      sec: '办事当天收礼',
      steps: [
        { title: '出示礼簿码', desc: '宾客扫码填写姓名和礼金，再扫收款码转账；也可以打印台卡摆在礼台上', where: '工作台 → 出示礼簿码', mock: grid('出示礼簿码'), url: '/pages/qrcode/qrcode', go: '去出示' },
        { title: '确认收到礼金', desc: '核对微信到账后点确认，礼金即入簿；可一键全部确认，没收到的点「未收到」', where: '工作台 → 待确认礼金', mock: grid('待确认礼金'), url: '/pages/pending/pending', go: '去确认' },
        { title: '礼台记账', desc: '收到现金或当面转账，直接登记入簿，可当场打印小票', where: '工作台 → 礼台记账', mock: grid('礼台记账'), url: '/pages/cash/cash', go: '去记账' }
      ]
    },
    {
      sec: '散场后',
      steps: [
        { title: '一键对账', desc: '按现金、微信、记账人分别汇总，和实际收到的核对', where: '工作台 → 一键对账', mock: grid('一键对账'), url: '/pages/reconcile/reconcile', go: '去对账' },
        { title: '导出与归档', desc: '导出 PDF / Excel 留底；办完的礼簿可在礼簿管理里归档', where: '礼簿 → 导出；我的 → 导出与备份', mock: page('礼簿', ['搜索', '导出'], '导出'), url: '/pages/export/export', go: '去导出' }
      ]
    },
    {
      sec: '平时',
      hideOrg: true, // 机构模式不显示「往来」
      steps: [
        { title: '人情往来与办事提醒', desc: '谁随过礼、该回多少一目了然；记下亲友办事的日期，到时提醒你回礼', where: '底部菜单 → 往来', mock: page('往来', ['收礼往来', '送出的礼'], ''), url: '/pages/renqing/renqing', tab: true, go: '去看看' }
      ]
    }
  ],
  clerk: [
    {
      sec: '加入',
      steps: [
        { title: '接受邀请', desc: '打开主家发来的邀请卡，填写真实姓名后接受，等主家同意', where: '微信里点开邀请卡', mock: flow(['打开邀请卡', '填写真实姓名', '等主家同意'], '填写真实姓名') },
        { title: '切换到主家身份', desc: '同时为几位主家记账、或自己也是主家时，在这里选择现在为谁记账', where: '我的 → 切换身份', mock: menu('', '切换身份') }
      ]
    },
    {
      sec: '办事当天',
      steps: [
        { title: '出示礼簿码', desc: '和主家出示的一样，宾客扫码登记、转账', where: '工作台 → 出示礼簿码', mock: grid('出示礼簿码'), url: '/pages/qrcode/qrcode', go: '去出示' },
        { title: '确认收到', desc: '核对宾客转账到账后确认入簿', where: '工作台 → 待确认礼金', mock: grid('待确认礼金'), url: '/pages/pending/pending', go: '去确认' },
        { title: '礼台记账', desc: '现金、微信、转账+现金，当场登记入簿', where: '工作台 → 礼台记账', mock: grid('礼台记账'), url: '/pages/cash/cash', go: '去记账' },
        { title: '补打小票', desc: '找到那笔礼金，点「补打」', where: '礼簿 → 礼金记录 → 补打', mock: page('礼簿', ['搜索'], '补打', '补打'), url: '/pages/records/records', tab: true, go: '去补打' }
      ]
    },
    {
      sec: '散场后',
      steps: [
        { title: '一键对账', desc: '按支付方式核对现金与微信，交接给主家', where: '工作台 → 一键对账', mock: grid('一键对账'), url: '/pages/reconcile/reconcile', go: '去对账' }
      ]
    }
  ],
  guest: [
    {
      sec: '随礼',
      steps: [
        { title: '扫主家的礼簿码', desc: '用微信扫一扫，扫主家出示的礼簿码或礼台上的台卡', where: '微信 → 扫一扫', mock: flow(GUEST_FLOW, '扫礼簿码') },
        { title: '填写姓名和礼金', desc: '可以替家人一起登记，多人合并转一笔', where: '随礼页', mock: flow(GUEST_FLOW, '填写礼金') },
        { title: '扫收款码付款', desc: '用微信扫一扫扫主家的收款码转账；扫不到时，把收款码存到相册，再从相册识别', where: '随礼页 → 扫一扫付款', mock: flow(GUEST_FLOW, '扫一扫付款') },
        { title: '回来点「我已完成转账」', desc: '主家确认收到后，礼金就入簿了', where: '随礼页', mock: flow(GUEST_FLOW, '我已完成转账') }
      ]
    },
    {
      sec: '之后',
      steps: [
        { title: '查看电子回执', desc: '主家确认后可查看、保存电子回执', where: '首页 → 我的随礼记录', mock: page('首页', ['我的随礼记录'], '我的随礼记录'), url: '/pages/myreceipts/myreceipts', go: '去查看' }
      ]
    }
  ]
};
const TABS = ['host', 'clerk', 'guest'];

Page({
  data: {
    tab: 'host',
    secs: [],
    tabbar: TABBAR,   // 示意图底部菜单（宾客的第一个菜单为「首页」）
    themeStyle: ''
  },

  onLoad(options) {
    const tab = TABS.includes(options.tab) ? options.tab : 'host';
    this.setData({ tab, secs: this.secsOf(tab) });
  },

  onShow() {
    theme.apply(this);
  },

  /** 分段与步骤：机构模式不显示「往来」，礼簿管理称「场次管理」、记账人称「礼台人员」；步骤编号跨段连续 */
  secsOf(tab) {
    const a = getApp().globalData.account;
    const org = !!(a && a.orgMode);
    const rename = x => (!org ? x : ({ 礼簿管理: '场次管理', 记账人: '礼台人员' })[x] || x);
    this.setData({ tabbar: tab === 'guest' ? ['首页'].concat(TABBAR.slice(1)) : TABBAR });
    let n = 0;
    return GUIDES[tab].filter(s => !(s.hideOrg && org)).map(s => ({
      sec: s.sec,
      steps: s.steps.map(st => {
        const mock = st.mock.items ? { ...st.mock, items: st.mock.items.map(rename), hl: rename(st.mock.hl) } : st.mock;
        return { ...st, where: org ? st.where.replace('礼簿管理', '场次管理').replace('我的 → 记账人', '我的 → 礼台人员') : st.where, mock, no: ++n };
      })
    }));
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.t;
    if (tab !== this.data.tab) this.setData({ tab, secs: this.secsOf(tab) });
  },

  /** 去设置：底部菜单页用 switchTab */
  onGo(e) {
    const { s, i } = e.currentTarget.dataset;
    const st = this.data.secs[s] && this.data.secs[s].steps[i];
    if (!st || !st.url) return;
    if (st.tab) wx.switchTab({ url: st.url });
    else wx.navigateTo({ url: st.url });
  }
});
