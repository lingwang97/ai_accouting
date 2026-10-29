// common.js — 云函数公共小工具：统一返回格式、北京时间。
// 源文件在 tools/cloud-shared/common.js，由 tools/sync_shared.py 复制到各云函数目录，勿在副本里直接修改。

/** 统一返回格式：{ code: 0, msg: 'ok', data } / { code: 1, msg, data: null }（前端 utils/request.js 据此判断） */
const ok = data => ({ code: 0, msg: 'ok', data });
const err = msg => ({ code: 1, msg, data: null });

const pad = n => (n < 10 ? '0' + n : '' + n);

/** 云函数运行在 UTC，日期统一按北京时间（UTC+8）；返回 { day: 'YYYY-MM-DD', hm: 'HH:MM', hour: 0~23 } */
function bj(d) {
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  return {
    day: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    hm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    hour: t.getUTCHours()
  };
}
/** 北京时间的日期 YYYY-MM-DD */
const bjDay = d => bj(d).day;
/** 北京时间的 YYYY-MM-DD HH:MM */
const bjTime = d => { const b = bj(d); return `${b.day} ${b.hm}`; };
/** 北京时间的小时（0~23） */
const bjHour = d => bj(d).hour;

module.exports = { ok, err, bj, bjDay, bjTime, bjHour };
