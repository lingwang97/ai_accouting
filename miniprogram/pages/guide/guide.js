// pages/guide/guide.js — 使用教程与常见问题：主家 / 记账人 / 宾客 三类身份按办事流程分段讲解，第 4 个分页为常见问题（数据在 faq.js）
// 每一步配一张示意图（mock，用代码画的简化界面，高亮要点的位置），不用截图、不占小程序体积；界面元素清单在 mock.js，改界面时同步那里
const theme = require('../../utils/theme.js');
const { FAQ } = require('./faq.js');
const M = require('./mock.js');

/**
 * 示意图：
 *   grid     工作台宫格，hl 为高亮的格子（机构模式自动多一格「场次汇总」）
 *   menu     「我的」菜单（4 组 11 行），hl 为高亮的一行（只展开它所在的组，其余组收起）；head 为页面顶部的入口（如「切换身份」）
 *   page     某个底部菜单页：bar 为页面顶部的按钮，row 为列表里一行右侧的按钮，hl 为高亮的按钮，tab 为底部高亮的菜单
 *   flow     操作顺序，hl 为当前这一步
 *   cashdesk 礼台记账页：hl 为 status（打印机状态条）/ name / amount / sum（本次已登记）
 *   bars     工作台顶部提示条，hl 为高亮的一条
 *   printer3 打印机的三种状态，hl 为高亮的一种
 */
const grid = hl => ({ type: 'grid', hl });
const menu = (hl, head) => ({ type: 'menu', hl: hl || '', head: head || '' });
const page = (tab, bar, hl, row) => ({ type: 'page', tab, bar: bar || [], hl: hl || '', row: row || '' });
const flow = (items, hl) => ({ type: 'flow', items, hl });
const cashdesk = hl => ({ type: 'cashdesk', hl, c: M.CASHDESK });
const bars = hl => ({ type: 'bars', hl });
const printer3 = hl => ({ type: 'printer3', hl });
const GUEST_FLOW = ['扫礼簿码', '填写礼金', '扫一扫付款', '我已完成转账'];

