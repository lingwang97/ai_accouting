// utils/scenes.js — 礼簿场景（事由类型）与模板预设
// 场景决定电子回执与打印小票的标题、配色、印章与致谢语。
// 白事务必素色、无红章、无喜庆字眼，避免不合礼俗。
const SCENES = [
  {
    type: 'wedding', label: '喜事',
    receipt: { title: '礼金回执', color: '#C8161D', style: 'card', showStamp: true, stamp: '囍', footer: '百年好合，感谢光临' },
    print: { title: '礼金回执', thanks: '感谢光临，百年好合' }
  },
  {
    type: 'birthday', label: '寿宴',
    receipt: { title: '贺寿礼单', color: '#B8860B', style: 'ticket', showStamp: true, stamp: '寿', footer: '福如东海，寿比南山，感谢光临' },
    print: { title: '贺寿礼单', thanks: '感谢光临，福寿安康' }
  },
  {
    type: 'baby', label: '满月/周岁',
    receipt: { title: '礼金回执', color: '#FF7A45', style: 'card', showStamp: true, stamp: '喜', footer: '感谢亲友祝福，愿宝宝健康成长' },
    print: { title: '礼金回执', thanks: '感谢祝福，宝宝健康成长' }
  },
  {
    type: 'house', label: '乔迁',
    receipt: { title: '礼金回执', color: '#C9A227', style: 'ticket', showStamp: true, stamp: '贺', footer: '乔迁之喜，感谢光临' },
    print: { title: '礼金回执', thanks: '乔迁之喜，感谢光临' }
  },
  {
    type: 'funeral', label: '白事',
    receipt: { title: '奠仪回执', color: '#333333', style: 'simple', showStamp: false, stamp: '', footer: '承蒙吊唁，叩谢亲友' },
    print: { title: '奠仪回执', thanks: '承蒙吊唁，叩谢亲友' }
  },
  {
    type: 'other', label: '其他',
    receipt: { title: '礼金回执', color: '#C8161D', style: 'card', showStamp: true, stamp: '谨收', footer: '承蒙厚爱，谨致谢忱' },
    print: { title: '礼金回执', thanks: '承蒙厚爱，谨致谢忱' }
  }
];

/** 宾客与主家的关系（随礼页单选、礼簿按关系统计） */
const RELATIONS = ['亲戚', '朋友', '同事', '同学', '邻里', '其他'];

const byType = type => SCENES.find(s => s.type === type) || SCENES[SCENES.length - 1];
const label = type => byType(type).label;

module.exports = { SCENES, RELATIONS, byType, label };
