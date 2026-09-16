'use strict';
/**
 * tests/backfillCanPost.test.js —— 一次性回填「老用户发布权限」云函数测试
 * ============================================================
 * 零框架，与 tests/adminManage.test.js 同一套写法（check + 退出码 + mockDb）。
 *
 * 【为什么这个函数值得单独测】它是一次性、不可逆、**批量给别人开权限**的操作：
 *   - 跑错一次，要么把权限开给了不该开的人（官方帖挂着的脏 authorId、黑名单用户），
 *     要么把该开的人漏掉（老数据把 Feeder._id 存进了 authorId），
 *     而这两种错误在几百条的报告里很难用眼睛看出来。
 *   - 它有 dryRun，但那不是测试的替代品 —— dryRun 只保证"这次没写"，不保证"算对了"。
 * 所以这里把每一条判定口径都钉成一个用例，并且同时断言**调用次数**与**过滤器形状**。
 * ============================================================
 */
const mod = require('../cloudfunctions/backfillCanPost/index.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      got : ' + g + '\n      want: ' + w); }
}

// ---------- mock 数据库 ----------
/** 极简过滤器：支持等值、$ne、$gt、$in（本函数只用这四种） */
function match(doc, filter) {
  return Object.keys(filter || {}).every(function (k) {
    const v = filter[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$ne' in v) return doc[k] !== v.$ne;   // 字段缺失（undefined）也算"不等于"
      if ('$gt' in v) return doc[k] > v.$gt;
      if ('$in' in v) return v.$in.indexOf(doc[k]) >= 0;
      return false;
    }
    return doc[k] === v;
  });
}

function makeDb(data) {
  const calls = [];
  return {
    calls: calls,
    data: data,
    of: function (name, m) {
      return calls.filter(function (c) { return c.name === name && c.m === m; });
    },
    collection: function (name) {
      return {
        // walk() 用 _id 游标分页（q._id = {$gt: lastId}）并按 _id 升序取 —— 桩必须真的
        // 实现排序，否则"第二批"永远拿到同一批，会假报死循环或漏扫。
        find: async function (f, o) {
          calls.push({ name: name, m: 'find', filter: f, options: o });
          let arr = (data[name] || []).filter(function (d) { return match(d, f || {}); });
          if (o && o.sort && o.sort._id) {
            arr = arr.slice().sort(function (a, b) {
              if (a._id === b._id) return 0;
              return a._id < b._id ? -1 : 1;
            });
          }
          if (o && o.limit) arr = arr.slice(0, o.limit);
          return { result: arr };
        },
        // 真落盘：这条用例要验证"同一个 userId 的多份文档被一次 updateMany 全部覆盖"，
        // 只记调用不写库的话，那个断言是空的。
        updateMany: async function (f, u) {
          calls.push({ name: name, m: 'updateMany', filter: f, update: u });
          (data[name] || []).forEach(function (d) {
            if (match(d, f || {})) Object.assign(d, u.$set || {});
          });
          return {};
        },
        updateOne: async function (f, u) {
          calls.push({ name: name, m: 'updateOne', filter: f, update: u });
          const d = (data[name] || []).filter(function (x) { return match(x, f || {}); })[0];
          if (d) Object.assign(d, u.$set || {});
          return {};
        },
      };
    },
  };
}

function run(db, args) {
  return mod({ args: args || {}, mpserverless: { db: db } });
}

/** 取 report.items 里某个 authorId 的判定结果（报告本身太长，直接看关键字段） */
function actionOf(report, authorId) {
  const it = (report.items || []).filter(function (i) { return i.authorId === authorId; })[0];
  return it ? it.action : '(不在 items 里)';
}

/** 一份含各种边界情况的标准数据 */
function baseData(extra) {
  return Object.assign({
    Page: [
      { _id: 'p1', authorId: 'userA', tittle: '甲的第一篇' },
      { _id: 'p2', authorId: 'userA', tittle: '甲的第二篇' },
      { _id: 'p3', authorId: 'userB', tittle: '乙的帖（老数据：authorId 存的是 Feeder._id）' },
      { _id: 'p4', authorId: 'userC', tittle: '丙已获批' },
      { _id: 'p5', authorId: 'userD', tittle: '丁在黑名单' },
      { _id: 'p6', authorId: 'userE', tittle: '戊' },
      { _id: 'p7', authorId: 'ghost', hidden: true, tittle: '已下架' },
      { _id: 'p8', authorId: 'ghost2', official: true, tittle: '官方推文' },
    ],
    Comment: [
      { _id: 'c1', authorId: 'userA', main: '甲的一条评论' },
      { _id: 'c2', authorId: 'userE', main: '戊的一条评论' },
      { _id: 'c3', authorId: 'ghost3', deleted: true, main: '已删评论' },
      { _id: 'c4', authorId: '', main: 'authorId 为空的脏数据' },
      { _id: 'c5', authorId: 'userF', main: '只评论过的人' },
    ],
    Feeder: [
      { _id: 'fA', userId: 'userA', nickName: '甲' },
      { _id: 'userB', userId: '', nickName: '乙（userId 为空的老文档）' },
      { _id: 'fC', userId: 'userC', nickName: '丙', canPost: true },
      { _id: 'fD', userId: 'userD', nickName: '丁' },
      // 同一个 userId 的重复注册文档：客户端 initUserState 读到哪一条不确定，
      // 所以标记必须一次覆盖两条
      { _id: 'fE1', userId: 'userE', nickName: '戊（文档1）' },
      { _id: 'fE2', userId: 'userE', nickName: '戊（文档2）' },
      { _id: 'fF', userId: 'userF', nickName: '己' },
    ],
    BlackNum: [{ _id: 'b1', id: 'userD', reason: '内容违规' }],
  }, extra || {});
}