// 每一步：标题、说明、在哪里操作、示意图、可选跳转页面（tab=true 为底部菜单页，用 switchTab；go 为链接文字，默认「去设置」）
// orgDesc：机构模式另写的说明（不写则套用统一称呼替换）
const GUIDES = {
  host: [
    {
      sec: '办事前准备',
      steps: [
        { title: '完善主家信息与收款码', desc: '填写主家称呼，上传微信个人收款码，宾客转账就付到这里。记账人想换收款码要提交申请，由你点「采用」才生效', where: '我的 → 主家信息与收款码', mock: menu('主家信息与收款码'), url: '/pages/account/account' },
        { title: '新建礼簿', desc: '一场办事建一本礼簿，礼金分开记；新建后设为当前礼簿，宾客扫码记入当前礼簿。办事当天不建议再切换当前礼簿，切换前会确认两次。免费版最多 3 本（含已归档的，回收站里的不算）；同一天办好几场，可在高级功能开启机构模式（会员）分场次收礼',
          orgDesc: '一场办事建一个场次，每个场次有自己的本场礼簿码，宾客扫哪一场的码就记到哪一场，可多场同时收礼。在「场次管理」里新建、归档、导出。免费版最多 3 本（含已归档的，回收站里的不算）',
          where: '工作台 → 礼簿管理 → 新建礼簿', mock: grid('礼簿管理'), url: '/pages/books/books' },
        { title: '连接打印机（可选）', desc: '连上蓝牙小票机，入簿后自动打印小票。工作台「打印机」格会显示当前状态，点它可以连接或重连', where: '工作台 → 打印机；或 我的 → 蓝牙打印机', mock: grid('打印机'), url: '/pages/printer/printer' },
        { title: '看懂打印机的三种状态', desc: '已连接：入簿自动打印。已配对·未连接：多半是打印机没开机或离得远，打开后点一下重连。未配对：这部手机还没设置过。连不上时会提示一次，之后 10 分钟内暂停自动打印（连上就立即恢复），没打出来的可到礼簿页点「补打」。老机器乱码、缺行，到「蓝牙打印机」打开「稳定模式」', where: '工作台 → 打印机', mock: printer3('已连接'), url: '/pages/printer/printer', go: '去看看' },
        { title: '设置回执样式与小票（可选）', desc: '电子回执和打印小票的样式都可以自定义。小票二维码、花边默认关闭，在「打印小票」里打开并可先打印测试；界面颜色可在「我的 → 主题色」更换', where: '我的 → 回执样式', mock: menu('回执样式'), url: '/pages/receiptset/receiptset' },
        { title: '开启新礼金微信提醒（可选）', desc: '宾客转账后微信提醒你。默认关闭，在高级功能打开开关并点「允许」（建议勾选「总是保持以上选择」）。每个人单独设置，记账人要在自己手机上各自打开。高级功能里还有工作台刷新频率、办事日高峰模式和机构模式（均为会员功能）、回收站保留时间', where: '我的 → 高级功能 → 新礼金微信提醒', mock: menu('高级功能'), url: '/pages/advanced/advanced', go: '去开启' },
        { title: '邀请记账人、共享给家人（可选）', desc: '点「邀请记账人」生成邀请卡发给微信好友，7 天内有效、只能 1 人使用；你本人发的卡，对方接受后直接成为记账人，请只发给信任的人。普通模式每位记账人只负责一本礼簿，能做哪些事可逐项设置，免费版最多 3 位。想让家人只看不改：工作台 → 礼簿管理 → 礼簿共享',
          orgDesc: '点「邀请礼台人员」生成邀请卡发给微信好友，7 天内有效、只能 1 人使用；你本人发的卡，对方接受后直接成为礼台人员，请只发给信任的人。礼台人员可负责多个场次，能做哪些事可逐项设置，免费版最多 3 位。想让家人只看不改：工作台 → 场次管理 → 礼簿共享',
          where: '我的 → 记账人', mock: menu('记账人'), url: '/pages/members/members' }
      ]
    },
    {
      sec: '办事当天收礼',
      steps: [
        { title: '出示礼簿码', desc: '宾客扫码填写姓名和礼金，再扫收款码转账；也可以打印台卡摆在礼台上。办事前先打开看一眼，之后手机会保存礼簿码，网络差时也能出示', where: '工作台 → 出示礼簿码', mock: grid('出示礼簿码'), url: '/pages/qrcode/qrcode', go: '去出示' },
        { title: '确认收到礼金', desc: '核对微信到账后点「确认收到」，礼金即入簿并自动打印；多笔可用「列表批量」一次全部确认，也可「逐笔确认」。没收到的点「未收到」，24 小时内可以撤销', where: '工作台 → 待确认礼金', mock: grid('待确认礼金'), url: '/pages/pending/pending', go: '去确认' },
        { title: '看懂工作台顶部的提示条', desc: '网络不稳定：点一下刷新。高峰模式进行中：会员功能，办事当天打开，刷新更快，8 小时后自动恢复。其他礼簿还有待确认礼金：点「切换」去处理。新礼金提醒次数用完：点一下重新开启', where: '工作台 顶部', mock: bars('高峰模式') },
        { title: '礼台记账', desc: '收到现金或当面转账，直接登记入簿，可当场打印小票。顶部是打印机状态条，没连上点「连接」；姓名、金额框会自动聚焦，输完按回车跳下一格；遇到同名会弹窗让你选是同一位还是新的一位；上方显示「本次已登记」份数和合计，方便核对', where: '工作台 → 礼台记账', mock: cashdesk('status'), url: '/pages/cash/cash', go: '去记账' }
      ]
    },
    {
      sec: '散场后',
      steps: [
        { title: '一键对账', desc: '按现金、微信、记账人分别汇总，和实际收到的核对', where: '工作台 → 一键对账', mock: grid('一键对账'), url: '/pages/reconcile/reconcile', go: '去对账' },
        { title: '导出与归档', desc: '导出 PDF / Excel 留底；办完的礼簿可在礼簿管理里归档', where: '我的 → 导出与备份；或 工作台 → 礼簿管理 → 某本礼簿的「导出」', mock: menu('导出与备份'), url: '/pages/export/export', go: '去导出' },
        { title: '删错了？回收站', desc: '只有已归档的礼簿能删除，删除后进回收站，默认保留 15 天（会员可在高级功能改为 30 或 60 天），期间可以恢复，到期自动永久删除', where: '我的 → 回收站', mock: menu('回收站'), url: '/pages/trash/trash', go: '去回收站' }
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
        { title: '接受邀请', desc: '打开主家发来的邀请卡，填写真实姓名后接受。主家本人发的卡，接受后直接成为记账人并进入工作台；如果卡是记账人转发的，要等主家同意，工作台会显示申请进度。邀请卡只能 1 人使用', where: '微信里点开邀请卡', mock: flow(['打开邀请卡', '填写真实姓名', '接受，进入工作台'], '填写真实姓名') },
        { title: '切换到主家身份', desc: '同时为几位主家记账、或自己也是主家时，在这里选择现在为谁记账', where: '我的 → 切换身份', mock: menu('', '切换身份') },
        { title: '了解自己的权限', desc: '能看到哪些入口由主家授予的权限决定，看不到的说明没有这项权限，请联系主家。普通模式下你只负责主家指定的那一本礼簿；家人共享是只读，没有记账入口',
          orgDesc: '能看到哪些入口由主家授予的权限决定，看不到的说明没有这项权限，请联系主家。你可以在工作台顶部自己选正在记的场次，礼台记账、确认收礼都记到这一场；家人共享是只读，没有记账入口',
          where: '工作台', mock: grid('') }
      ]
    },
    {
      sec: '办事当天',
      steps: [
        { title: '开启新礼金微信提醒（可选）', desc: '默认关闭，需要自己在手机上打开：高级功能 → 新礼金微信提醒，点「允许」。主家开了不代表你也有', where: '我的 → 高级功能 → 新礼金微信提醒', mock: menu('高级功能'), url: '/pages/advanced/advanced', go: '去开启' },
        { title: '连接打印机', desc: '连上蓝牙小票机，确认收到后自动打印。工作台「打印机」格显示已连接 / 已配对·未连接 / 未配对；连不上时提示一次后 10 分钟内暂停自动打印，连上即恢复', where: '工作台 → 打印机', mock: printer3('已配对 · 未连接'), url: '/pages/printer/printer', go: '去连接' },
        { title: '出示礼簿码', desc: '和主家出示的一样，宾客扫码登记、转账', where: '工作台 → 出示礼簿码', mock: grid('出示礼簿码'), url: '/pages/qrcode/qrcode', go: '去出示' },
        { title: '确认收到', desc: '核对宾客转账到账后确认入簿；多笔可批量确认', where: '工作台 → 待确认礼金', mock: grid('待确认礼金'), url: '/pages/pending/pending', go: '去确认' },
        { title: '礼台记账', desc: '现金、微信、转账+现金，当场登记入簿。顶部打印机状态条没连上点「连接」；姓名、金额框自动聚焦；遇到同名会弹窗选择；上方显示「本次已登记」份数和合计', where: '工作台 → 礼台记账', mock: cashdesk('sum'), url: '/pages/cash/cash', go: '去记账' },
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
        { title: '填写姓名和礼金', desc: '可以替家人一起登记，多人合并转一笔；白事写「致奠人」「奠仪」。如果礼簿里已有同名的人，会请你填一个区分备注（村名、单位等）', where: '随礼页', mock: flow(GUEST_FLOW, '填写礼金') },
        { title: '扫收款码付款', desc: '用微信扫一扫扫主家的收款码转账；扫不到时，把收款码存到相册，再从相册识别', where: '随礼页 → 扫一扫付款', mock: flow(GUEST_FLOW, '扫一扫付款') },
        { title: '回来点「我已完成转账」', desc: '会弹出「入簿通知」授权，点「允许」后主家确认收到时你会收到微信通知。不用一直开着页面等，可以先离开，主家确认后礼金就入簿了', where: '随礼页', mock: flow(GUEST_FLOW, '我已完成转账') }
      ]
    },
    {
      sec: '之后',
      steps: [
        { title: '查看随礼记录与电子回执', desc: '还没确认的显示在「等待主家确认」一栏，确认后可查看、保存电子回执。礼台代你登记的，扫小票上的二维码后点「放入我的随礼记录」', where: '首页 → 我的随礼记录', mock: page('首页', ['我的随礼记录'], '我的随礼记录'), url: '/pages/myreceipts/myreceipts', go: '去查看' }
      ]
    }
  ]
};
/** 长答案分句显示：超过 90 字时每个句号后换行（句号后紧跟引号 / 括号的不拆）；搜索仍用原文，不受影响 */
const fmtAnswer = a => (a.length > 90 ? a.replace(/。(?=[^」）』\n])/g, '。\n') : a);
const SEARCH_OPEN = 5; // 搜索时默认展开的条数（宽词命中很多时不一次全部展开）
const TABS = ['host', 'clerk', 'guest', 'faq'];

