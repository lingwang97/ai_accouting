// utils/bordertiles.js — 小票「花边」（v3.60.0）
// 上下：24 点高的花纹带（GS v 0 光栅，由 24x24 点阵块平铺）；左右：每行首尾各一个全角装饰字符（GB2312 第一区，不用制表符）。
// 点阵块数据见 bordertiles-data.js（tools/gen_border_tiles.py 生成）。花纹带宽度与纸宽一致：58mm = 384 点，80mm = 576 点。
const CELLS = require('./bordertiles-data.js');

const CELL = 24;          // 点阵块边长（点）
const BAND_H = 24;        // 花纹带高度（点）
const GAP_DOTS = 6;       // 花纹带与正文之间的空隙（点）

/**
 * 款式：seq = 平铺用的两种块（A B A B … A，首尾对称）；side = 左右字符（逐行交替）；preview = 预览用的示意字符
 * funeralOk：白事可用（白事只能用素雅）
 */
const STYLES = {
  hui:  { name: '回纹', seq: ['hui', 'dia'], side: ['※', '◇'], preview: ['回', '◇'] },
  yun:  { name: '云纹', seq: ['yun', 'dia'], side: ['◇', '◆'], preview: ['☁', '◇'] },
  xi:   { name: '囍字纹', seq: ['xi', 'hui'], side: ['◆', '◇'], preview: ['囍', '回'] },
  shou: { name: '寿字纹', seq: ['shou', 'dia'], side: ['◇', '◆'], preview: ['寿', '◇'] },
  fu:   { name: '福字纹', seq: ['fu', 'yun'], side: ['◆', '◇'], preview: ['福', '☁'] },
  su:   { name: '素雅线', seq: ['su', 'su'], side: ['·', '·'], preview: ['═', '═'], funeralOk: true }
};
const STYLE_KEYS = Object.keys(STYLES);
const BORDER_VALUES = ['off', 'auto', ...STYLE_KEYS];

/** 跟随礼簿类型时的默认款式（与 PDF 主题的类型默认一致：喜 / 寿 / 福 / 福 / 素灰） */
const TYPE_DEFAULT = { wedding: 'xi', birthday: 'shou', baby: 'fu', house: 'hui', funeral: 'su', other: 'hui' };

const normBorder = v => (BORDER_VALUES.includes(v) ? v : 'off');

/**
 * 解析实际款式：border = 'off' | 'auto' | 款式键；白事一律素雅
 * 返回 null（不打花边）或 { key, side: [字符, 字符] | null }
 */
function resolve(border, borderSide, bookType) {
  const b = normBorder(border);
  if (b === 'off') return null;
  let key = b === 'auto' ? (TYPE_DEFAULT[bookType] || 'hui') : b;
  if (bookType === 'funeral') key = 'su';
  const st = STYLES[key];
  return { key, side: borderSide === false ? null : st.side };
}

const _cache = {};
function _cellPixels(name) {
  const hex = CELLS[name];
  const rows = [];
  for (let y = 0; y < CELL; y++) {
    const r = [];
    for (let b = 0; b < 3; b++) {
      const v = parseInt(hex.substr((y * 3 + b) * 2, 2), 16);
      for (let i = 7; i >= 0; i--) r.push((v >> i) & 1);
    }
    rows.push(r);
  }
  return rows;
}

/**
 * 某款式的花纹带光栅字节（GS v 0，m=0）；widthDots 为 384 或 576（纸宽 32 / 48 列 × 12）
 * 块数取奇数（384 → 15 块，576 → 23 块）并居中，首尾同一种块，左右各留约 12 点空白
 */
function bandBytes(key, widthDots) {
  const st = STYLES[key];
  if (!st) return [];
  const ck = key + ':' + widthDots;
  if (_cache[ck]) return _cache[ck];
  const wBytes = widthDots >> 3;
  let n = Math.floor(widthDots / CELL);
  if (n % 2 === 0) n--;
  const x0 = (widthDots - n * CELL) >> 1;
  const px = {};
  st.seq.forEach(c => { px[c] = px[c] || _cellPixels(c); });
  const out = new Array(wBytes * BAND_H).fill(0);
  for (let i = 0; i < n; i++) {
    const cell = px[st.seq[i % 2]];
    for (let y = 0; y < BAND_H; y++) {
      for (let x = 0; x < CELL; x++) {
        if (!cell[y][x]) continue;
        const dx = x0 + i * CELL + x;
        out[y * wBytes + (dx >> 3)] |= 0x80 >> (dx & 7);
      }
    }
  }
  const head = [0x1d, 0x76, 0x30, 0x00, wBytes & 0xff, wBytes >> 8, BAND_H & 0xff, BAND_H >> 8];
  return (_cache[ck] = head.concat(out));
}

/** 预览用：一行示意字符（宽度按列数，用 n 个块） */
function previewBand(key, cols) {
  const st = STYLES[key];
  if (!st) return '';
  let n = Math.floor(cols / 2);
  if (n % 2 === 0) n--;
  let s = '';
  for (let i = 0; i < n; i++) s += st.preview[i % 2];
  return s;
}

/** 手动选择的款式清单（打印设置里用）：[{ key, name }] */
const styleList = () => STYLE_KEYS.map(k => ({ key: k, name: STYLES[k].name }));

module.exports = {
  STYLES, STYLE_KEYS, BORDER_VALUES, TYPE_DEFAULT, GAP_DOTS, BAND_H,
  normBorder, resolve, bandBytes, previewBand, styleList
};
