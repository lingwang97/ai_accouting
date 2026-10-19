// utils/receipt.js — 宾客留存的电子回执：模板默认值、展示模型、保存为图片
// 样式按礼簿设置（「我的 → 电子回执模板」，与蓝牙打印格式独立），存于 books.receiptTpl；未设置时按事由类型套用场景默认
const fmt = require('./format.js');
const scenes = require('./scenes.js');
const req = require('./request.js');

const APP_CODE_TIP = '扫码使用慧礼记 · 记礼金、查往来';

const FIELD_LABELS = {
  receiptNo: '回执编号',
  payee: '主家',
  payerName: '随礼人',
  relation: '关系',
  proxyFor: '代随礼',
  amountUpper: '礼金大写',
  theme: '事由',
  remark: '礼品/备注',
  paidAt: '登记时间'
};

const STYLES = [
  { v: 'card', label: '卡片' },
  { v: 'ticket', label: '票据' },
  { v: 'simple', label: '简约' }
];

const DEFAULT_TPL = {
  ...scenes.byType('other').receipt,
  fields: ['receiptNo', 'theme', 'payee', 'payerName', 'proxyFor', 'amountUpper', 'remark', 'paidAt']
};

/** 编辑页预览用示例数据 */
const SAMPLE = {
  record: {
    _id: 'sample0000000000000000000a1b2c3', payerName: '张三', amount: 888, remark: '另送花篮一对',
    relation: '同学', proxyFor: '李四、王五', themeName: '张三&李四 新婚之喜', bookType: 'wedding',
    createdAt: new Date(), paidAt: new Date()
  },
  accountName: '张府'
};

/** 礼簿未自定义样式时，按事由类型套用场景默认（白事自动素色无红章） */
function normalizeTpl(tpl, bookType) {
  if (tpl) return { ...DEFAULT_TPL, ...tpl };
  return { ...DEFAULT_TPL, ...scenes.byType(bookType || 'other').receipt };
}

/** 收据编号：到账日期 + 记录 ID 末 6 位 */
function receiptNo(r) {
  const d = fmt.day(r.paidAt || r.createdAt).replace(/-/g, '');
  return `R${d}${String(r._id || '').slice(-6).toUpperCase()}`;
}

/** 金额转人民币大写 */
function amountUpper(n) {
  const fen = Math.round(Number(n || 0) * 100);
  if (fen === 0) return '零元整';
  const digit = '零壹贰叁肆伍陆柒捌玖';
  const unit = ['', '拾', '佰', '仟'];
  const big = ['', '万', '亿'];
  const yuan = Math.floor(fen / 100);
  const jiao = Math.floor(fen / 10) % 10;
  const f = fen % 10;

  let s = '';
  if (yuan > 0) {
    const str = String(yuan);
    let zero = false;
    for (let i = 0; i < str.length; i++) {
      const pos = str.length - 1 - i;
      const d = Number(str[i]);
      if (d === 0) {
        zero = true;
      } else {
        if (zero) s += '零';
        zero = false;
        s += digit[d] + unit[pos % 4];
      }
      if (pos % 4 === 0 && pos > 0) {
        // 万/亿 节：本节有非零数字才加单位
        const sec = str.slice(Math.max(0, i - 3), i + 1);
        if (Number(sec) > 0) s += big[pos / 4];
      }
    }
    s += '元';
  }
  if (jiao === 0 && f === 0) return s + '整';
  if (jiao > 0) s += digit[jiao] + '角';
  else if (yuan > 0) s += '零';
  if (f > 0) s += digit[f] + '分';
  else s += '整'; // 到角为止，后写"整"
  return s;
}

/** 代随礼名单，填了金额的带上金额：王五 ￥300、赵六 */
function proxyText(r) {
  if (r.proxyItems && r.proxyItems.length) {
    return r.proxyItems.map(p => (p.amount > 0 ? `${p.name} ￥${fmt.money(p.amount)}` : p.name)).join('、');
  }
  return r.proxyFor || '';
}