/** 机构模式的称呼替换（与教程一致：礼簿管理→场次管理、记账人→礼台人员、当前礼簿→当前场次） */
const orgText = s => String(s).replace(/礼簿管理/g, '场次管理').replace(/记账人/g, '礼台人员').replace(/当前礼簿/g, '当前场次');
/** 教程步骤、示意图用：在 orgText 之外，「其他礼簿还有…待确认」提示条也换成「其他场次」 */
const orgStep = s => orgText(s).replace(/其他礼簿/g, '其他场次');

/** 示意图数据：按机构模式换称呼（宫格多「场次汇总」、菜单「记账人」换成「礼台人员」），菜单只展开高亮行所在的组 */
function buildMock(mock, org) {
  const t = x => (org ? orgStep(x) : x);
  if (mock.type === 'grid') return { ...mock, items: (org ? M.GRID_ORG : M.GRID).map(t), hl: t(mock.hl) };
  if (mock.type === 'menu') {
    const hl = t(mock.hl);
    return { ...mock, hl, groups: M.MENU.map(g => { const items = g.items.map(t); return { g: g.g, items, show: !!hl && items.includes(hl) }; }) };
  }
  if (mock.type === 'bars') return { ...mock, items: M.BARS.map(b => ({ ...b, t: t(b.t) })) };
  if (mock.type === 'printer3') return { ...mock, items: M.PRINTER_STATES };
  return mock;
}

