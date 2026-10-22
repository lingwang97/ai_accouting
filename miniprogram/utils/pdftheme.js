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
module.exports = { LIST, DEFAULT_KEY };
