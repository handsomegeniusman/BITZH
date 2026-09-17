'use strict';
/**
 * 首页「切回来时重算审核闸门」—— **结构级**回归测试（读 index.js 的文本）。
 *
 * 【为什么这个脚本是读文本而不是调函数】与 tests/aboutTap.test.js 同一套理由：
 *   index.js 是页面文件（依赖 `wx` / `getApp`），node 里 require 不了，本仓惯例是
 *   "能抽成纯函数的才单测"。而这段逻辑恰恰属于**会静默回退**的那一类 ——
 *   它修的是一个只有走完"连点五次 → 去首页"才看得见的 bug（首页的瀑布流只在 onLoad
 *   读一次闸门），平时怎么逛都正常。删掉 onShow 里那一行、或者把 `_auditSettled`
 *   那道闸去掉，单测全绿、页面也不报错，只是：**开通完点「去首页」，看到的是一个
 *   什么都没变的首页**，用户只能杀进程重进（about.js 的兜底提示写的正是这句）。
 *   所以这里用最便宜的办法把它钉住：直接断言那几行的形状。
 *
 * ⚠️ 这类断言**只在结构不变的前提下有意义**。若将来把它抽成 utils 里的纯函数，
 *    该改的是本文件（改成测那个纯函数），而不是把它删掉 —— 它挡的是"onShow 那条线
 *    被删掉/被绕开"这种事故，不是重构。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      实际: ' + a + '\n      期望: ' + b); }
}

const JS = path.resolve(__dirname, '..', 'miniprogram', 'pages', 'index', 'index.js');
const js = fs.readFileSync(JS, 'utf8');

console.log('\n[首页切回来时重算审核闸门（2026-09-17 加）]');

// 1) 方法必须存在，且真的被 onShow 调用 —— 只定义不调用是这套改动最常见的半成品
check('onShow 里调了 recheckGateOnShow（只定义不调用 = 没修）',
  /onShow\(\)\s*\{[\s\S]{0,400}this\.recheckGateOnShow\(\)/.test(js), true);
check('  recheckGateOnShow 方法存在',
  /recheckGateOnShow\(\)\s*\{/.test(js), true);

// 2) 【本文件存在的头号理由】首屏标记的那道闸不能省
//    省掉它 → 首次进首页时 onLoad 与本函数各发一次 getAuditForMe，两个回调都调 getPage
//    → **第一页拉两遍**。那是"首页变慢"的现成来源，而且只在首次进入时发生。
const method = (js.match(/recheckGateOnShow\(\)\s*\{[\s\S]*?\n  \},/) || [''])[0];
check('  方法体取到了（正则没失效）', method.length > 0, true);
check('  ⚠️ 开头的第一件事就是判 _auditSettled（首屏归 onLoad）',
  /recheckGateOnShow\(\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*if \(!this\._auditSettled\) return;/.test(js), true);
check('  ⚠️ 这个判断必须在 getAuditForMe **之前**（放到后面就白拦了）',
  method.indexOf('_auditSettled') >= 0 &&
    method.indexOf('_auditSettled') < method.indexOf('getAuditForMe'), true);

// 3) onLoad 必须把首屏标记**两条路都写上**
//    catch 里漏写 → 闸门读失败一次，onShow 就永远不敢重算（功能静默死掉）。
//    用"出现次数 == 2"而不是"存在"：只写一处是这里最容易出现的漏。
check('onLoad 里 _auditSettled = true 写了两次（then 与 catch 各一次）',
  (js.match(/_auditSettled = true;/g) || []).length, 2);

// 4) 只处理「由闭变开」：反过来会把已经渲染好的内容抹掉，那不属于本页职责
check('  ⚠️ 条件里同时要求「新结果开着」且「当前是关着」（只认 false → true）',
  /if \(!audit \|\| this\.data\.audit\) return;/.test(js), true);
check('  确实补加载了瀑布流（不是只改 data.audit 让页面更自相矛盾）',
  /if \(!audit \|\| this\.data\.audit\) return;[\s\S]{0,200}this\.getPage\(\)/.test(js), true);

// 5) 别把 onShow 变成"每次都重拉"—— 那会反过来让切 tab 变慢（本改动要修的就是慢）
check('  ⚠️ 重算失败时不重试、不放任（失败只记日志，不递归）',
  /catch\(\(err\) => console\.error\('\[index\] onShow 重算审核闸门失败', err\)\)/.test(js), true);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
