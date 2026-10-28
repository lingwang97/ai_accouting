// guestnotify.js — 宾客入簿通知（v3.66.1 起；v3.68.1 移到共享模块，payment 发送、warmer 补发）。
// 源文件在 tools/cloud-shared/guestnotify.js，由 tools/sync_shared.py 复制到 payment、warmer，勿在云函数目录里直接修改。
//
// 流程：主家确认入簿后（payment.afterPaid）给订阅过的宾客发一条服务通知，批次合成一条。
// 不重复发：先原子占位（guestNotifiedAt + guestNotifyTry），发成功记 guestNotifyDone。
// 发送失败可重试（网络、限流等）：撤销占位（删 guestNotifiedAt），warmer 每 5 分钟补发；
// 确定性失败（43101 宾客没订阅 / 次数已用、47003 参数不符、40003 openid 无效）或已试 MAX_TRIES 次：记 done，不再发。
// 占位后实例被冻结（afterPaid 只等 1.5 秒）：占位超过 STALE_MS 仍没 done，warmer 视为中断，重新占位再发。
// 一次性订阅消息每次同意只能发一条，万一前一次其实已送达，补发会得到 43101 并记 done，宾客不会收到两条。
// 旧记录（v3.68.1 前已占位、没有 guestNotifyTry）不参与补发。

const { REC } = require('./status.js');
const { bjTime } = require('./common.js');

const GUEST_TMPL_ID = 'eC0vKfrKjT6oBR187PU8HSkiLNORwnaKRxf6JT7Vcl0'; // 需与 miniprogram/config.js 的 GUEST_NOTIFY_TMPL_ID 一致
const MAX_TRIES = 3;
const STALE_MS = 10 * 60 * 1000;
const RETRY_WINDOW_MS = 24 * 3600 * 1000; // 只补发 24 小时内入簿的
const FINAL_CODES = [43101, 47003, 40003];
const BATCH_PEOPLE = 10;

