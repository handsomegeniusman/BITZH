'use strict';
/**
 * 「关于」页连点开关 —— **行为级**测试：把 about.js 真的 require 进来，调 staffTap / edit。
 *
 * 【和 tests/aboutTap.test.js 的分工】
 *   那个脚本读**文本**（绑定挂在哪个元素、阈值是不是 5、提示怎么写），便宜、稳、不依赖桩；
 *   这个脚本**跑代码**，覆盖读文本读不出来的东西：
 *     · 长按后紧跟的那次 tap 到底有没有被吃掉（只断言"代码里有 _lastLongPressAt"证明不了）
 *     · 那个时间窗会不会**永久生效**（写错成布尔标志就会反过来吃掉下一次真连点）
 *     · 已注册 / 未注册两条分支各自走到哪儿（一条调云函数、一条只开内存入口）
 *   两者都要留着：删掉文本那份，绑定位置回退了没人知道；删掉这份，逻辑写错了没人知道。
 *
 * 【为什么可以破例给页面文件写测试】本仓惯例是"能抽成纯函数的才单测"（auditGate /
 *   publishGate / catForm），页面文件依赖 `wx` 所以 require 不了。这里靠桩把 about.js
 *   硬拽进 node —— 代价是这个文件必须跟着 about.js 的内部结构走（`_staffTaps` 等字段名）。
 *   收益是它是**唯一**能覆盖"两条分支 + 长按共存"的东西，而这几处恰好都是"错了也不报错"
 *   的类型（点半天没反应 / 每次进后台白 +1）。
 *
 * ⚠️ 三个已踩过的坑，改这个文件前先看：
 *   ① `const app = getApp()` 在 **require 时**就求值了，之后再换 `global.getApp` 没用 ——
 *      必须让 getApp 返回**同一个对象**，然后改那个对象的字段。
 *   ② grantSelfEnable 是 async（要 await 云函数），调完 staffTap 要让出一次事件循环，
 *      否则断言跑在弹窗之前，看起来像"没触发"。
 *   ③ `Module._resolveFilename` 在 Windows 上返回**反斜杠**路径。桩表的键必须归一化后再比，
 *      否则匹配永远失败、**偷偷加载真模块**，而测试还是绿的（假绿 —— 初版就是这样，
 *      直到断言"只开了内存入口"才暴露）。
 *   ④ 桩必须在**解析之前**命中。`miniprogram/config.js` 是 gitignore 的、别人机器上不存在，
 *      若先调 realResolve 会 MODULE_NOT_FOUND —— 那样这个测试就换台机器就跑不了。
 *   ⑤ db 的桩表是**手写的**，所以 about.js 每多调一个 db 方法，这里就得补一个 ——
 *      漏了不会报"桩不全"，而是 `TypeError: db.xxx is not a function` 被 about.js 自己的
 *      try/catch 吃成"开通失败"，看起来像功能坏了。（2026-09-17 加 markSelfEnable 时就是这样：
 *      本文件第 6 组与第 2 组各红一条，是**它**先发现的，不是人肉点出来的。）
 */
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function check(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      实际: ' + a + '\n      期望: ' + b); }
}

// ---- 桩：稳定单例的 app（坑①） ----
const APP = {
  globalData: { url: '', isFeeder: true, isAdministrator: false, userId: 'u1' },
  mpServerless: { function: { invoke: async () => ({ result: { ok: true } }) } },
};
const navigated = [], toasts = [], modals = [];

global.getApp = () => APP;
global.wx = {
  navigateTo: (o) => navigated.push(o.url),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => modals.push(o),
  showLoading: () => {}, hideLoading: () => {}, switchTab: () => {},
  createRewardedVideoAd: () => null, setNavigationBarTitle: () => {},
};

const openedRegist = { v: false };
// 记下"开通成功后到底动了哪些缓存"——见下面第 6 组断言，这是本次 switchTab 优化的契约所在
const cacheCalls = [];
// 按「请求尾部」认桩（坑④：不解析真实路径，所以不依赖 miniprogram/config.js 存在）
const STUBS = [
  ['utils/db.js', {
    unlockRegist: () => { openedRegist.v = true; },
    // 【这两个桩必须留着并计数】它们代表"大扫帚"清缓存法：清掉 userId / 名册 / 全局开关之后，
    //   紧接着 switchTab 到首页要连着跑 4 次网络往返才能算出闸门 —— 那正是"跳转有点慢"的来源。
    //   正确的写法只调 markSelfEnable（精准写 state.enable 一个字段），下面有断言钉着。
    resetUserState: () => { cacheCalls.push('resetUserState'); },
    resetAuditCache: () => { cacheCalls.push('resetAuditCache'); },
    markSelfEnable: () => { cacheCalls.push('markSelfEnable'); },
    getContact: async () => ({ phone: '', email: '' }),
    isRegistUnlocked: () => false,
  }],
  ['config.js', { adUnitId: '' }],
  ['utils/clipboard.js', { copy: () => {} }],
];
const norm = (p) => String(p).replace(/\\/g, '/');
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const req = norm(request);
  for (let i = 0; i < STUBS.length; i++) {
    if (req.slice(-STUBS[i][0].length) === STUBS[i][0]) return STUBS[i][1];
  }
  return realLoad.apply(this, arguments);
};

