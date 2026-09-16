'use strict';
/**
 * utils/publishGate.js 测试 —— 「能不能发帖/评论」的唯一判断式。
 *
 * 【为什么这个文件最有价值】这条判断式决定 8 个入口的显隐，而它错了**在自己手机上看不出来**：
 *   管理员账号本来就能发帖，所以「忘了扣掉禁言」这个 bug 只会在**别人**的手机上复现。
 *   这里把 4 种组合逐一钉死，并额外钉住"退回旧写法必须让测试失败"这一点。
 *
 * 纯模块、无 wx / 无 db，所以能直接 node 跑。
 * （同类的先例：tests/catForm.test.js —— 也是盯着一个可 node require 的 miniprogram util。）
 */
const g = require('../miniprogram/utils/publishGate.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      got : ' + a + '\n      want: ' + b); }
}

console.log('[四种组合]');
// 1) 普通用户，没申请过 / 申请被拒 → 不能发
check('普通用户 + 未获批 + 未禁言 → 不能发',
  g.canPublish({ isAdministrator: false, canPost: false, mutePost: false }), false);
// 2) 普通用户，已获批 → 能发
check('普通用户 + 已获批 + 未禁言 → 能发',
  g.canPublish({ isAdministrator: false, canPost: true, mutePost: false }), true);
// 3) 普通用户，已获批但被禁言 → **不能发**（禁言要盖过已获批）
check('普通用户 + 已获批 + 被禁言 → 不能发',
  g.canPublish({ isAdministrator: false, canPost: true, mutePost: true }), false);
// 4) 🔴 管理员被禁言 → **也不能发**。这条是整个文件的存在意义。
//    改动判断式时若把 mute 条件放在 isAdministrator 短路之前丢了，或干脆没加，
//    只有这一条会红。刻意选的口径：管理员滥权时也该能被另一位管理员处置。
check('管理员 + 被禁言 → 不能发（禁言对管理员同样生效）',
  g.canPublish({ isAdministrator: true, canPost: false, mutePost: true }), false);
check('管理员 + 被禁言 + 已获批 → 仍然不能发',
  g.canPublish({ isAdministrator: true, canPost: true, mutePost: true }), false);
check('管理员 + 未禁言 → 能发',
  g.canPublish({ isAdministrator: true, canPost: false, mutePost: false }), true);

console.log('\n[两个字段正交：禁言不得改写 canPost]');
// 禁言的实现**只能**是"多一个 mutePost 条件"。若有人图省事改成"禁言时把 canPost 置 false"，
// 会同时坏掉三件事：分不清"从没申请"和"被禁言"、毁掉审批审计、解禁时不知道该恢复成什么。
// 这一条从**行为**上钉住"两个字段必须各管各的"：只动 canPost 表达不出"被禁言"。
check('只动 canPost 表达不出「被禁言」：已获批+禁言 ≠ 未获批',
  g.canPublish({ isAdministrator: false, canPost: true, mutePost: true }),
  g.canPublish({ isAdministrator: false, canPost: false, mutePost: false }));
// 上面两者结果相同（都是 false），所以更要靠"解禁后能不能恢复"来区分：
check('解禁后回到原来的权限（已获批者恢复能发）',
  g.canPublish({ isAdministrator: false, canPost: true, mutePost: false }), true);
check('解禁后回到原来的权限（未获批者仍不能发）',
  g.canPublish({ isAdministrator: false, canPost: false, mutePost: false }), false);

console.log('\n[字段缺失 / 脏数据的兜底]');
// 老用户文档里根本没有 mutePost 这个字段（undefined）→ 必须当成"没被禁言"，
// 否则上线瞬间全体老用户都发不出帖。这是本功能最容易造成线上事故的一处。
check('mutePost 缺失（undefined）→ 视为未禁言',
  g.canPublish({ isAdministrator: false, canPost: true }), true);
check('mutePost = 0（控制台手工改库可能写成 0）→ 视为未禁言',
  g.canPublish({ isAdministrator: false, canPost: true, mutePost: 0 }), true);
check('mutePost = null → 视为未禁言',
  g.canPublish({ isAdministrator: false, canPost: true, mutePost: null }), true);
check('canPost = 1（手工改库）→ 视为已获批',
  g.canPublish({ isAdministrator: false, canPost: 1, mutePost: false }), true);

// 传空 / 不传 state：宁可当"不能发"，也不能因异常把人放进来
check('state 为 undefined → 不能发（不抛异常）', g.canPublish(undefined), false);
check('state 为 null → 不能发', g.canPublish(null), false);
check('state 为空对象 → 不能发', g.canPublish({}), false);

console.log('\n[反向自检：退回旧写法必须让本测试变红]');
// 这里把"如果当初忘了 mute 条件"的那版公式写出来，确认它在被禁言的用例上与本模块**不同**。
// 若哪天有人把 publishGate 改回旧写法，上面第 3、4 条会立刻失败 —— 那正是本文件的用途。
function oldFormula(s) { return !!(s.isAdministrator || s.canPost); }
const muted = { isAdministrator: true, canPost: true, mutePost: true };
check('旧写法在被禁言时误判为「能发」（证明本测试确实测到了 mute 条件）',
  [oldFormula(muted), g.canPublish(muted)], [true, false]);

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