/** 生成展示模型（组件渲染与画图共用） */
function buildModel(record, tpl, accountName) {
  const t = normalizeTpl(tpl, record.bookType);
  const values = {
    receiptNo: receiptNo(record),
    payee: accountName || '',
    payerName: record.payerName,
    relation: record.relation || '',
    proxyFor: proxyText(record),
    amountUpper: amountUpper(record.amount),
    theme: record.themeName || '',
    remark: record.remark || '',
    paidAt: fmt.dateTime(record.paidAt || record.createdAt)
  };
  let rows = t.fields
    .filter(k => FIELD_LABELS[k] && values[k])
    .map(k => ({ k, label: FIELD_LABELS[k], value: values[k] }));
  // 批次录入的合并回执：随礼人一行一位，带各自金额
  if (record.batchItems && record.batchItems.length > 1) {
    const at = rows.findIndex(x => x.k === 'payerName');
    const people = record.batchItems.map((p, i) => ({
      k: 'payer' + i, label: i === 0 ? '随礼人' : '', value: `${p.name}  ￥${fmt.money(p.amount)}`
    }));
    rows = at >= 0 ? rows.slice(0, at).concat(people, rows.slice(at + 1)) : rows.concat(people);
  }
  // 记账人：实际确认 / 登记这笔礼金的人，紧跟在「主家」之后显示（没有主家行时放在最前）
  if (record.handlerName) {
    const at = rows.findIndex(x => x.k === 'payee');
    rows.splice(at >= 0 ? at + 1 : 0, 0, { k: 'handler', label: '记账人', value: record.handlerName });
  }
  return {
    title: t.title || DEFAULT_TPL.title,
    color: t.color,
    style: t.style,
    amount: fmt.money(record.amount),
    amountLabel: (record.bookType === 'funeral' ? '奠仪' : '礼金') + (record.payMethod === 'cash' ? '（现金）' : ''),
    rows,
    showStamp: t.showStamp,
    stampMain: t.stamp || '谨收',
    stampText: accountName || '主家',
    footer: t.footer
  };
}

/** 给回执附上小程序码（链接当天有效，缓存在内存）；失败返回原模型 */
let appCodeCache = null;
async function withAppCode(model) {
  if (!model) return model;
  try {
    if (!appCodeCache || appCodeCache.expires < Date.now()) {
      const { url } = await req.appCode();
      appCodeCache = { url, expires: Date.now() + 12 * 3600 * 1000 };
    }
    return { ...model, appCode: appCodeCache.url, appCodeTip: APP_CODE_TIP };
  } catch (e) {
    return model;
  }
}

// —— 保存为图片（canvas 2D 按模型重绘，样式与组件保持一致） ——
const W = 750;
const PAD = 48;
const ROW_H = 72;

/**
 * 把收据画到页面中的 <canvas type="2d" id="{{canvasId}}"> 并导出临时图片
 * @param {string} selector 如 '#receiptCanvas'
 */
