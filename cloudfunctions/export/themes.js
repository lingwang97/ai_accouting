// 传统礼簿 PDF 主题表：10 种预设（白事 grey 只能用于白事礼簿，其余只用于非白事）
// main：封面底色 / 内页格线 / 栏目字色；accent：封面边框、标题；cover：封面说明文字；
// pattern：封面角饰（double | huiwen | flower | cloud | diamond | line）；mark：水印字（须在 GB2312 内）；font：sans | serif | brush
const PRESETS = [
  { key: 'red_gold', name: '中国红金', scene: '婚礼·通用', main: '#B71C1C', accent: '#D4AF37', cover: '#F8E7B0', pattern: 'double', mark: '', font: 'sans', footer: '' },
  { key: 'wine_gold', name: '酒红鎏金', scene: '婚礼·庄重', main: '#7B1E2B', accent: '#C9A24B', cover: '#F3E2B3', pattern: 'huiwen', mark: '喜', font: 'serif', footer: '百年好合' },
  { key: 'peach', name: '桃粉', scene: '婚礼·浪漫', main: '#D8577A', accent: '#FDE8EE', cover: '#FFFFFF', pattern: 'flower', mark: '', font: 'sans', footer: '琴瑟和鸣' },
  { key: 'shou_gold', name: '福寿金', scene: '寿宴', main: '#B8860B', accent: '#FFF1C9', cover: '#FFF8E1', pattern: 'diamond', mark: '寿', font: 'serif', footer: '福寿安康' },
  { key: 'pine', name: '松青', scene: '寿宴·长寿', main: '#2E6B4F', accent: '#C9A24B', cover: '#E8F0D8', pattern: 'diamond', mark: '寿', font: 'serif', footer: '松鹤延年' },
  { key: 'orange', name: '暖橙', scene: '满月·周岁', main: '#E8833A', accent: '#FFF3E0', cover: '#FFFFFF', pattern: 'cloud', mark: '', font: 'sans', footer: '福泽绵长' },
  { key: 'sky', name: '天蓝', scene: '满月·乔迁', main: '#2B7FFF', accent: '#E8F1FF', cover: '#FFFFFF', pattern: 'line', mark: '', font: 'sans', footer: '' },
  { key: 'purple_gold', name: '紫金', scene: '乔迁·开业', main: '#5B3A8C', accent: '#D4AF37', cover: '#F3E6B8', pattern: 'huiwen', mark: '', font: 'sans', footer: '' },
  { key: 'ink_gold', name: '墨黑金', scene: '商务·开业', main: '#222222', accent: '#D4AF37', cover: '#F0DFA0', pattern: 'line', mark: '', font: 'sans', footer: '' },
  { key: 'grey', name: '素灰', scene: '白事', main: '#555555', accent: '#333333', cover: '#333333', pattern: 'none', mark: '', font: 'sans', footer: '', funeral: true }
];

const DEFAULT_KEY = 'red_gold';

const PATTERNS = ['double', 'huiwen', 'flower', 'cloud', 'diamond', 'line', 'none'];
const FONTS = ['sans', 'serif', 'brush'];
const MARKS = ['', '喜', '寿', '福']; // 水印字只能在这几个里选（均在 GB2312 内）
const HEX = /^#[0-9a-fA-F]{6}$/;

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/**
 * 校验并规范自定义主题：{ main, accent, font, pattern, mark, footer, title }
 * 返回 { value } 或 { error }。主色用于封面底色与内页格线（印在白纸上），太浅看不清则拒绝；
 * 辅色与主色对比不足时在绘制时自动换成黑 / 白（见 resolve）
 */
function sanitizeCustom(c) {
  c = c && typeof c === 'object' ? c : {};
  const main = String(c.main || '').toUpperCase();
  const accent = String(c.accent || '').toUpperCase();
  if (!HEX.test(main) || !HEX.test(accent)) return { error: '颜色格式不正确' };
  if (lum(main) > 0.4) return { error: '主色太浅，打印后看不清，请换深一点的颜色' };
  const clean = t => String(t || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return {
    value: {
      main, accent,
      font: FONTS.includes(c.font) ? c.font : 'sans',
      pattern: PATTERNS.includes(c.pattern) ? c.pattern : 'double',
      mark: MARKS.includes(c.mark) ? c.mark : '',
      footer: clean(c.footer).slice(0, 8),
      title: clean(c.title).slice(0, 20)
    }
  };
}

/**
 * 解析最终主题：白事一律素灰（强制，忽略任何传入）；key='custom' 用自定义项；
 * 其余按 key 取，非法或缺失回落红金（兼容旧礼簿）
 * @param {boolean} funeral 是否白事
 * @param {string} key 预设 key 或 'custom'
 * @param {object} [custom] 自定义项（已存的也再校验一遍，坏数据回落红金）
 */
function resolve(funeral, key, custom) {
  if (funeral) return PRESETS.find(p => p.funeral);
  if (key === 'custom') {
    const r = sanitizeCustom(custom);
    if (r.value) {
      const v = r.value;
      const dark = lum(v.main) < 0.18;
      const accent = contrast(v.main, v.accent) >= 3 ? v.accent : (dark ? '#FFFFFF' : '#222222');
      return { key: 'custom', name: '自定义', main: v.main, accent, cover: dark ? '#FFFFFF' : '#222222', pattern: v.pattern, mark: v.mark, font: v.font, footer: v.footer, title: v.title };
    }
  }
  return PRESETS.find(p => p.key === key && !p.funeral) || PRESETS.find(p => p.key === DEFAULT_KEY);
}

const isPresetKey = k => PRESETS.some(p => p.key === k && !p.funeral);

module.exports = { PRESETS, DEFAULT_KEY, resolve, isPresetKey, sanitizeCustom };
