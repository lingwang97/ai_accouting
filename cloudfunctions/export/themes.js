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
const MARKS = ['', '喜', '囍', '寿', '福']; // 喜事水印字（囍不在 GB2312，宋体子集已补；毛笔体没有，绘制时改用宋体）
// 白事可编辑项的限制（礼俗）：角饰只能无 / 双线 / 直角，水印只能无 / 奠；颜色一律素灰
const FUNERAL_PATTERNS = ['none', 'double', 'line'];
const FUNERAL_MARKS = ['', '奠'];
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
      title: clean(c.title).slice(0, 20),
      cover: HEX.test(String(c.cover || '')) ? String(c.cover).toUpperCase() : '' // 可选：封面文字色（由预设展开而来）
    }
  };
}

/**
 * 白事可编辑项：{ font, pattern, mark, footer, title }；颜色一律素灰，传入的颜色、喜事角饰 / 水印全部忽略
 * 永远返回合法值（非法项回落默认）
 */
function sanitizeFuneral(c) {
  c = c && typeof c === 'object' ? c : {};
  const clean = t => String(t || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return {
    font: FONTS.includes(c.font) ? c.font : 'sans',
    pattern: FUNERAL_PATTERNS.includes(c.pattern) ? c.pattern : 'none',
    mark: FUNERAL_MARKS.includes(c.mark) ? c.mark : '',
    footer: clean(c.footer).slice(0, 8),
    title: clean(c.title).slice(0, 20)
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
  if (funeral) {
    // 白事：素灰底 + 可编辑的字体 / 角饰 / 水印 / 标题 / 落款（已存的也再校验一遍）
    const grey = PRESETS.find(p => p.funeral);
    return key === 'custom' && custom ? Object.assign({}, grey, sanitizeFuneral(custom)) : grey;
  }
  if (key === 'custom') {
    const r = sanitizeCustom(custom);
    if (r.value) {
      const v = r.value;
      const dark = lum(v.main) < 0.18;
      const accent = contrast(v.main, v.accent) >= 3 ? v.accent : (dark ? '#FFFFFF' : '#222222');
      const cover = v.cover && contrast(v.main, v.cover) >= 3 ? v.cover : (dark ? '#FFFFFF' : '#222222');
      return { key: 'custom', name: '自定义', main: v.main, accent, cover, pattern: v.pattern, mark: v.mark, font: v.font, footer: v.footer, title: v.title };
    }
  }
  return PRESETS.find(p => p.key === key && !p.funeral) || PRESETS.find(p => p.key === DEFAULT_KEY);
}

// 尾页（封底）与装订：默认有封底、不留装订边（旧礼簿、旧版前端不传时同此）
const BINDS = ['none', 'single', 'double'];
const DEFAULT_BACK = { on: true, footer: '', sign: true, brand: true };

/**
 * 校验尾页设置 { on, footer, sign（默认开）, brand }（旧数据里的 host / date / sum 忽略）；永远返回合法值，缺省项取默认
 * footer：空 = 自动（封面落款，没有则按事由默认吉语；白事无吉语）；'-' = 不要落款；其他为自定义文字（≤8 字）
 */
function sanitizeBack(b) {
  b = b && typeof b === 'object' ? b : {};
  const raw = String(b.footer === undefined || b.footer === null ? '' : b.footer).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return {
    on: b.on !== false,
    footer: raw === '-' ? '-' : raw.slice(0, 8),
    sign: b.sign !== false, // v3.54.1 起默认开：未设置过的礼簿显示记账人签名
    brand: b.brand !== false
  };
}
const sanitizeBind = v => (BINDS.includes(v) ? v : 'none');

const isPresetKey = k => PRESETS.some(p => p.key === k && !p.funeral);

// v3.55.0 默认主题：没保存过主题的礼簿，按礼簿类型取默认预设和水印（前端 pages/booktheme/pdftheme.js 的 TYPE_DEFAULTS 须与此一致，tests 有比对）
const TYPE_DEFAULTS = {
  wedding: { key: 'red_gold', mark: '囍' },
  birthday: { key: 'shou_gold', mark: '寿' },
  baby: { key: 'orange', mark: '福' },
  house: { key: 'purple_gold', mark: '福' },
  funeral: { key: 'grey', mark: '奠' },
  other: { key: 'red_gold', mark: '' }
};
/** 礼簿类型的默认 { key, mark }；未知类型同 other */
function typeDefault(bookType) {
  return Object.assign({}, TYPE_DEFAULTS[bookType] || TYPE_DEFAULTS.other);
}
/** 没保存过主题时的最终主题：默认预设 + 默认水印（预设自带的水印与默认一致时即预设本身）；只在内存里用，不写库 */
function resolveDefault(bookType) {
  const d = typeDefault(bookType);
  const p = PRESETS.find(x => x.key === d.key) || PRESETS.find(x => x.key === DEFAULT_KEY);
  return p.mark === d.mark ? p : Object.assign({}, p, { mark: d.mark });
}

// v3.62.0 会员预留：免费版只能用这几套预设（黑体）；其余预设、自定义配色、宋体 / 毛笔、尾页设置属 features.pdfThemePremium
// 现阶段套餐全部开放，只有该项被明确设为 false 才限制（前端 pages/booktheme/pdftheme.js 的 FREE_KEYS 须一致，tests 有比对）
const FREE_KEYS = ['red_gold', 'peach', 'sky', 'grey'];
const isDefaultBack = b => { const s = sanitizeBack(b); return s.on && s.footer === '' && s.sign && s.brand; };

/**
 * 本次选择里用到的会员项（空数组 = 全是免费项）
 * @param {{funeral:boolean, key:string, custom:object, back:object}} s key 为空表示没选（按礼簿类型默认）
 */
function premiumUsed(s) {
  const used = [];
  if (s.funeral) {
    if (s.key === 'custom' && ['serif', 'brush'].includes(sanitizeFuneral(s.custom).font)) used.push('宋体 / 毛笔字体');
  } else if (s.key === 'custom') used.push('自定义配色');
  else if (s.key && !FREE_KEYS.includes(s.key)) used.push('该主题');
  if (s.back && !isDefaultBack(s.back)) used.push('尾页设置');
  return used;
}

/**
 * 套餐不含会员项时的降级（只用于生成，不改库）：非白事换成红金（保留礼簿类型默认水印），白事字体改黑体
 * @param {object} bt resolve / resolveDefault 的结果
 */
function freeOnly(bt, funeral, bookType) {
  if (funeral) return bt.font === 'sans' ? bt : Object.assign({}, bt, { font: 'sans' });
  if (FREE_KEYS.includes(bt.key)) return bt;
  return Object.assign({}, PRESETS.find(p => p.key === DEFAULT_KEY), { mark: typeDefault(bookType).mark });
}

/** 最终主题：key 为空按礼簿类型默认；premiumOk 为 false 时降级为免费项 */
function pick(premiumOk, funeral, bookType, key, custom) {
  const bt = key ? resolve(funeral, key, custom) : resolveDefault(bookType);
  return premiumOk ? bt : freeOnly(bt, funeral, bookType);
}

module.exports = { pick, FREE_KEYS, premiumUsed, freeOnly, isDefaultBack, PRESETS, DEFAULT_KEY, TYPE_DEFAULTS, typeDefault, resolveDefault, resolve, isPresetKey, sanitizeCustom, sanitizeFuneral, sanitizeBack, sanitizeBind, DEFAULT_BACK };
