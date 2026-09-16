'use strict';
/**
 * 一键跑 tests/ 下全部单测：node tests/run-all.js
 *
 * 【为什么需要】脚本从 6 个长到 9 个之后，"一个个 node 过去"就开始漏了 ——
 *   而漏掉的那个恰好可能是唯一能挡住某类 bug 的（比如 publishGate 专盯禁言，
 *   忘了加 mute 条件时它才报错，而人工测试对管理员账号根本看不出来）。
 *   一条命令跑完，退出码 0 才算过关。
 *
 * 【零依赖】只用 node 内置模块，和 tests/ 下其它脚本一样不需要 npm install。
 * 【输出策略】平时只印每个脚本的最后一行汇总；**失败的那个印全量输出** ——
 *   全印出来会淹掉真正要看的东西，不印又没法定位。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const files = fs.readdirSync(DIR)
  .filter(function (f) { return /\.test\.js$/.test(f); })
  .sort();

if (!files.length) {
  console.error('没有找到任何 *.test.js');
  process.exit(1);
}

let failed = [];
const started = Date.now();
console.log('跑 ' + files.length + ' 个单测脚本（node ' + process.version + '）\n');

files.forEach(function (f, i) {
  const t0 = Date.now();
  // 【为什么把 stdout 重定向到文件而不是用管道】tests/ 下的脚本末尾都调 process.exit()，
  //   而 node 的 stdout 在**指向管道**时是异步的，exit 会把还没冲刷的最后一截丢掉 ——
  //   于是每个脚本的汇总行（恰好是最后一行）时有时无。写文件是同步的，不会丢。
  const tmp = path.join(os.tmpdir(), 'bitzh-test-' + process.pid + '-' + i + '.log');
  const fd = fs.openSync(tmp, 'w');
  let r;
  try {
    // 用 process.execPath 而不是裸 'node'：某些机器上 node 不在 PATH 里，
    // 但跑得起来本脚本就说明这个解释器是存在的。
    r = spawnSync(process.execPath, [path.join(DIR, f)], { stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  const out = fs.readFileSync(tmp, 'utf8');
  fs.unlinkSync(tmp);
  const ms = Date.now() - t0;

  // 汇总行的格式各脚本不完全一致（"结果: N 通过 / M 失败" 与 "通过 N / 失败 M"），
  // 所以按模式找、不解析数字；判定一律以退出码为准。
  const m = out.match(/(结果:\s*)?\d+\s*(通过|\/)\s*[^/\n]*\/?\s*\d*\s*失败[^\n]*/);
  const summary = m ? m[0].trim() : '(退出码 ' + r.status + '，无汇总行)';
  const ok = r.status === 0;
  console.log((ok ? '  ✅ ' : '  ❌ ') + String(i + 1).padStart(2) + '. '
    + f.padEnd(28) + summary + '   [' + ms + 'ms]');
  if (!ok) {
    failed.push(f);
    console.log('     ── 完整输出 ──');
    console.log(out.trim().split('\n').map(function (l) { return '     ' + l; }).join('\n'));
    if (r.error) console.log('     启动失败: ' + r.error.message);
    if (r.signal) console.log('     被信号终止: ' + r.signal);
    console.log('     ──────────────');
  }
});

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log('');
if (failed.length) {
  console.log('❌ ' + failed.length + '/' + files.length + ' 个脚本失败：' + failed.join('、'));
  console.log('   上面每个失败脚本都印了完整输出（FAIL 行的 got / want 就是差异）。');
  process.exit(1);
}
console.log('✅ ' + files.length + ' 个脚本全部通过（' + secs + 's）');
console.log('   单测不连真实数据库（全部 mock），所以通过 ≠ 线上没问题 ——');
console.log('   页面类改动仍要照 测试清单.md 在开发者工具里手动过一遍。');
