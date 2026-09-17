'use strict';
/**
 * utils/auditGate.js 测试 —— 「审核模式对这个用户生效吗」的唯一判断式。
 *
 * 【为什么这个文件有价值】这条判断式决定 6 个入口的显隐，而它错了**在开发者自己的手机上
 *   完全看不出来**：开发时用的永远是自己的号 —— 既是管理员（名册豁免）、又通常 enable=true
 *   （第二种豁免），两道豁免叠在一起，怎么改都看着正常。差别只在**未注册的游客 / 微信审核员**
 *   那边露出来，而那恰恰是最不会去测的身份。换句话说：这个功能坏掉的表现是
 *   "审核模式下审核员照样能看到全部内容"，即它存在的**唯一目的**失效，而且没人会觉得哪里不对。
 *
 * 纯模块、无 wx / 无 db，所以能直接 node 跑。
 * （同类先例：tests/publishGate.test.js、tests/catForm.test.js。）
 */
const g = require('../miniprogram/utils/auditGate.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      got : ' + a + '\n      want: ' + b); }
}

console.log('[全真值表：全局开关 × 本人 enable × 管理员名册]');
// 这一组是整个文件的核心。八格里只有一格是"受限"。
// 参数顺序：auditOpen(globalAudit, enable, isAdministrator)
const TABLE = [
  // [全局 audit, enable, isAdministrator, 期望, 说明]
  [true, true, true, true, '全局开放 + 全豁免 → 开放'],
  [true, true, false, true, '全局开放 + 已激活 → 开放'],
  [true, false, false, true, '全局开放 + 未激活 + 非管理员 → **仍然开放**（开放期对所有人开放，不看后两项）'],
  [true, false, true, true, '全局开放 + 未激活 + 管理员 → 开放'],
  [true, undefined, undefined, true, '全局开放 + 两个豁免字段都没有 → 仍然开放'],
  [false, true, false, true, '审核模式 + 已激活 → **开放**（Feeder.enable 豁免）'],
  [false, false, true, true, '审核模式 + 未激活 + 管理员 → **开放**（名册豁免）'],
  [false, false, false, false, '审核模式 + 未激活 + 非管理员 → **受限**（八格里唯一一格）'],
  [false, undefined, undefined, false, '审核模式 + 两个豁免字段都没有 → 受限（老用户/游客不能白拿豁免）'],
];
TABLE.forEach(function (row) {
  check(row[4], g.auditOpen(row[0], row[1], row[2]), row[3]);
});

console.log('\n[审核模式：到底挡谁]');
// 用户口径：审核模式只挡三种人 —— 没注册的、注册了但没有 enable 字段的、enable=false 的；
// 管理员**不在**被挡之列（哪怕他没有 Feeder 记录）。
check('未注册的游客（没有 Feeder 记录 → enable 为假值）→ 受限',
  g.auditOpen(false, false, false), false);
check('注册了但文档里没有 enable 字段 → 受限（不能用 isFeeder 当豁免条件）',
  g.auditOpen(false, undefined, false), false);
check('注册了且 enable=true → 放行', g.auditOpen(false, true, false), true);
check('游客但是管理员（只加进了 BITZHAdministrator 名册）→ 放行',
  g.auditOpen(false, undefined, true), true);

console.log('\n[管理员豁免：防的是"管理员被自己的开关挡住"]');
// 这一组是第二轮加进来的。它有一个共同点：**在开发者本人的账号上全部返回 true，
// 看不出对错** —— 因为开发者本人通常两道豁免都有。所以只能靠这里钉死。
check('只加了名册、从没注册过 Feeder 的管理员（enable 缺失）→ 放行（旧写法会把他挡死）',
  g.auditOpen(false, undefined, true), true);
check('管理员 + 有人手工把他 enable 改成 false → 仍然放行（豁免是或的关系，不是与）',
  g.auditOpen(false, false, true), true);
check('管理员 + 全局开放 → 放行', g.auditOpen(true, false, true), true);
check('豁免是"看身份"不是"看权限"：管理员与非管理员只差第三参',
  [g.auditOpen(false, false, false), g.auditOpen(false, false, true)], [false, true]);

console.log('\n[归一化：控制台手改出来的非布尔值]');
// 云函数一律写布尔，但控制台手工改数据时可能写成 1 / 'true'。
// 用 !! 之后与 initUserState 里 canPost / mutePost 的写法口径一致。
check('enable = 1 → 放行', g.auditOpen(false, 1, false), true);
check("enable = 'true' → 放行（非空字符串即真，与 !! 口径一致）",
  g.auditOpen(false, 'true', false), true);
