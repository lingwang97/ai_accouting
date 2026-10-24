// pages/booktheme/pdftheme.js — 传统礼簿 PDF 主题清单（与云函数 export/themes.js 保持一致）
// 喜事：9 种预设 + 自定义（可基于预设修改）；白事：颜色固定素灰，只能改字体 / 角饰 / 水印 / 标题 / 落款
const LIST = [
  { key: 'red_gold', name: '中国红金', scene: '婚礼·通用', main: '#B71C1C', accent: '#D4AF37', cover: '#F8E7B0', pattern: 'double', mark: '', font: 'sans', footer: '' },
  { key: 'wine_gold', name: '酒红鎏金', scene: '婚礼·庄重', main: '#7B1E2B', accent: '#C9A24B', cover: '#F3E2B3', pattern: 'huiwen', mark: '喜', font: 'serif', footer: '百年好合' },
  { key: 'peach', name: '桃粉', scene: '婚礼·浪漫', main: '#D8577A', accent: '#FDE8EE', cover: '#FFFFFF', pattern: 'flower', mark: '', font: 'sans', footer: '琴瑟和鸣' },
  { key: 'shou_gold', name: '福寿金', scene: '寿宴', main: '#B8860B', accent: '#FFF1C9', cover: '#FFF8E1', pattern: 'diamond', mark: '寿', font: 'serif', footer: '福寿安康' },
  { key: 'pine', name: '松青', scene: '寿宴·长寿', main: '#2E6B4F', accent: '#C9A24B', cover: '#E8F0D8', pattern: 'diamond', mark: '寿', font: 'serif', footer: '松鹤延年' },
  { key: 'orange', name: '暖橙', scene: '满月·周岁', main: '#E8833A', accent: '#FFF3E0', cover: '#FFFFFF', pattern: 'cloud', mark: '', font: 'sans', footer: '福泽绵长' },
  { key: 'sky', name: '天蓝', scene: '满月·乔迁', main: '#2B7FFF', accent: '#E8F1FF', cover: '#FFFFFF', pattern: 'line', mark: '', font: 'sans', footer: '' },
  { key: 'purple_gold', name: '紫金', scene: '乔迁·开业', main: '#5B3A8C', accent: '#D4AF37', cover: '#F3E6B8', pattern: 'huiwen', mark: '', font: 'sans', footer: '' },
  { key: 'ink_gold', name: '墨黑金', scene: '商务·开业', main: '#222222', accent: '#D4AF37', cover: '#F0DFA0', pattern: 'line', mark: '', font: 'sans', footer: '' }
];
const DEFAULT_KEY = 'red_gold';

const FONTS = [{ k: 'sans', n: '黑体' }, { k: 'serif', n: '宋体' }, { k: 'brush', n: '毛笔' }];
const PATTERNS = [{ k: 'none', n: '无' }, { k: 'double', n: '双线' }, { k: 'huiwen', n: '回纹' }, { k: 'flower', n: '花朵' }, { k: 'cloud', n: '云纹' }, { k: 'diamond', n: '菱形' }, { k: 'line', n: '直角' }];
const MARKS = [{ k: '', n: '无' }, { k: '喜', n: '喜' }, { k: '囍', n: '囍' }, { k: '寿', n: '寿' }, { k: '福', n: '福' }];
const MAIN_COLORS = ['#B71C1C', '#7B1E2B', '#B8860B', '#2E6B4F', '#0B3D6B', '#2B7FFF', '#5B3A8C', '#222222', '#6B3E1F', '#1F1F7A', '#006D77', '#8A2D5B'];
const ACCENT_COLORS = ['#D4AF37', '#F5D76E', '#FFFFFF', '#FDE8EE', '#FFF1C9', '#E8F1FF', '#C0C0C0', '#222222'];
const DEFAULT_CUSTOM = { main: '#0B3D6B', accent: '#F5D76E', font: 'serif', pattern: 'double', mark: '', footer: '', title: '', cover: '' };

// 白事：颜色固定素灰（不可改）；角饰只有 无 / 双线 / 直角，水印只有 无 / 奠；落款有预设，也可自己写
const FUNERAL_PATTERNS = [{ k: 'none', n: '无' }, { k: 'double', n: '双线' }, { k: 'line', n: '直角' }];
const FUNERAL_MARKS = [{ k: '', n: '无' }, { k: '奠', n: '奠' }];
const FUNERAL_FOOTERS = ['沉痛哀悼', '深切缅怀', '音容宛在', '永远怀念', '千古'];
const DEFAULT_FUNERAL = { font: 'sans', pattern: 'none', mark: '', footer: '', title: '' };
const GREY = { main: '#555555', accent: '#333333' };

