// utils/trail.js — 礼金记录的处理日志（records.trail）转成文字，主家 / 记账人侧显示（含操作人）
const fmt = require('./format.js');

const REASON = { nofound: '未查到到账', amount: '金额不符', nomatch: '转账人对不上', other: '其他原因' };
const ACT = { reject: '标记未收到', unreject: '撤销未收到', appeal: '宾客申请再核对', accept: '核对后入簿', keep: '维持未收到' };
const WHO = { owner: '主家', clerk: '记账人', guest: '宾客' };

/** 一条日志：时间 + 谁 + 做了什么（+ 原因 / 说明 / 单号后几位） */
function lineOf(e) {
  const who = e.who === 'guest' ? '宾客' : (e.name || WHO[e.who] || '');
  const extra = [REASON[e.reason] || '', e.note || '', e.ref ? '单号后 ' + e.ref : ''].filter(Boolean).join('；');
  return `${fmt.dateTime(e.at)} ${who} ${ACT[e.act] || e.act}${extra ? `（${extra}）` : ''}`;
}

/** 日志列表（时间正序）→ 文字行 */
function lines(trail) {
  return (Array.isArray(trail) ? trail : []).map(lineOf);
}

/** 弹窗查看处理经过 */
function show(record) {
  wx.showModal({ title: '处理经过', content: lines(record && record.trail).join('\n') || '暂无', showCancel: false, confirmText: '知道了' });
}

module.exports = { REASON, lines, show };