function toImage(selector, model) {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery().select(selector).fields({ node: true }).exec(res => {
      try {
        const canvas = res && res[0] && res[0].node;
        if (!canvas) return reject(new Error('画布未就绪'));
        loadImage(canvas, model.appCode).then(code => {
          const H = 420 + model.rows.length * ROW_H + (model.footer ? 110 : 40) + (code ? CODE_H : 0);
          canvas.width = W;
          canvas.height = H;
          const ctx = canvas.getContext('2d');
          draw(ctx, model, H);
          if (code) drawAppCode(ctx, code, model.appCodeTip, H);
          wx.canvasToTempFilePath({ canvas, fileType: 'png', success: r => resolve(r.tempFilePath), fail: reject });
        }).catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  });
}

const CODE_H = 260; // 底部小程序码区域高度
const CODE_SIZE = 170;

/** 下载并加载小程序码图片；没有或失败时返回 null（回执照常生成） */
function loadImage(canvas, url) {
  if (!url) return Promise.resolve(null);
  return new Promise(resolve => {
    wx.downloadFile({
      url,
      success: r => {
        if (r.statusCode !== 200) return resolve(null);
        const img = canvas.createImage();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = r.tempFilePath;
      },
      fail: () => resolve(null)
    });
  });
}

function drawAppCode(ctx, img, tip, H) {
  const bottom = H - 40;
  const y = bottom - CODE_H + 20;
  ctx.drawImage(img, (W - CODE_SIZE) / 2, y, CODE_SIZE, CODE_SIZE);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#999999';
  ctx.font = '22px sans-serif';
  ctx.fillText(tip || '', W / 2, y + CODE_SIZE + 30);
}

function draw(ctx, m, H) {
  const color = m.color;
  const simple = m.style === 'simple';

  // 背景
  ctx.fillStyle = m.style === 'card' ? color : '#FFFFFF';
  ctx.fillRect(0, 0, W, H);
  if (m.style === 'card') {
    ctx.fillStyle = '#FFFFFF';
    roundRect(ctx, 24, 24, W - 48, H - 48, 24);
    ctx.fill();
  }
  if (m.style === 'ticket') {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, W, 16);
    ctx.fillRect(0, H - 16, W, 16);
    // 票据锯齿边
    ctx.fillStyle = '#FFFFFF';
    for (let x = 0; x < W; x += 30) {
      ctx.beginPath(); ctx.arc(x + 15, 16, 10, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 15, H - 16, 10, 0, Math.PI * 2); ctx.fill();
    }
  }

  // 标题
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = simple ? '#333333' : color;
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText(m.title, W / 2, 110);
  if (simple) {
    ctx.fillStyle = color;
    ctx.fillRect(W / 2 - 40, 150, 80, 6);
  }

  // 金额
  ctx.fillStyle = '#333333';
  ctx.font = 'bold 72px sans-serif';
  ctx.fillText(`￥${m.amount}`, W / 2, 230);
  ctx.fillStyle = '#999999';
  ctx.font = '26px sans-serif';
  ctx.fillText(m.amountLabel, W / 2, 290);

  // 明细行
  let y = 340;
  dashed(ctx, PAD, y, W - PAD, '#DDDDDD');
  ctx.font = '28px sans-serif';
  for (const r of m.rows) {
    y += ROW_H;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#999999';
    ctx.fillText(r.label, PAD + 8, y - ROW_H / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#333333';
    ctx.fillText(fit(ctx, r.value, W - PAD * 2 - 180), W - PAD - 8, y - ROW_H / 2);
  }
  dashed(ctx, PAD, y + 10, W - PAD, '#DDDDDD');

  // 页脚
  if (m.footer) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#AAAAAA';
    ctx.font = '24px sans-serif';
    ctx.fillText(fit(ctx, m.footer, W - PAD * 2), W / 2, y + 70);
  }

  // 印章
  if (m.showStamp) stamp(ctx, m.stampText, m.stampMain, W - PAD - 110, 250);
}

function stamp(ctx, text, main, cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 12);
  ctx.globalAlpha = 0.75;
  ctx.strokeStyle = '#E64340';
  ctx.fillStyle = '#E64340';
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(0, 0, 90, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, 80, 0, Math.PI * 2); ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(fit(ctx, text, 140), 0, -30);
  ctx.font = `bold ${main.length <= 1 ? 64 : main.length === 2 ? 44 : 34}px sans-serif`;
  ctx.fillText(main, 0, 18);
  ctx.restore();
}

function dashed(ctx, x1, y, x2, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 超宽文字截断加省略号 */
function fit(ctx, text, maxW) {
  let s = String(text);
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

/** 保存到相册（含权限引导） */
function saveImage(filePath) {
  return new Promise(resolve => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: '回执已存相册', icon: 'success' });
        resolve(true);
      },
      fail: e => {
        if (/auth|deny/i.test((e && e.errMsg) || '')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请允许保存到相册',
            confirmText: '去设置',
            success: res => res.confirm && wx.openSetting()
          });
        } else if (!/cancel/i.test((e && e.errMsg) || '')) {
          wx.showToast({ title: '保存失败，可截屏留存', icon: 'none' });
        }
        resolve(false);
      }
    });
  });
}

module.exports = {
  FIELD_LABELS, STYLES, DEFAULT_TPL, SAMPLE,
  normalizeTpl, amountUpper, receiptNo, proxyText, buildModel, toImage, saveImage, withAppCode
};