(async function () {
  console.log('[安全默认值]');
  {
    const db = makeDb(baseData());
    const r = await run(db, {}); // 什么都不传
    check('不传 dryRun → 默认 true（绝不因为漏传参数就写库）', r.dryRun, true);
    check('  且一次写入都没有', { u: db.of('Feeder', 'updateMany').length, o: db.of('Feeder', 'updateOne').length }, { u: 0, o: 0 });
    check('  但给出了 wouldGrant（报告仍可用）', r.wouldGrant > 0, true);
  }

  console.log('\n[扫描口径]');
  {
    const db = makeDb(baseData());
    const r = await run(db, { dryRun: true });
    // Page：p7(hidden) 与 p8(official) 必须被排除，所以只扫到 6 条
    check('Page 过滤条件（hidden/official 都在过滤条件里，不是取回后再筛）',
      db.of('Page', 'find')[0].filter, { hidden: { $ne: true }, official: { $ne: true } });
    check('Comment 过滤条件', db.of('Comment', 'find')[0].filter, { deleted: { $ne: true } });
    check('已下架 / 官方推文不计入扫描', r.scanned.pages, 6);
    check('已删评论不计入扫描', r.scanned.comments, 4);
    check('  authorId 为空的那条被单独计数（畸形脏数据要看得见）', r.badId, 1);
    check('去重后的人数（不重复计同一个人的多条内容）',
      r.uniqueAuthors, 6); // userA userB userC userD userE userF（ghost3 已删 / ghost/ghost2 被过滤）
    check('  甲发了 2 帖 + 1 评论，只算一个人', actionOf(r, 'userA'), 'grant');
  }

  console.log('\n[判定口径]');
  {
    const db = makeDb(baseData());
    const r = await run(db, { dryRun: true });
    check('老数据：authorId 存的是 Feeder._id → 也能命中', actionOf(r, 'userB'), 'grant');
    check('  并在报告里标出是走了 _id 兜底', r.byId, 1);
    check('新数据：authorId 就是 userId → 命中 userId', r.byUserId, 5);
    check('已经有 canPost 的人不重复处理', actionOf(r, 'userC'), 'skip:already');
    check('  计入 alreadyGranted', r.alreadyGranted, 1);
    check('黑名单用户跳过', actionOf(r, 'userD'), 'skip:blacklist');
    check('  计入 skippedBlacklist', r.skippedBlacklist, 1);
    check('只评论过、没发过帖的人一起给权限（管理员确认过）', actionOf(r, 'userF'), 'grant');

    check('dryRun 下 granted 恒为 0', r.granted, 0);
    // userA userB userE userF 共 4 人该批（userC 已有、userD 拉黑）
    check('wouldGrant = 该批的人数', r.wouldGrant, 4);
    check('零写入（dryRun 的全部意义）',
      { u: db.of('Feeder', 'updateMany').length, o: db.of('Feeder', 'updateOne').length }, { u: 0, o: 0 });

    check('计数自检通过（报告本身可信）', r.inconsistent, 0);
    check('  自检的算式：uniqueAuthors = matched + unmatched + notTargeted',
      r.uniqueAuthors - (r.matched + r.unmatched + r.notTargeted), 0);
    check('  本次没有查不到 Feeder 的人', r.unmatched, 0);
  }

  console.log('\n[真正写入]');
  {
    const db = makeDb(baseData());
    const r = await run(db, { dryRun: false });
    check('granted = 实际写入人数', r.granted, 4);
    check('  dryRun 标记如实回传', r.dryRun, false);

    const um = db.of('Feeder', 'updateMany');
    const uo = db.of('Feeder', 'updateOne');
    check('updateMany 次数 = 有 userId 的授予人数（4 人 - 1 个没有 userId 的 = 3）', um.length, 3);
    check('updateOne 次数 = 1（只有 userId 为空的老文档才退回按 _id 写）', uo.length, 1);
    check('  退回的那一次按 _id 过滤', uo[0].filter, { _id: 'userB' });
    check('  按 userId 的写法：过滤条件是 userId，不是 _id', um[0].filter, { userId: 'userA' });
    check('  $set.canPost 是布尔 true', um[0].update.$set.canPost, true);
    check('  $set.canPostBy 记为 backfill（审计：这批权限是谁给的）', um[0].update.$set.canPostBy, 'backfill');
    check('  $set.canPostTime 是 Date', um[0].update.$set.canPostTime instanceof Date, true);

    check('同一个 userId 的重复文档被同一批标记全部覆盖',
      db.data.Feeder.filter(function (f) { return f.userId === 'userE' }).map(function (f) { return !!f.canPost }),
      [true, true]);
    check('  且只写了一次（不是每条文档写一次）',
      um.filter(function (c) { return c.filter.userId === 'userE' }).length, 1);
    check('已获批的丙没被改写（canPostTime 出处不能被覆盖）',
      'canPostTime' in db.data.Feeder.filter(function (f) { return f.userId === 'userC' })[0], false);
    check('黑名单的丁一个字都没写',
      'canPost' in db.data.Feeder.filter(function (f) { return f.userId === 'userD' })[0], false);
    check('已下架的帖主没被授予',
      ['ghost', 'ghost2', 'ghost3'].map(function (g) { return actionOf(r, g) }),
      ['(不在 items 里)', '(不在 items 里)', '(不在 items 里)']);
  }

  console.log('\n[分区扫描：>BATCH 时分页不漏不重]');
  {
    // BATCH = 200。造 250 条 Page（120 个不同作者），若游标写错会漏扫或死循环。
    const pages = [];
    for (let i = 0; i < 250; i++) {
      pages.push({ _id: 'pg' + String(i).padStart(4, '0'), authorId: 'au' + (i % 120), tittle: 't' + i });
    }
    const db = makeDb({ Page: pages, Comment: [], Feeder: [], BlackNum: [] });
    const r = await run(db, { dryRun: true, diag: false });
    check('两批都扫到了', r.scanned.pages, 250);
    check('去重后 120 个作者', r.uniqueAuthors, 120);
    check('全都查不到 Feeder → unmatched 120', r.unmatched, 120);
    check('  计数自检仍然通过', r.inconsistent, 0);
  }

  console.log('\n[定点重跑 onlyUsers]');
  {
    const db = makeDb(baseData());
    const r = await run(db, { dryRun: true, onlyUsers: ['userA'] });
    check('只处理目标人', actionOf(r, 'userA'), 'grant');
    check('其他人被明确标为 not-targeted', actionOf(r, 'userF'), 'skip:not-targeted');
    // 【这条是回归】漏了 notTargeted 计数时，自检会把"被排除的人"算成"分支漏计数"，
    // 于是一次完全正确的定点重跑会假报 inconsistent ≠ 0，让人以为函数坏了。
    check('  定点模式下计数自检依然通过（不假报不一致）', r.inconsistent, 0);
    check('  wouldGrant 只算目标人', r.wouldGrant, 1);
  }

  console.log('\n[异常与兜底]');
  {
    const r = await run({ args: {}, mpserverless: {} }, { dryRun: true });
    // 不抛异常、返回一个能看懂的结果 —— 控制台里点「测试」的人要能从返回值看出哪里错了
    check('无 db → ok:false 且不抛（控制台里能看到原因）',
      { ok: r.ok, msg: r.msg, dryRun: r.dryRun },
      { ok: false, msg: '无数据库访问 (ctx.mpserverless.db)', dryRun: true });
  }
  {
    // 黑名单读不出来时不阻断回填（与 adminManage 的 applyDecision 不同：那边读不到必须拒绝，
    // 这里是历史数据的一次性整理，卡住等于所有人都没权限）
    const db = makeDb(baseData());
    const orig = db.collection;
    db.collection = function (name) {
      if (name === 'BlackNum') throw new Error('mock 故障');
      return orig.call(db, name);
    };
    const r = await run(db, { dryRun: true });
    check('黑名单读取失败不阻断回填（报告仍产出）', r.ok, true);
    check('  该批的人照批（而不是全体卡住）', r.wouldGrant, 5);
  }

  console.log('\n[明细截断]');
  {
    const pages = [];
    for (let i = 0; i < 620; i++) pages.push({ _id: 'q' + String(i).padStart(4, '0'), authorId: 'z' + i });
    const db = makeDb({ Page: pages, Comment: [], Feeder: [], BlackNum: [] });
    const r = await run(db, { dryRun: true, diag: false });
    check('items 最多 500 条', r.items.length, 500);
    check('  并如实标记被截断', r.itemsTruncated, true);
    check('  但计数不截断（620 人全算）', r.uniqueAuthors, 620);
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常', e);
  process.exit(1);
});
