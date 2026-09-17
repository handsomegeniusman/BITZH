'use strict';
/**
 * 「关于」页连点开关 —— **绑定位置**的回归测试。
 *
 * 【为什么这个脚本是读文本而不是调函数】连点逻辑全在页面文件里（about.wxml 的绑定 +
 *   about.js 的 staffTap），而页面文件依赖 `wx`，node 里 require 不了（本仓惯例：
 *   能抽成纯函数的才抽，见 auditGate.js / publishGate.js / catForm.js）。
 *   但"绑定挂在哪"恰恰是**改动过、且会静默回退**的东西：2026-09-17 它刚从底部四行挪到 logo。
 *   写错/漏改的表现是"点半天没反应" —— 不报错、不进日志、单测全绿，只有人肉点才知道。
 *   所以这里用最便宜的办法把它钉住：直接断言 wxml 里那一处绑定在哪。
 *
 * ⚠️ 这类断言**只在绑定形态不变的前提下有意义**。如果将来重构成组件或改用 catchtap，
 *    该改的是本文件，而不是把它删掉 —— 它挡的是"回退到四行"这种事故，不是重构。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      实际: ' + a + '\n      期望: ' + b); }
}

const WXML = path.resolve(__dirname, '..', 'miniprogram', 'pages', 'about', 'about.wxml');
const JS = path.resolve(__dirname, '..', 'miniprogram', 'pages', 'about', 'about.js');
const wxml = fs.readFileSync(WXML, 'utf8');
const js = fs.readFileSync(JS, 'utf8');

console.log('\n[连点开关挂在 logo 上（2026-09-17 从底部四行挪过来）]');

// 1) 全页只允许一处连点绑定 —— 两处会让计数被拆开，人更不容易凑满 5 次
const taps = wxml.match(/bindtap="staffTap"/g) || [];
check('全页 bindtap="staffTap" 恰好一处', taps.length, 1);

// 2) 那一处必须在 logo 的外层 view 上
const logoTag = (wxml.match(/<view[^>]*about-logo-wrap[^>]*>/g) || [])[0] || '';
check('logo 外层 view 存在', logoTag.length > 0, true);
check('  且连点就挂在它上面', logoTag.indexOf('bindtap="staffTap"') >= 0, true);

// 3) 长按进后台的入口不能被挪丢（两个绑定刻意共存于同一个元素）
check('  同一个元素上长按进后台仍在（bindlongpress="edit"）',
  logoTag.indexOf('bindlongpress="edit"') >= 0, true);

// 3b) 【长按与连点不冲突 —— 这条必须是结构保证，不能只是"微信应该会那样"】
//     两个绑定在同一个元素上，一旦平台真的在长按后又补一个 tap，表现是
//     **管理员每次进后台都白 +1**，攒够 5 次弹一个他不需要的开通提示 —— 无声、每次发生。
//     所以 edit() 记时间戳、staffTap() 按窗口吃掉紧接着的那次 tap。
check('  长按时刻一个时间戳（冲突判据的来源）',
  js.indexOf('this._lastLongPressAt = Date.now();') >= 0, true);
check('  连点开头按时间窗吃掉长按后的那次 tap',
  /staffTap\(\)\s*\{[\s\S]{0,900}_lastLongPressAt/.test(js), true);
check('  ⚠️ 用时间戳而不是布尔标志（布尔标志会反过来吃掉下一次真的连点）',
  /_lastLongPressAt\s*\|\|\s*0\)\s*< \d+/.test(js), true);

// 4) 底部四行只剩署名，一个点击行为都不许有
const staffTags = wxml.match(/<view class="staff"[^>]*>/g) || [];
check('底部署名仍是四行', staffTags.length, 4);
check('  四行**全都**没有 bindtap（挪入口时最容易漏的一处）',
  staffTags.filter(function (t) { return t.indexOf('bindtap') >= 0; }).length, 0);

console.log('\n[计数口径（读 about.js 的字符串，防止被顺手改掉）]');

check('阈值是 5 次', js.indexOf('if (this._staffTaps < 5) return;') >= 0, true);
check('  离开页面清零 —— onHide', /onHide[\s\S]{0,200}_staffTaps = 0/.test(js), true);
check('  离开页面清零 —— onUnload', /onUnload[\s\S]{0,200}_staffTaps = 0/.test(js), true);

// 5) 两个分支的判据是 isFeeder（与云函数各自再查一遍的口径一致）
check('分流判据是 isFeeder 而不是别的', js.indexOf('if (app.globalData.isFeeder) this.grantSelfEnable();') >= 0, true);

// 6) 已注册那条的提示：两句话都要在（需求方口径「请重新进入小程序」+ 当场生效的说法）
check('成功提示用弹窗（toast 装不下两句）', js.indexOf("wx.showModal({") >= 0, true);
check('  含「若首页还是进不去，请完全退出小程序后重新进入」兜底句',
  js.indexOf('请完全退出小程序后重新进入') >= 0, true);
check('  也含当场生效的说法（不能说成"必须重进"）',
  js.indexOf('审核模式下现在可以看见内容了') >= 0, true);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
