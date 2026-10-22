// utils/pdftheme.js — 传统礼簿 PDF 主题清单（与云函数 export/themes.js 保持一致）
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

module.exports = {
  LIST, DEFAULT_KEY, FONTS, PATTERNS, MARKS, MAIN_COLORS, ACCENT_COLORS, DEFAULT_CUSTOM,
  FUNERAL_PATTERNS, FUNERAL_MARKS, FUNERAL_FOOTERS, DEFAULT_FUNERAL, GREY,
  checkCustom, previewOf, expand, funeralPreview
};