check('enable = 0 → 受限', g.auditOpen(false, 0, false), false);
check("enable = '' → 受限", g.auditOpen(false, '', false), false);
check('enable = null → 受限', g.auditOpen(false, null, false), false);
check('isAdministrator = 1（名册字段手改成数字）→ 放行',
  g.auditOpen(false, false, 1), true);
check('isAdministrator = 0 + enable = 0 → 受限（两个假值不叠加成真）',
  g.auditOpen(false, 0, 0), false);
check('audit = 1（控制台把开关手改成数字）→ 全局开放成立',
  g.auditOpen(1, false, false), true);

console.log('\n[缺参 / 脏参不崩]');
check('三个参数都不传 → 受限（不抛异常）', g.auditOpen(), false);
check('只传 audit → 按两个豁免都缺省处理', g.auditOpen(true), true);
check('漏传第三参（调用点还没跟上）→ 不报错，按非管理员处理',
  g.auditOpen(false, false), false);
check('传 null → 受限', g.auditOpen(null, null, null), false);
check('返回值一定是布尔量（不是 1 / undefined 之类）',
  [g.auditOpen(true, true, true), g.auditOpen(false, undefined)].map(function (v) {
    return typeof v;
  }), ['boolean', 'boolean']);

console.log('\n[反向依赖：写错运算符或漏项必须让本文件变红]');
// 这一组不是在测实现，是在**记录"错误实现会怎样"**。三条断言各自对应一种改坏的方式，
// 缺了哪一条，对应的那种改法就能悄悄通过。
// 审核开关的语义是「全局开放」和「任一豁免」三者**有一个成立即可**，不是"都要"、也不是"少一个也行"。
check('全局开放但两个豁免都没有 → 必须仍然开放（写成 && 会在这里挂）',
  g.auditOpen(true, false, false), true);
check('本人已激活但全局是审核模式 → 必须放行（漏掉 enable 项会在这里挂）',
  g.auditOpen(false, true, false), true);
check('管理员但没注册过且全局是审核模式 → 必须放行（漏掉 isAdministrator 项会在这里挂）',
  g.auditOpen(false, false, true), true);

console.log('\n[myPageOpen：「我的」页 —— 只要注册过就放行]');
// 参数顺序：myPageOpen(globalAudit, isFeeder, isAdministrator, unlocked)
// 第 4 项只在这几张表里留空，它自己那组在下面单独测。
// 八格，同样只有一格受限。
const SELF_TABLE = [
  // [全局 audit, isFeeder, isAdministrator, 期望, 说明]
  [true, true, true, true, '全局开放 + 全豁免 → 开放'],
  [true, false, false, true, '全局开放 + 未注册 → **仍然开放**（开放期游客能看到注册按钮）'],
  [true, undefined, undefined, true, '全局开放 + 什么都没有 → 仍然开放'],
  [false, true, false, true, '审核模式 + **注册过（哪怕没有 enable 字段）** → 开放 ← 本页的核心'],
  [false, true, true, true, '审核模式 + 注册过 + 管理员 → 开放'],
  [false, false, true, true, '审核模式 + 没注册 + 管理员 → 开放'],
  [false, false, false, false, '审核模式 + 没注册 + 非管理员 → **受限**（游客/微信审核员，八格里唯一一格）'],
  [false, undefined, undefined, false, '审核模式 + 什么都没有 → 受限'],
];
SELF_TABLE.forEach(function (row) {
  check(row[4], g.myPageOpen(row[0], row[1], row[2]), row[3]);
});

console.log('\n[myPageOpen：注册过但没 enable 字段的回归测试]');
// 这一组是为了钉死一个已经真实发生过的 bug：
//   regist.js 的首次注册（registFeeder）**不写 enable**，改资料那条 updateFeeder
//   里的 enable 也已经被删掉 —— 也就是说**注册流程一个字段都不写**。
//   现在 enable 只有两个写入者：adminManage.applyDecision（审批通过发布权）
//   和 postApply 的 selfEnable（「关于」页连点五次）。
//   所以库里绝大多数人**都没有 enable 字段**。
//   如果「我的」页按 enable 判豁免，这批人打开本页会看到一整块空白 —— 头像、昵称、
//   「申请发小猫书」全体消失。用户就是这么报上来的。
check('审核模式 + 注册过 + 缺 enable 字段 → 必须开放（这批人是库里的大多数）',
  g.myPageOpen(false, true, false), true);
