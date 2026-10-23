// 最小测试框架：test(name, fn)，fn 可为 async；用 node 原生 assert，不引入依赖。
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
module.exports = { test, queue };