/** thing 字段：20 个字以内；去掉表情、控制字符等模板不接受的字符，只留汉字、字母、数字与常用标点 */
function thingValue(s, fallback) {
  const v = String(s || '')
    .replace(/[^一-龥A-Za-z0-9 ·、，,。.（）()\-—：:！!？?+]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (v || fallback || '').slice(0, 20);
}

/**
 * 宾客入簿通知内容
 * g：{ hostName 主家称呼, themeName 礼簿名, amount 金额（批次为合计）, count 人数, funeral 是否白事, method 'wechat'|'cash'|'mixed' }
 */
function buildGuest(g, timeStr) {
  const n = Number(g.count) || 1;
  const note = g.funeral
    ? (n > 1 ? `${n}人奠仪已收到` : '奠仪已收到，点此查看回执')
    : (n > 1 ? `${n}人一起随礼，已入簿` : '已入簿，点此查看电子回执');
  return {
    thing6: { value: thingValue([g.hostName, g.themeName].filter(Boolean).join(' '), '慧礼记') },
    amount3: { value: `${(Math.round(Number(g.amount || 0) * 100) / 100).toFixed(2)}元` },
    time1: { value: timeStr },
    thing8: { value: { cash: '现金', mixed: '微信转账+现金' }[g.method] || '微信转账' },
    thing5: { value: thingValue(note, '已入簿') }
  };
}

/** 是否需要发：订阅过、宾客本人扫码登记（有 payerOpenid，不是礼台代记 / 经办人自己） */
const eligible = r => r.guestNotify === true && !!r.payerOpenid && !r.deskEntry && r.payerOpenid !== r.handlerOpenid;

function create(db, cloud) {
  const _ = db.command;
  const records = db.collection('records');

  const batchOf = async rec => (await records.where({ batchId: rec.batchId, ownerOpenid: rec.ownerOpenid }).limit(BATCH_PEOPLE * 2).get())
    .data.sort((a, b) => (a.batchIdx || 0) - (b.batchIdx || 0));

  /**
   * 发一条（批次一条）。prevStamp：补发时上一次中断的占位时间（按它条件重占），首次为 undefined（要求没有占位）
   * 返回 'sent' | 'final'（不再发）| 'retry'（已撤销占位，等补发）| 'skip'
   */
  async function sendGuest(rec, prevStamp) {
    let all = [rec];
    if (rec.batchId) {
      all = await batchOf(rec);
      if (all.some(r => r.status === REC.TRANSFERRED || r.status === REC.PENDING)) return 'skip'; // 批次还有没处理的：等最后一次确认再发
    }
    const paid = all.filter(r => r.status === REC.PAID);
    if (!paid.length) return 'skip';
    const key = rec.batchId ? { batchId: rec.batchId, ownerOpenid: rec.ownerOpenid } : { _id: rec._id };
    const tries = (Number(rec.guestNotifyTry) || 0) + 1;
    const stamp = new Date();
    // 先原子占位，保证同一笔（批）同一时间只有一处在发
    const mark = await records.where({ ...key, guestNotifiedAt: prevStamp ? prevStamp : _.exists(false) })
      .update({ data: { guestNotifiedAt: stamp, guestNotifyTry: tries } });
    if (!mark.stats || !mark.stats.updated) return 'skip';
    let hostName = rec.hostName || '';
    if (!hostName && rec.aid) {
      try { hostName = ((await db.collection('accounts').doc(rec.aid).get()).data || {}).accountName || ''; } catch (e) { /* 只写礼簿名 */ }
    }
    const method = rec.batchPay === 'mixed' ? 'mixed' : (rec.payMethod === 'cash' ? 'cash' : 'wechat');
    const data = buildGuest({
      hostName, themeName: rec.themeName || '', funeral: rec.bookType === 'funeral', method,
      count: paid.length, amount: paid.reduce((t, r) => t + Math.round(r.amount * 100), 0) / 100
    }, bjTime(rec.paidAt || new Date()));
    let code = 0;
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: rec.payerOpenid,
        templateId: GUEST_TMPL_ID,
        page: `pages/receipt/receipt?rid=${rec._id}`, // 回执页参数 rid；批次为宾客自己那条
        miniprogramState: { develop: 'developer', trial: 'trial' }[rec.guestEnv] || 'formal',
        data
      });
    } catch (e) {
      code = Number(e.errCode) || -1;
      console.warn('入簿通知发送失败', e.errCode, e.errMsg || e.message);
    }
    const mine = { ...key, guestNotifiedAt: stamp }; // 只改自己这次的占位
    if (!code || FINAL_CODES.includes(code) || tries >= MAX_TRIES) {
      try { await records.where(mine).update({ data: { guestNotifyDone: true, ...(code ? { guestNotifyErr: code } : {}) } }); } catch (e) { /* 留给补发判断：已试满 / 确定失败的会再记一次 done */ }
      return code ? 'final' : 'sent';
    }
    try { await records.where(mine).update({ data: { guestNotifiedAt: _.remove() } }); } catch (e) { /* 撤销失败：超过 STALE_MS 后按中断补发 */ }
    return 'retry';
  }

  /** 刚入簿的记录：挑出要发的（批次取宾客自己那条，即 batchIdx 最小的），逐批发送；返回发出的条数 */
  async function notifyGuests(ids) {
    if (!GUEST_TMPL_ID || !ids.length) return 0;
    const res = await records.where({ _id: _.in(ids.slice(0, 100)), status: REC.PAID, guestNotify: true }).get();
    const pick = new Map();
    res.data.forEach(r => {
      if (r.guestNotifiedAt || r.guestNotifyDone || !eligible(r)) return;
      const k = r.batchId || r._id;
      const cur = pick.get(k);
      if (!cur || (r.batchIdx || 0) < (cur.batchIdx || 0)) pick.set(k, r);
    });
    let sent = 0;
    await Promise.all([...pick.values()].map(async r => { if ((await sendGuest(r)) === 'sent') sent++; }));
    return sent;
  }

  /**
   * warmer 补发：24 小时内入簿、发过（有 guestNotifyTry）但没 done 的——占位已撤销（可重试的失败），或占位超过 STALE_MS（中断）
   * 每次最多 limit 批；deadline 前没发完的下一轮继续
   */
  async function retryPending(limit, deadline) {
    if (!GUEST_TMPL_ID) return 0;
    const now = Date.now();
    const res = await records.where(_.and([
      { guestNotify: true, status: REC.PAID, guestNotifyDone: _.neq(true), guestNotifyTry: _.gt(0), paidAt: _.gt(new Date(now - RETRY_WINDOW_MS)) },
      _.or([{ guestNotifiedAt: _.exists(false) }, { guestNotifiedAt: _.lt(new Date(now - STALE_MS)) }])
    ])).limit(50).get();
    const pick = new Map();
    res.data.forEach(r => {
      if (!eligible(r)) return;
      const k = r.batchId || r._id;
      const cur = pick.get(k);
      if (!cur || (r.batchIdx || 0) < (cur.batchIdx || 0)) pick.set(k, r);
    });
    let n = 0;
    for (const r of [...pick.values()].slice(0, limit || 10)) {
      if (deadline && deadline - Date.now() < 5000) break;
      const key = r.batchId ? { batchId: r.batchId, ownerOpenid: r.ownerOpenid } : { _id: r._id };
      if ((Number(r.guestNotifyTry) || 0) >= MAX_TRIES) { // 已试满（最后一次中断）：不再发
        try { await records.where({ ...key, guestNotifyDone: _.neq(true) }).update({ data: { guestNotifyDone: true, guestNotifyErr: -2 } }); } catch (e) { /* 下一轮再记 */ }
        continue;
      }
      try { if ((await sendGuest(r, r.guestNotifiedAt || undefined)) === 'sent') n++; } catch (e) { console.warn('入簿通知补发失败', e.message); }
    }
    return n;
  }

  return { sendGuest, notifyGuests, retryPending };
}

module.exports = { GUEST_TMPL_ID, MAX_TRIES, STALE_MS, buildGuest, thingValue, create };
