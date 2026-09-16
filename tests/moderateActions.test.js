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
      return colls[name] || {
        find: async function () { return { result: [] }; },
        updateMany: updateResult(0),
      };
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

  // 联动清待办（2026-08-28）：封禁用户后，该用户相关的待复核/举报/申诉应被标记为已处理，
  // 让复核中心不再残留已被管理员处理过的旧待办。
  console.log('[联动清待办]');
  const cascadeCalls = [];
  const spyDb = {
    collection: function (name) {
      return {
        find: async function () { return { result: [] }; },
        insertOne: async function () { return {}; },
        deleteOne: async function () { return {}; },
        updateMany: async function (filter) {
          cascadeCalls.push({ name: name, filter: filter });
          return { modifiedCount: 1 };
        },
      };
    },
  };
  r = await mod({ args: { action: 'ban', userId: 'u9' }, mpserverless: { db: spyDb } });
  const markTargets = cascadeCalls.filter(function (c) {
    return ['Review', 'Report', 'Appeal'].indexOf(c.name) >= 0;
  });
  const firstFilter = function (name) {
    return JSON.stringify(markTargets.filter(function (c) { return c.name === name; })[0].filter);
  };
  check('联动: 待复核/举报/申诉共 4 处被联动标记', markTargets.length, 4);
  check('联动: 待复核按 authorId + type=review',
    firstFilter('Review'), JSON.stringify({ status: 'pending', authorId: 'u9', type: 'review' }));
  check('联动: 举报按 targetAuthorId（被举报人是该用户）',
    firstFilter('Report'), JSON.stringify({ status: 'pending', targetAuthorId: 'u9' }));
  check('联动: 举报按 reporterId（该用户发起的举报）',
    JSON.stringify(markTargets.filter(function (c) { return c.name === 'Report'; })[1].filter),
    JSON.stringify({ status: 'pending', reporterId: 'u9' }));
  check('联动: 申诉按 userId',
    firstFilter('Appeal'), JSON.stringify({ status: 'pending', userId: 'u9' }));

  // ---- 禁言 / 解除禁言（2026-09-16）----
  // 【为什么这块测得比别人细】禁言是"从 ban 抄一行就会写错"的功能：ban 会软删全部内容，
  // 而禁言**必须**保留内容。抄错的后果是静的 —— 界面照常、操作照常成功，
  // 只是被禁言者的历史推文/评论在某次操作后集体消失。所以这里逐条数写调用次数。
  console.log('\n[禁言 / 解除禁言]');

  /** 记录每一次读写（含集合名、操作类型、过滤器、update 体），用于断言"写了什么"和"没写什么" */
  function recDb() {
    const calls = [];
    return {
      calls: calls,
      /** 某集合上的**写**调用（find 不算） */
      writes: function (name) {
        return calls.filter(function (c) { return c.name === name && c.op !== 'find'; });
      },
      allWrites: function () {
        return calls.filter(function (c) { return c.op !== 'find'; });
      },
      collection: function (name) {
        return {
          find: async function (q) { calls.push({ name: name, op: 'find', filter: q }); return { result: [] }; },
          updateMany: async function (f, u) { calls.push({ name: name, op: 'updateMany', filter: f, update: u }); return { modifiedCount: 1 }; },
          updateOne: async function (f, u) { calls.push({ name: name, op: 'updateOne', filter: f, update: u }); return {}; },
          insertOne: async function (d) { calls.push({ name: name, op: 'insertOne', doc: d }); return {}; },
          deleteOne: async function (f) { calls.push({ name: name, op: 'deleteOne', filter: f }); return {}; },
        };
      },
    };
  }
  /** 模拟"服务端能确认身份"：getInfo 返回指定 userId */
  function asUser(id) {
    return { user: { getInfo: async function () { return { result: { user: { userId: id } } }; } } };
  }

  let db = recDb();
  r = await mod({ args: { action: 'mute', userId: 'u1', reason: '刷屏' }, mpserverless: { db: db } });
  check('禁言 → 直接执行 mute', { ok: r.ok, action: r.action, userId: r.userId },
    { ok: true, action: 'mute', userId: 'u1' });

  const fw = db.writes('Feeder');
  check('禁言只写 Feeder 一处', fw.length, 1);
  check('写 mutePost=true 并带上原因',
    { post: fw[0].update.$set.mutePost, reason: fw[0].update.$set.muteReason },
    { post: true, reason: '刷屏' });
  check('用 updateMany（同一 userId 有重复 Feeder 文档时也要全覆盖）', fw[0].op, 'updateMany');
  check('按 userId 定位', JSON.stringify(fw[0].filter), JSON.stringify({ userId: 'u1' }));

  // 🔴 本功能唯一容易写错的地方：禁言 ≠ 拉黑。
  //    "从 ban 复制一行过来"就会把人的历史内容软删掉 —— 而用户明确要求保留不动。
  check('禁言不碰 Page（既有推文保留）', db.writes('Page').length, 0);
  check('禁言不碰 Comment（既有评论保留）', db.writes('Comment').length, 0);
  check('禁言不写黑名单（与拉黑正交，可以只禁言不拉黑）', db.writes('BlackNum').length, 0);
  check('禁言不联动清待办（待办讲的是内容，内容没动）',
    db.writes('Review').length + db.writes('Report').length + db.writes('Appeal').length, 0);

  db = recDb();
  r = await mod({ args: { action: 'unmute', userId: 'u1' }, mpserverless: { db: db } });
  check('解除禁言 → 直接执行 unmute', { ok: r.ok, action: r.action, userId: r.userId },
    { ok: true, action: 'unmute', userId: 'u1' });
  const uw = db.writes('Feeder');
  check('解除禁言只写 Feeder 一处', uw.length, 1);
  check('写入 mutePost=false', uw[0].update.$set.mutePost, false);
  // 【为什么这条最重要】解禁**不许**顺手把 canPost 打开 —— 那等于绕过审批授予发布权。
  check('解除禁言不写 canPost（不授予任何发布权）', uw[0].update.$set.canPost, undefined);
  check('解除禁言保留 muteTime/muteBy 审计（不 $unset）',
    [uw[0].update.$unset, uw[0].update.$set.muteTime === undefined ? '未出现' : '被覆盖'],
    [undefined, '未出现']);
  check('解除禁言不碰内容/黑名单',
    [db.writes('Page').length, db.writes('Comment').length, db.writes('BlackNum').length], [0, 0, 0]);

  // 少参数：不写库、给出原因
  db = recDb();
  r = await mod({ args: { action: 'mute' }, mpserverless: { db: db } });
  check('缺 userId → ok:false 且零写入', { ok: r.ok, wrote: db.allWrites().length }, { ok: false, wrote: 0 });

  console.log('\n[禁言：不许禁言自己]');
  // 【这道守卫防的是手滑，不是越权】管理员在自己那一行点「禁言」→ 只能找另一位管理员解除。
  db = recDb();
  r = await mod({ args: { action: 'mute', userId: 'me1' }, mpserverless: { db: db, ...asUser('me1') } });
  check('禁言自己 → SELF_MUTE', { ok: r.ok, code: r.code }, { ok: false, code: 'SELF_MUTE' });
  check('禁言自己 → 零写入', db.allWrites().length, 0);

  r = await mod({ args: { action: 'mute', userId: 'me1', callerId: 'me1' }, mpserverless: { db: recDb() } });
  check('getInfo 不可用时退回自报 callerId，仍拦得住', r.code, 'SELF_MUTE');

  // 身份取不到时**放行** —— 守卫不能把禁言功能整体锁死（能调本函数的人本来就能禁言任何人）
  db = recDb();
  r = await mod({ args: { action: 'mute', userId: 'u1' }, mpserverless: { db: db } });
  check('身份完全取不到时放行（守卫不锁死功能）', r.ok, true);
  check('放行时确实写了库', db.writes('Feeder').length, 1);

  db = recDb();
  r = await mod({ args: { action: 'mute', userId: 'u1' }, mpserverless: { db: db, user: { getInfo: async function () { throw new Error('mock getInfo 挂了'); } } } });
  check('getInfo 抛错不影响禁言本身', r.ok, true);

  r = await mod({ args: { action: 'mute', userId: 'other9' }, mpserverless: { db: recDb(), ...asUser('me1') } });
  check('禁言别人不受守卫影响', r.ok, true);

  db = recDb();
  await mod({ args: { action: 'mute', userId: 'u1' }, mpserverless: { db: db, ...asUser('adm1') } });
  check('muteBy 记下服务端确认的操作人', db.writes('Feeder')[0].update.$set.muteBy, 'adm1');

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常', e);
  process.exit(1);
});
