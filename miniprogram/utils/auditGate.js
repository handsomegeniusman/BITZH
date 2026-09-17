/**
 * utils/auditGate.js —— 「审核模式对这个用户生效吗」的**唯一**判断式（纯函数）
 * ============================================================
 * 本文件有**两个**判断式，管的是两片不同的东西。别把它们合并成一个：
 *
 *   auditOpen()  —— **公共内容**（首页瀑布流、评论区、底部加号）
 *   myPageOpen() —— **本人的数据**（「我的」页：头像、昵称、发布权申请区；**注册页整页**）
 *
 * 两者的差别只有一个词，但那一个词是承重的：公共内容看 `Feeder.enable`，
 * 本人的数据看「**有没有 Feeder 记录**」。理由见各自函数上方的注释。
 * ============================================================
 * 【五个开关来自五个不同的地方，别混】
 *   Administrator.audit  —— 全局总开关。true = 开放，false = **审核模式**。
 *                           由管理员在「管理员」页的审核开关切换（Administrator.js）。
 *   Feeder.enable        —— 用户字段。true = 这个人是已注册**激活**的用户。
 *                           ⚠️ **它不由注册写入**：regist.js 的 insertData 里没有它，
 *                           改资料那条 updateFeeder 里也**刻意删掉了**。
 *                           只有两个写入者：adminManage.applyDecision（审批通过发布权）
 *                           和 postApply 的 selfEnable（「关于」页连点五次自助开通）。
 *                           所以**库里绝大多数记录没有这个字段** —— 这是它的常态，不是脏数据。
 *   Feeder 记录是否存在  —— 即 isFeeder。只用来判「我的」页与注册页（见 myPageOpen）。
 *   BITZHAdministrator   —— 管理员名册。在册的人两处都豁免
 *                           （防的是"管理员自己被自己开的开关挡住"）。
 *   state.registUnlocked —— 未注册者在「关于」页连点五次，临时开放注册入口。
 *                           **内存态**，关掉小程序即失效（见 db.unlockRegist）。
 *                           只进 myPageOpen，**绝不进 auditOpen**。
 *
 * 【口径】审核模式下，**公共内容**只挡三种人：
 *   ① 没注册的（Feeder 里没有这条记录）—— 典型是游客和**微信审核员**；
 *   ② 注册了但文档里没有 enable 字段的（这是**绝大多数**，见上面 enable 的说明）；
 *   ③ enable 明确为 false 的（且**不在**管理员名册里）。
 *   也就是说：管理员 或 enable=true 的人，效果均等同于"审核模式已关闭"。
 *
 * 【为什么单独抽一个文件】和 publishGate.js 同一个理由：这条判断式决定 6 个入口的显隐
 *   （index 的瀑布流与数据加载、bookletDetail 的评论区、mydetail 的注册/申请区、
 *   regist 页、底部加号），而**它错了在注册用户自己的手机上完全看不出来** ——
 *   豁免生效时一切正常，只有未注册的游客/审核员那边才露出差别，而那恰恰是开发时
 *   最不会去用的身份（实测时永远是自己的号，而且是管理员）。
 *   做成纯函数后 tests/auditGate.test.js 能把每种组合逐一钉死。
 * 【为什么不能放在 db.js 里】db.js 依赖 wx（getApp / 云函数），node 里 require 不了，
 *   那样就只能靠人工点。本仓已有同样的先例：utils/publishGate.js、utils/catForm.js。
 * 【为什么是独立入参，而不是像 publishGate 那样收一个 state 对象】
 *   这几个值来自**不同的集合**（Administrator 全局一条 / Feeder 本人一条 /
 *   BITZHAdministrator 名册一条），合成一个对象会让人以为它们同源、同一次查询返回
 *   —— 那正是"判断式漂移"的温床。分开传，调用点必须显式写出来源。
 *   （顺带一个事实：每个函数内部各项都是 `||` 相连，所以**换参数顺序不改变结果**。
 *     能弄坏判断式的只有改运算符或漏掉一项，不是排顺序。）
 * 【管理员为什么也要豁免】不豁免的话，管理员一旦没有 Feeder 记录（只被加进
 *   BITZHAdministrator 名册是合法状态，README 那条 JSON 就是这么建的），
 *   他在审核模式下就看不到任何内容 —— 而"审一下审核模式下究竟长什么样"恰恰是
 *   他唯一能做的验证手段。（**不算锁死**：后台入口在 about 页，只判断
 *   isAdministrator、与 audit 无关，所以他还关得掉开关。但同一个人的 `canPublish()`
 *   认管理员身份、加号照常出现，于是正好凑成"加号在、内容却看不见"那种自相矛盾。）
 */

/**
 * **公共内容**对当前这个用户是否开放（首页瀑布流 / 评论区 / 底部加号 / 注册页）。
 *
 * @param {Boolean} globalAudit     Administrator.audit —— true = 全局开放，false = 审核模式
 * @param {Boolean} enable          Feeder.enable       —— true = 已注册**激活**，豁免审核模式
 * @param {Boolean} isAdministrator 是否在 BITZHAdministrator 名册里 —— 同样豁免审核模式
 * @returns {Boolean} true = 照常显示内容 / 功能
 */
