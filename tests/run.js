// 一条命令跑完全部测试：node tests/run.js
// 约定：tests/*.test.js 里用 test(name, fn) 注册用例（见 helpers/harness.js）；任一失败退出码为 1。
const fs = require('fs');
const path = require('path');
const { queue } = require('./helpers/harness.js');

(async () => {
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
  let pass = 0, fail = 0, skip = 0;
  for (const f of files) {
    const start = queue.length;
    console.log(`\n# ${f}`);
    try { require(path.join(__dirname, f)); } catch (e) {
      fail++; console.log(`  FAIL  加载失败\n        ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n        ')}`); continue;
    }
    for (const t of queue.slice(start)) {
      try {
        const r = await t.fn();
        if (typeof r === 'string' && r.startsWith('SKIP')) { skip++; console.log(`  skip  ${t.name}（${r.slice(5)}）`); } else { pass++; console.log(`  ok    ${t.name}`); }
      } catch (e) {
        fail++; console.log(`  FAIL  ${t.name}\n        ${String((e && e.message) || e).split('\n').join('\n        ')}`);
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})();