// 尾页（封底）与装订（与云函数 export/themes.js 一致）：默认有封底、不留装订边
const DEFAULT_BACK = { on: true, footer: '', sign: true, brand: true };
const BINDS = [
  { k: 'none', n: '不留边' },
  { k: 'single', n: '单面装订' },
  { k: 'double', n: '双面装订' }
];
const BIND_TIPS = {
  none: '不加宽装订边，页面与以前一致',
  single: '右侧加宽 20pt 作装订边（传统线装在右侧）',
  double: '奇偶页装订边左右镜像；封面背面、封底背面留空白，总页数自动补成偶数'
};

const HEX = /^#[0-9a-fA-F]{6}$/;

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/** 校验：返回错误提示，合法返回空串 */
function checkCustom(c) {
  if (!HEX.test(c.main || '') || !HEX.test(c.accent || '')) return '颜色请填 # 加 6 位，如 #B71C1C';
  if (lum(c.main) > 0.4) return '主色太浅，打印后看不清，请换深一点的颜色';
  return '';
}

/** 封面预览色（辅色、封面文字色与主色对比不足时自动换黑 / 白，与云函数一致） */
function previewOf(c) {
  if (checkCustom(c)) return null;
  const dark = lum(c.main) < 0.18;
  const accent = contrast(c.main, c.accent) >= 3 ? c.accent : (dark ? '#FFFFFF' : '#222222');
  const text = c.cover && HEX.test(c.cover) && contrast(c.main, c.cover) >= 3 ? c.cover : (dark ? '#FFFFFF' : '#222222');
  return { bg: c.main, border: accent, text };
}

/** 预设展开成可编辑的自定义项（快照：之后预设再调整也不影响已保存的礼簿） */
function expand(key) {
  const p = LIST.find(x => x.key === key) || LIST[0];
  return { main: p.main, accent: p.accent, font: p.font, pattern: p.pattern, mark: p.mark, footer: p.footer, title: '', cover: p.cover };
}

/** 白事预览色：素灰封面 */
function funeralPreview() {
  return { bg: '#F5F5F5', border: '#333333', text: '#333333' };
}

// 示意图用：没有真实宾客时的示例（云函数 bookPreviewData 也会返回示例）
const SAMPLE = [{ name: '张三', amount: 200 }, { name: '李四', amount: 600 }, { name: '王小明', amount: 1000 }, { name: '赵丽', amount: 500 }, { name: '欧阳明月', amount: 888 }];
const BACK_FOOTER = { wedding: '百年好合', birthday: '福寿安康', baby: '福泽绵长', house: '乔迁大吉' };
// 角饰示意字符（示意图用字符近似，实际角饰为矢量图形）
const CORNER_CHARS = { huiwen: '回', flower: '✿', cloud: '≋', diamond: '◆' };

/** 金额大写（与云函数 export/index.js 的 amountUpper 一致） */
function amountUpper(n) {
  const D = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  const U = ['', '拾', '佰', '仟'];
  const G = ['', '万', '亿', '万亿'];
  let fen = Math.round(Number(n) * 100);
  if (!isFinite(fen)) return '';
  const neg = fen < 0;
  if (neg) fen = -fen;
  if (fen === 0) return '零元整';
  const yuan = Math.floor(fen / 100);
  const jiao = Math.floor(fen / 10) % 10;
  const f = fen % 10;
  let s = '';
  let zero = false;
  const groups = [];
  for (let v = yuan; v > 0; v = Math.floor(v / 10000)) groups.push(v % 10000);
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (g === 0) { if (s) zero = true; continue; }
    if (s && g < 1000) zero = true;
    let started = false;
    for (let p = 3; p >= 0; p--) {
      const d = Math.floor(g / Math.pow(10, p)) % 10;
      if (d === 0) { if (started) zero = true; continue; }
      if (zero) { s += '零'; zero = false; }
      s += D[d] + U[p];
      started = true;
    }
    s += G[gi];
  }
  if (yuan > 0) s += '元';
  if (jiao === 0 && f === 0) s += '整';
  else {
    if (jiao > 0) s += D[jiao] + '角';
    else if (yuan > 0) s += '零';
    s += f > 0 ? D[f] + '分' : '整';
  }
  return (neg ? '负' : '') + s;
}

module.exports = {
  SAMPLE, BACK_FOOTER, CORNER_CHARS, amountUpper,
  LIST, DEFAULT_KEY, FONTS, PATTERNS, MARKS, MAIN_COLORS, ACCENT_COLORS, DEFAULT_CUSTOM,
  FUNERAL_PATTERNS, FUNERAL_MARKS, FUNERAL_FOOTERS, DEFAULT_FUNERAL, GREY, DEFAULT_BACK, BINDS, BIND_TIPS,
  checkCustom, previewOf, expand, funeralPreview
};