Page({
  data: {
    tab: 'host',
    secs: [],
    // 常见问题：搜索词、展开状态；faqView 为过滤后的分类与问题
    kw: '',
    openCat: {},
    openQ: {},
    faqView: [],
    faqCount: 0,
    tabbar: M.TABBAR,   // 示意图底部菜单（宾客的第一个菜单为「首页」）
    themeStyle: ''
  },

  onLoad(options) {
    const tab = TABS.includes(options.tab) ? options.tab : 'host';
    this.setData({ tab, secs: this.secsOf(tab) });
    // 常见问题默认展开：链接带 cat=（分类 key，如 guest）展开该类，否则展开第一类；
    // 旧版随礼页链接用 who=guest，兼容映射为 cat=guest
    const key = options.cat || (options.who === 'guest' ? 'guest' : '');
    const hit = FAQ.findIndex(c => c.key === key);
    this._defCat = hit >= 0 ? hit : 0;
    this.setData({ openCat: { [this._defCat]: true } });
    this.buildFaq();
  },

  onShow() {
    theme.apply(this);
  },

  /** 分段与步骤：机构模式不显示「往来」，礼簿管理称「场次管理」、记账人称「礼台人员」、当前礼簿称「当前场次」；步骤编号跨段连续 */
  secsOf(tab) {
    if (tab === 'faq') return [];
    const a = getApp().globalData.account;
    const org = !!(a && a.orgMode);
    this.setData({ tabbar: tab === 'guest' ? ['首页'].concat(M.TABBAR.slice(1)) : M.TABBAR });
    let n = 0;
    const t = x => (org ? orgStep(x) : x);
    return GUIDES[tab].filter(s => !(s.hideOrg && org)).map(s => ({
      sec: s.sec,
      steps: s.steps.map(st => ({
        ...st,
        title: t(st.title),
        desc: org && st.orgDesc ? st.orgDesc : t(st.desc),
        where: t(st.where),
        mock: buildMock(st.mock, org),
        no: ++n
      }))
    }));
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.t;
    if (tab !== this.data.tab) {
      this.setData({ tab, secs: this.secsOf(tab) });
      if (tab === 'faq') this.buildFaq();
    }
  },

  /** 常见问题：按身份、搜索词过滤并套用机构称呼；有搜索词时命中的分类和问题自动展开 */
  buildFaq() {
    const a = getApp().globalData.account;
    const org = !!(a && a.orgMode);
    const { openCat, openQ } = this.data;
    const sCat = this._sCat || {}, sQ = this._sQ || {}; // 搜索态下用户手动展开/收起的记录
    const kw = this.data.kw.trim().toLowerCase();
    let hit = 0; // 搜索命中序号：只默认展开前 SEARCH_OPEN 条，其余收起，可手动展开
    const txt = s => (org ? orgText(s) : s);
    let count = 0;
    const faqView = [];
    FAQ.forEach((c, ci) => {
      const items = [];
      c.items.forEach((it, ii) => {
        if (org && it.hideOrg) return;
        const q = org && it.qOrg ? it.qOrg : txt(it.q);
        const ans = org && it.aOrg ? it.aOrg : txt(it.a);
        if (kw && (q + ans).toLowerCase().indexOf(kw) < 0) return;
        const k = ci + '-' + ii;
        const open = kw ? (sQ[k] !== undefined ? sQ[k] : hit < SEARCH_OPEN) : !!openQ[k];
        hit++;
        items.push({ k, q, a: fmtAnswer(ans), url: it.url || '', tab: !!it.tab, go: it.go || '去看看', open });
      });
      if (!items.length) return;
      count += items.length;
      faqView.push({ ci, cat: c.cat, n: items.length, open: kw ? sCat[ci] !== false : !!openCat[ci], items });
    });
    this.setData({ faqView, faqCount: count });
  },

  onKw(e) {
    const kw = e.detail.value || '';
    this.setData({ kw });
    this._sCat = {}; this._sQ = {}; // 换了搜索词：手动展开/收起记录作废
    clearTimeout(this._kwTimer);
    // 搜索词清空时恢复默认展开；否则按关键词过滤（命中自动展开）
    this._kwTimer = setTimeout(() => (kw.trim() ? this.buildFaq() : this.resetFaqOpen()), 150);
  },

  /** 清空搜索：恢复成默认展开状态 */
  onKwClear() {
    this.setData({ kw: '' });
    this.resetFaqOpen();
  },

  resetFaqOpen() {
    this._sCat = {}; this._sQ = {};
    this.setData({ openCat: { [this._defCat || 0]: true }, openQ: {} });
    this.buildFaq();
  },

  onToggleCat(e) {
    const ci = e.currentTarget.dataset.ci;
    if (this.data.kw.trim()) { // 搜索态：按当前显示状态取反，单独记录
      const c = this.data.faqView.find(x => x.ci === ci);
      this._sCat = { ...(this._sCat || {}), [ci]: !(c && c.open) };
      return this.buildFaq();
    }
    this.setData({ openCat: { ...this.data.openCat, [ci]: !this.data.openCat[ci] } });
    this.buildFaq();
  },

  onToggleQ(e) {
    const k = e.currentTarget.dataset.k;
    if (this.data.kw.trim()) {
      let cur = false;
      this.data.faqView.forEach(c => c.items.forEach(it => { if (it.k === k) cur = it.open; }));
      this._sQ = { ...(this._sQ || {}), [k]: !cur };
      return this.buildFaq();
    }
    this.setData({ openQ: { ...this.data.openQ, [k]: !this.data.openQ[k] } });
    this.buildFaq();
  },

  /** 常见问题里的「去看看」 */
  onFaqGo(e) {
    const { url, tab } = e.currentTarget.dataset;
    if (!url) return;
    if (tab) wx.switchTab({ url });
    else wx.navigateTo({ url });
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