check('审核模式 + 注册过 + enable 明确为 false → 仍然开放（本页不看 enable）',
  g.myPageOpen(false, true, false), true);
check('审核模式 + 从没注册过 → 受限（游客连「注册用户资料」按钮都看不到）',
  g.myPageOpen(false, false, false), false);

console.log('\n[myPageOpen 第 4 项：未注册者在「关于」页连点五次 → 临时开放注册入口]');
// 需求方原话：「连点五次是在用户已经注册的情况下才可以使用，否则连点五次是
//   暂时授权开放注册页面」。所以第 4 项只对"没注册的人"有意义。
const UNLOCK_TABLE = [
  // [全局audit, isFeeder, isAdministrator, unlocked, 期望, 说明]
  [false, false, false, true, true, '审核模式 + 没注册 + 点了五次 → **开放** ← 这一项存在的全部理由'],
  [false, false, false, false, false, '审核模式 + 没注册 + 没点 → 受限（原样，没被放宽）'],
  [false, false, false, undefined, false, '第 4 项缺省（老调用点只传三个参数）→ 与从前完全一致'],
  [true, false, false, false, true, '全局开放 + 没注册 → 照样开放（与第 4 项无关）'],
  [false, true, false, false, true, '已注册 → 本来就开放，用不着第 4 项'],
  [false, false, true, false, true, '管理员 → 本来就开放，用不着第 4 项'],
];
UNLOCK_TABLE.forEach(function (row) {
  check(row[5], g.myPageOpen(row[0], row[1], row[2], row[3]), row[4]);
});

console.log('\n[临时注册入口**绝不能**漏进公共内容 —— 这是它最危险的写法]');
// 【这组是本文件的第二道保险】第 4 项一旦被加进 auditOpen（或者被判成"该加到两边"），
//   未注册的人连点五次就能看见**全部瀑布流和评论区** —— 那不是"开放注册"，
//   是把审核模式整个关掉。两组断言从两个方向堵：auditOpen 不收这个参数，
//   而它也不该因为多传一个参数就放行。
check('auditOpen 根本不收第 4 个参数：未注册者连点五次后，公共内容**依然挡住**',
  g.auditOpen(false, false, false, true), false);
check('  同一个用户：公共内容挡住、本人的页面放行（两个判断式的分工没有被搅乱）',
  [g.auditOpen(false, false, false, true), g.myPageOpen(false, false, false, true)], [false, true]);
check('  连点五次**不会**让未注册者拿到 enable 的效果（enable 仍要云函数写）',
  g.auditOpen(false, false, false), false);

console.log('\n[两个判断式必须**不同** —— 谁把它们合并成一个，这里就变红]');
// 这是本文件最重要的一组断言。两个函数只差一个词（enable / isFeeder），
// 但那个词决定了"谁能看见社区内容"。合并的后果：
//   · 合并成 myPageOpen（用 isFeeder）→ 游客/微信审核员在审核模式下也能看见全部内容，
//     审核模式**唯一的作用**当场失效；
//   · 合并成 auditOpen（用 enable）→ 已注册的人看不到自己的资料和申请入口（就是这次的 bug）。
check('审核模式 + 注册过 + 没有 enable：公共内容**挡住**，本人的页面**放行**',
  [g.auditOpen(false, undefined, false), g.myPageOpen(false, true, false)], [false, true]);
check('审核模式 + 没注册：两边都必须挡住（这是审核模式唯一要挡的人）',
  [g.auditOpen(false, false, false), g.myPageOpen(false, false, false)], [false, false]);
check('全局开放：两边都必须放行（对所有人开放，与注册无关）',
  [g.auditOpen(true, false, false), g.myPageOpen(true, false, false)], [true, true]);

console.log('\n[myPageOpen：缺参 / 脏参不崩]');
check('三个参数都不传 → 受限（不抛异常）', g.myPageOpen(), false);
check('只传 audit → 按三个豁免都缺省处理', g.myPageOpen(true), true);
check('传 null → 受限', g.myPageOpen(null, null, null), false);
check('第 4 项传脏值（字符串 "true" / 1）→ 归一成布尔量',
  [typeof g.myPageOpen(false, false, false, 'true'), typeof g.myPageOpen(false, false, false, 1)],
  ['boolean', 'boolean']);
check('返回值一定是布尔量',
  typeof g.myPageOpen(false, true, false), 'boolean');

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