let page = null;
global.Page = (obj) => { page = obj; };
const ABOUT = path.resolve(__dirname, '..', 'miniprogram', 'pages', 'about', 'about.js');
// 只在 require 期间压掉日志（模块顶层可能打东西）。
// ⚠️ 调用期间的 `[about] logo 连点 N/5` **刻意留着** —— 其中
//    「刚长按过 logo，这次点击不计入连点」正是第 3 组断言的现场证据，
//    压掉了反而只剩一句"断言通过了"，看不出它真的走了那条分支。
//    （初版注释写的是"捕获掉保持输出可读"，但那只覆盖 require 那一瞬，是句假话。）
const realLog = console.log;
console.log = () => {};
try { require(ABOUT); } finally { console.log = realLog; }

const tick = () => new Promise((r) => setTimeout(r, 0));
// 原型链上拿页面方法，_staffTaps 是自己的（模拟页面实例）
const ctxOf = () => Object.assign(Object.create(page), { _staffTaps: 0 });

(async function main() {
  console.log('\n[连点开关 · 行为级（真跑 about.js）]');
  check('页面对象已被 Page() 捕获', !!page, true);
  check('  staffTap / edit 都在', [typeof page.staffTap, typeof page.edit], ['function', 'function']);

  const ctx = ctxOf();
  const tap = () => page.staffTap.call(ctx);

  // ---- 1) 连点 4 次不该触发 ----
  for (let i = 0; i < 4; i++) tap();
  check('连点 4 次：计数 4、不弹任何东西',
    [ctx._staffTaps, modals.length, navigated.length], [4, 0, 0]);

  // ---- 2) 第 5 次触发「已注册」那条 ----
  tap();
  check('第 5 次：计数清零', ctx._staffTaps, 0);
  await tick();
  check('  → 弹出「已开通」弹窗（不是 toast）',
    [modals.length, modals[0] && modals[0].title], [1, '已开通']);
  check('    含兜底那句「请完全退出小程序后重新进入」',
    !!modals[0] && modals[0].content.indexOf('请完全退出小程序后重新进入') >= 0, true);
  check('    也含「当场生效」那句（不能只说必须重进）',
    !!modals[0] && modals[0].content.indexOf('现在可以看见内容了') >= 0, true);
  check('    没有退化成一闪而过的 toast', toasts.length, 0);

  // ---- 2b) 【本次 switchTab 优化的契约】只精准写 enable，不许用清空缓存那把大扫帚 ----
  //     断言的是"缓存调用序列"，因为这两种写法在功能上**都能让新状态生效**，
  //     差别只在"紧接着切页时闸门要不要重跑 4 次网络往返"—— 人肉点不出来，只有这条能挡。
  check('  ⚠️ 开通成功后只调 markSelfEnable（精准写 state.enable）', cacheCalls, ['markSelfEnable']);
  check('     ⚠️ 绝不能去调 resetUserState / resetAuditCache（那会把 userId 与全局开关也清掉）',
    cacheCalls.filter(function (k) { return k !== 'markSelfEnable'; }), []);

  // ---- 3) 【本文件存在的头号理由】长按后紧跟的 tap 必须被吃掉 ----
  modals.length = 0;
  ctx._staffTaps = 0;
  page.edit.call(ctx);
  check('长按（非管理员）：不跳转、不计数', [navigated.length, ctx._staffTaps], [0, 0]);
  tap();
  check('  ⚠️ 紧跟长按的那次 tap 被吃掉 → 计数仍为 0（"长按与连点不冲突"的实证）',
    ctx._staffTaps, 0);

  // ---- 4) 时间窗不能永久生效（写成布尔标志就会栽在这条） ----
  ctx._lastLongPressAt = Date.now() - 5000;
  for (let i = 0; i < 5; i++) tap();
  await tick();
  check('  ⚠️ 5 秒前长按过 → 之后连点照样凑满 5 次（没被永久吃掉）',
    [ctx._staffTaps, modals.length], [0, 1]);

  // ---- 5) 管理员：长按进后台，且同样不污染连点 ----
  navigated.length = 0;
  const admCtx = ctxOf();
  APP.globalData.isAdministrator = true;
  page.edit.call(admCtx);
  check('管理员长按 → 进「管理员」页', navigated, ['/pages/Administrator/Administrator']);
  check('  且这次长按没计入连点', admCtx._staffTaps || 0, 0);
  page.staffTap.call(admCtx);
  check('  ⚠️ 管理员长按后紧跟的 tap 同样被吃掉', admCtx._staffTaps, 0);

  // ---- 6) 未注册那条：只开内存入口，不碰云函数 ----
  APP.globalData.isAdministrator = false;
  APP.globalData.isFeeder = false;
  modals.length = 0;
  openedRegist.v = false;
  const unCtx = ctxOf();
  for (let i = 0; i < 5; i++) page.staffTap.call(unCtx);
  await tick();
  check('未注册连点 5 次 → 弹「已开放注册入口」',
    [modals.length, modals[0] && modals[0].title], [1, '已开放注册入口']);
  check('  只开了内存里的注册入口（没弹「已开通」、没有 toast）',
    [openedRegist.v, toasts.length, modals[0].title === '已开通'], [true, 0, false]);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
