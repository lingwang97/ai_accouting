// utils/pdftheme.js — 传统礼簿 PDF 主题清单（与云函数 export/themes.js 保持一致；白事固定素灰，不在可选列表）
const LIST = [
  { key: 'red_gold', name: '中国红金', scene: '婚礼·通用', main: '#B71C1C', accent: '#D4AF37' },
  { key: 'wine_gold', name: '酒红鎏金', scene: '婚礼·庄重', main: '#7B1E2B', accent: '#C9A24B' },
  { key: 'peach', name: '桃粉', scene: '婚礼·浪漫', main: '#D8577A', accent: '#FDE8EE' },
  { key: 'shou_gold', name: '福寿金', scene: '寿宴', main: '#B8860B', accent: '#FFF1C9' },
  { key: 'pine', name: '松青', scene: '寿宴·长寿', main: '#2E6B4F', accent: '#C9A24B' },
  { key: 'orange', name: '暖橙', scene: '满月·周岁', main: '#E8833A', accent: '#FFF3E0' },
  { key: 'sky', name: '天蓝', scene: '满月·乔迁', main: '#2B7FFF', accent: '#E8F1FF' },
  { key: 'purple_gold', name: '紫金', scene: '乔迁·开业', main: '#5B3A8C', accent: '#D4AF37' },
  { key: 'ink_gold', name: '墨黑金', scene: '商务·开业', main: '#222222', accent: '#D4AF37' }
];
const DEFAULT_KEY = 'red_gold';

// 自定义主题（规则与云函数 export/themes.js 一致）
const FONTS = [{ k: 'sans', n: '黑体' }, { k: 'serif', n: '宋体' }, { k: 'brush', n: '毛笔' }];
const PATTERNS = [{ k: 'none', n: '无' }, { k: 'double', n: '双线' }, { k: 'huiwen', n: '回纹' }, { k: 'flower', n: '花朵' }, { k: 'cloud', n: '云纹' }, { k: 'diamond', n: '菱形' }, { k: 'line', n: '直角' }];
const MARKS = [{ k: '', n: '无' }, { k: '喜', n: '喜' }, { k: '寿', n: '寿' }, { k: '福', n: '福' }];
const MAIN_COLORS = ['#B71C1C', '#7B1E2B', '#B8860B', '#2E6B4F', '#0B3D6B', '#2B7FFF', '#5B3A8C', '#222222', '#6B3E1F', '#1F1F7A', '#006D77', '#8A2D5B'];
const ACCENT_COLORS = ['#D4AF37', '#F5D76E', '#FFFFFF', '#FDE8EE', '#FFF1C9', '#E8F1FF', '#C0C0C0', '#222222'];
const DEFAULT_CUSTOM = { main: '#0B3D6B', accent: '#F5D76E', font: 'serif', pattern: 'double', mark: '', footer: '', title: '' };
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

/** 封面预览色（辅色与主色对比不足时自动换黑 / 白，与云函数一致） */
function previewOf(c) {
  if (checkCustom(c)) return null;
  const dark = lum(c.main) < 0.18;
  const accent = contrast(c.main, c.accent) >= 3 ? c.accent : (dark ? '#FFFFFF' : '#222222');
  return { bg: c.main, border: accent, text: dark ? '#FFFFFF' : '#222222' };
}

module.exports = { LIST, DEFAULT_KEY, FONTS, PATTERNS, MARKS, MAIN_COLORS, ACCENT_COLORS, DEFAULT_CUSTOM, checkCustom, previewOf };