function auditOpen(globalAudit, enable, isAdministrator) {
  // 【顺序是有意的】全局开放是**短路**的：总开关一开，所有人（含未注册的游客）都放行，
  //   此时根本不看后两项。后两项只在"全局处于审核模式"时才有意义。
  //   把 globalAudit 挪到后面，结果完全一样，但读起来像"豁免优先"，
  //   会掩盖"开放期对所有人开放"这个事实，所以不这么写。
  //
  // ⚠️ 谁要改这个判断式，先跑 tests/auditGate.test.js。四个最容易写错的地方：
  //   ① 写成 `globalAudit && enable` —— 那"全局开放"也得有 enable 才放行，
  //      未注册的游客在开放期反而看不见任何内容（上线后第一个被投诉的就是它）。
  //   ② 在这里把 enable 换成 isFeeder —— **这条最容易搞混，因为隔壁 myPageOpen 正是这么写的**。
  //      公共内容不行：审核模式要挡的就是"没在本机注册过的人"（游客/微信审核员），
  //      而 isFeeder 一旦为真就放行，等于把审核模式的遮挡整个漏掉。
  //      要用 isFeeder 的是「我的」页，那是另一件事（只显示本人的数据）。
  //   ③ 忘了 !! 归一 —— 控制台手工改数据时可能写成 1 / 'true'，
  //      用 !! 之后才和云函数写的布尔值口径一致（同 initUserState 里 canPost/mutePost 的写法）。
  //   ④ 漏掉 isAdministrator 那一项 —— 管理员会被自己的开关挡住。这一项在
  //      "管理员本人就是开发者本人"的场景下**永远测不出来**（他通常也有 enable=true 兜着），
  //      只有在"只加了名册、没注册过"的管理员账号上才现形。
  return !!globalAudit || !!enable || !!isAdministrator;
}

/**
 * **本人的数据**对当前用户是否开放 —— 「我的」页（头像 / 昵称 / 发布权申请区）
 * 与**注册页整页**。这两处共用一条判断式是刻意的：注册按钮长在「我的」页里，
 * 点它就去注册页 —— 两处用不同的口径必然出现"按钮看得见、点进去是白页"。
 *
 * @param {Boolean} globalAudit     Administrator.audit —— true = 全局开放，false = 审核模式
 * @param {Boolean} isFeeder        有没有 Feeder 记录（不要求 enable）—— 注册过就豁免
 * @param {Boolean} isAdministrator 是否在 BITZHAdministrator 名册里
 * @param {Boolean} unlocked        「关于」页连点五次临时开放注册入口（内存态，见 db.unlockRegist）
 * @returns {Boolean} true = 照常显示
 */
function myPageOpen(globalAudit, isFeeder, isAdministrator, unlocked) {
  // 【为什么这里用 isFeeder 而公共内容用 enable —— 这是本文件唯一容易搞反的地方】
  //   「我的」页显示的全是**本人的数据**：自己的头像昵称、自己的历史、自己的回收站。
  //   审核模式要防的是"微信审核员看见社区内容"，而一个人自己的资料页里没有任何
  //   社区内容可看 —— 挡住它对审核毫无帮助，只会让**已经注册的人连自己的资料都进不去**，
  //   连"申请发小猫书"这个入口也一起消失。
  //   注册这件事本身就发生在审核模式之外（审核模式期间注册页对未注册者不可见），
  //   所以"有 Feeder 记录"就足以说明这人是自己人。
  //
  //   ⚠️ 但是**绝不能**把这个理由推广到 auditOpen：游客和微信审核员恰恰就是
  //   "没有 Feeder 记录"的那批人，公共内容必须继续用 enable 挡。（两者的区别见文件头。）
  //
  //   用户口径原话：「只要注册了，在我的页面里相当于关闭审核模式」。
  //
  // 【unlocked（第 4 项）为什么只加在这里、绝不加到 auditOpen】
  //   它开的是**注册入口**：让没注册的人有机会注册进来。而审核模式要挡的恰恰是
  //   "没注册的人看见社区内容"。要是把它加到 auditOpen，未注册的人连点五次就能看见
  //   全部瀑布流和评论区 —— 那不是"开放注册"，是"把审核模式整个关掉"，两回事。
  //   需求方原话：「连点五次是在用户已经注册的情况下才可以使用，否则连点五次是
  //   暂时授权开放注册页面」—— 已注册走 enable（云函数 + 飞书通知），未注册走这一项。
  // 【为什么它是内存态而不是写库】未注册的人**没有 Feeder 文档可写** —— 那正是
  //   "未注册"的定义。所以这件事没有服务端可言，只能是一次本机会话内的许可。
  return !!globalAudit || !!isFeeder || !!isAdministrator || !!unlocked;
}

module.exports = { auditOpen: auditOpen, myPageOpen: myPageOpen };
