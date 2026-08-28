'use strict';
/**
 * moderate 动作路由测试：每个命令幂等直接执行，无论目标当前状态，均返回对应 action（回执统一成功文案）。
 * 用 mock 数据库（collection().find 返回 { result:[...] }），不依赖真实 EMAS。
 */
const mod = require('../cloudfunctions/moderate/index.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      got : ' + g + '\n      want: ' + w); }
}

function mockDb(spec) {
  const colls = {};
  Object.keys(spec || {}).forEach(function (k) { colls[k] = spec[k]; });
  return {
    collection: function (name) {
      return colls[name] || { find: async function () { return { result: [] }; } };
    },
  };
}
function findResult(arr) {
  return async function () { return { result: arr }; };
}
function updateResult(n) {
  return async function () { return { modifiedCount: n }; };
}
function updateOne() {
  return async function () { return {}; };
}

(async function () {
  console.log('[用户命令]');
  // 封禁用户：已封禁也要直接执行（幂等），回执「已封禁」
  let ctx = { args: { action: 'ban', userId: 'u1' }, mpserverless: { db: mockDb({
    BlackNum: { find: findResult([{ _id: 'r1', id: 'u1' }]), insertOne: async function () { return {}; } },
    Page: { find: findResult([]), updateMany: updateResult(0) },
    Comment: { find: findResult([]), updateMany: updateResult(0) },
  }) } };
  let r = await mod(ctx);
  check('封禁用户（已封禁）→ 直接执行 ban', { ok: r.ok, action: r.action }, { ok: true, action: 'ban' });

  // 解封用户：未封禁也直接执行（幂等），回执「已解除黑名单」
  ctx = { args: { action: 'unblacklist', userId: 'u1' }, mpserverless: { db: mockDb({
    BlackNum: { find: findResult([]), deleteOne: async function () { return {}; } },
  }) } };
  r = await mod(ctx);
  check('解封用户（未封禁）→ 直接执行 unblacklist', { ok: r.ok, action: r.action }, { ok: true, action: 'unblacklist' });

  // 全部解封：未封禁也直接执行（幂等），回执「已解封」
  ctx = { args: { action: 'unban', userId: 'u1' }, mpserverless: { db: mockDb({
    BlackNum: { find: findResult([]), deleteOne: async function () { return {}; } },
    Page: { find: findResult([]), updateMany: updateResult(0) },
    Comment: { find: findResult([]), updateMany: updateResult(0) },
  }) } };
  r = await mod(ctx);
  check('全部解封（未封禁）→ 直接执行 unban', { ok: r.ok, action: r.action }, { ok: true, action: 'unban' });

  // 拉黑用户：已永久也直接执行（幂等），回执「已永久拉黑」
  ctx = { args: { action: 'reject', userId: 'u1' }, mpserverless: { db: mockDb({
    BlackNum: {
      find: findResult([{ _id: 'r1', id: 'u1', permanent: true }]),
      insertOne: async function () { return {}; },
      updateMany: updateResult(1),
    },
    Page: { find: findResult([]), updateMany: updateResult(0) },
    Comment: { find: findResult([]), updateMany: updateResult(0) },
  }) } };
  r = await mod(ctx);
  check('拉黑用户（已永久）→ 直接执行 reject', { ok: r.ok, action: r.action }, { ok: true, action: 'reject' });

  console.log('[帖子命令]');
  // 封禁帖子：已隐藏也直接执行（幂等），回执「已封禁该帖子」
  ctx = { args: { action: 'hide', targetType: 'page', targetId: 'p1' }, mpserverless: { db: mockDb({
    Page: { find: findResult([{ _id: 'p1', hidden: true }]), updateOne: updateOne() },
  }) } };
  r = await mod(ctx);
  check('封禁帖子（已隐藏）→ 直接执行 hide', { ok: r.ok, action: r.action }, { ok: true, action: 'hide' });

  // 解封帖子：未隐藏也直接执行（幂等），回执「已解封该帖子」
  ctx = { args: { action: 'restore', targetType: 'page', targetId: 'p1' }, mpserverless: { db: mockDb({
    Page: { find: findResult([{ _id: 'p1' }]), updateOne: updateOne() },
  }) } };
  r = await mod(ctx);
  check('解封帖子（未隐藏）→ 直接执行 restore', { ok: r.ok, action: r.action }, { ok: true, action: 'restore' });

  // 未知 action → 报错
  ctx = { args: { action: 'xxxxx' }, mpserverless: { db: mockDb({}) } };
  r = await mod(ctx);
  check('未知 action → ok:false', { ok: r.ok }, { ok: false });

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常', e);
  process.exit(1);
});
