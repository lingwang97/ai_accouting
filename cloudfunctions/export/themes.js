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

/**
 * 解析最终主题：白事一律素灰（强制，忽略任何传入）；其余按 key 取，非法或缺失回落红金（兼容旧礼簿）
 * @param {boolean} funeral 是否白事
 * @param {string} key 预设 key
 */
function resolve(funeral, key) {
  if (funeral) return PRESETS.find(p => p.funeral);
  return PRESETS.find(p => p.key === key && !p.funeral) || PRESETS.find(p => p.key === DEFAULT_KEY);
}

const isPresetKey = k => PRESETS.some(p => p.key === k && !p.funeral);

module.exports = { PRESETS, DEFAULT_KEY, resolve, isPresetKey };
