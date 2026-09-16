/**
 * 云函数 backfillCanPost —— 一次性回填「已发过内容的老用户」的发布权限
 * ============================================================
 * 【背景】发布权限改成"申请-审批制"后，`Feeder.canPost` 默认是空（falsy），
 *        于是所有老用户会在一夜之间失去发帖权和评论权。本函数把这些**已经在
 *        社区里产出过内容**的人批量标记为已获批，避免误伤。
 *
 * 【判定口径】（2026-09-16 与管理员确认）
 *   1. 扫 Page：    { hidden: {$ne:true}, official: {$ne:true} }  → 收 authorId
 *      · hidden:$ne true    —— 已被下架的帖子不算数（只看当前还在线的）
 *      · official:$ne true  —— 【这条是承重的】cleanDirtyData 的存在本身就证明
 *        "official:true 的帖子上可能挂着不属于本人的 authorId"，拿它当发帖证据
 *        会把发布权开给错的人。
 *   2. 扫 Comment： { deleted: {$ne:true} }                      → 收 authorId
 *      · 评论过的人一起给权限（管理员确认）
 *   3. 去重后逐个解析 Feeder（先按 userId，再按 _id —— 见 findFeeder 注释）
 *   4. 跳过黑名单用户（BlackNum）—— 他们本来就被拦着，批了也用不了
 *   5. 跳过已经有 canPost 的（不覆盖 canPostTime，保住原始授予的出处）
 *
 * 【用法】控制台「云函数 → backfillCanPost → 测试」传参：
 *   { "dryRun": true }            先出报告、不改库（默认，防误操作）
 *   { "dryRun": false }           真正写库
 *   { "dryRun": true, "onlyUsers": ["<userId>"] }   定点排查某个人为什么没被回填
 *   { "diag": false }             关掉 Feeder 样例诊断（报告更短）
 *
 * 【返回】{ ok, dryRun, scanned:{pages,comments}, uniqueAuthors, matched, byUserId, byId,
 *          alreadyGranted, granted, wouldGrant, skippedBlacklist, unmatched, badId,
 *          notTargeted, inconsistent, items:[...≤500], itemsTruncated, diag }
 *   · inconsistent —— 计数自检：matched + unmatched + notTargeted 应当等于 uniqueAuthors，
 *     不等于就说明有分支漏了计数或抛了异常，报告本身才可信。
 *
 * 【安全】dryRun 默认 true；只写 Feeder.canPost，绝不写 Page / Comment。
 * 【用完即删】确认无误后从控制台删除本函数，不留在线上（与 cleanDirtyData 同一约定）。
 * 【前端从不调用】只有控制台手工触发。
 */
'use strict';

const BATCH = 200; // 分批取数，防单次查询过大触发写限制/超时

function col(db, name) {
  if (!db || !db.collection) throw new Error('无数据库访问 (ctx.mpserverless.db)');
  return db.collection(name);
}

/** find 结果归一化成数组：兼容直接返回数组或 {result:[...]} 两种形态 */
function toList(r) {
  if (Array.isArray(r)) return r;
  return (r && r.result) || [];
}

/**
 * 按 authorId 查一条 Feeder 用户资料。
 * 【为什么要试两个字段】历史 bug 写入 Page.authorId 时来源不统一：
 *   - 新代码（已修）存的是 Feeder.userId（MPServerless 会话 openid）
 *   - 老代码可能存的是 Feeder._id（文档主键，24 位 ObjectId）
 * 所以先试 userId 精确匹配，匹配不到再试 _id，返回 { feeder, by } 说明命中字段。
 *
 * 【本函数与 cleanDirtyData/index.js 的 findFeeder 逐字相同 —— 刻意复制，别顺手重构】
 *   云函数各自独立打包，跨目录 require 在这里不可用（adminManage 里也内联了一份
 *   guard.js 的姓名清洗，同一个理由）。要改就两边一起改。
 */
async function findFeeder(db, authorId) {
  const id = String(authorId || '');
  if (!id) return { feeder: null, by: '' };
  // 1) 优先按 userId（新代码语义）
  const byUser = toList(await col(db, 'Feeder').find({ userId: id }, { limit: 1 }));
  if (byUser[0]) return { feeder: byUser[0], by: 'userId' };
  // 2) 老数据兜底：按 _id（文档主键）
  const byId = toList(await col(db, 'Feeder').find({ _id: id }, { limit: 1 }));
  if (byId[0]) return { feeder: byId[0], by: '_id' };
  return { feeder: null, by: '' };
}

/**
 * 游标式分批取数：按 _id 递增推进，O(n)。
 * 【为什么不用 skip 分页】skip 是 O(n²)；而且本函数要同时扫 Page 和 Comment，
 *   用 skip 时"改成边扫边写"会破坏分页前提。
 * 【前提】本函数绝不写 Page / Comment —— 一旦写了，游标分页的前提就没了。
 */
async function walk(db, name, filter, onDoc, counter) {
  let lastId = null;
  for (;;) {
    const q = Object.assign({}, filter);
    if (lastId !== null) q._id = { $gt: lastId };
    const list = toList(await col(db, name).find(q, { limit: BATCH, sort: { _id: 1 } }));
    if (!list.length) break;
    for (let i = 0; i < list.length; i++) {
      const d = list[i] || {};
      onDoc(d);
      if (d._id) lastId = d._id; // 取末位为下一页游标
    }
    counter.count += list.length;
    if (list.length < BATCH) break;
  }
}

module.exports = async function (ctx) {
  const event = (ctx && ctx.args) || {};
  const dryRun = event.dryRun !== false; // 默认 dry-run，安全优先
  const db = ctx && ctx.mpserverless && ctx.mpserverless.db;

  try {
    const report = {
      ok: true,
      dryRun: dryRun,
      scanned: { pages: 0, comments: 0 }, // 实际扫过的文档数
      uniqueAuthors: 0,   // 去重后的 authorId 个数
      matched: 0,         // 能解析到 Feeder 的人数
      byUserId: 0,        // 命中 Feeder.userId 的人数（新数据）
      byId: 0,            // 命中 Feeder._id 的人数（老数据，>0 说明脏格式确实存在）
      alreadyGranted: 0,  // 本来就有 canPost，跳过
      granted: 0,         // 本次真正写入的人数（dryRun 时恒为 0）
      wouldGrant: 0,      // dryRun 下"将要写入"的人数
      skippedBlacklist: 0,
      unmatched: 0,       // 查不到 Feeder（资料被删/账号注销）
      badId: 0,           // 【按文档计】authorId 为空的脏数据条数（不进自检，它没有 authorId）
      notTargeted: 0,     // 定点模式下被排除的人（计入自检，否则会假报不一致）
      inconsistent: 0,    // 计数自检，非 0 说明报告本身不可信
      items: [],          // 明细（最多列前 500 条）
      itemsTruncated: false,
      diag: null,
    };

    // ===== 1) 收集 authorId（Page + Comment）=====
    // authorId -> { pages, comments }：同一个人的多条内容只算一次
    const authors = new Map();
    const bump = function (d, field) {
      const id = String((d && d.authorId) || '').trim();
      if (!id) {
        // 内容存在但 authorId 为空 —— 畸形脏数据，报告里要看得见（否则会被
        // "总数对不上"的形式发现，而不是直接看到原因）
        report.badId++;
        return;
      }
      let rec = authors.get(id);
      if (!rec) { rec = { pages: 0, comments: 0 }; authors.set(id, rec); }
      rec[field]++;
    };
    const pc = { count: 0 }, cc = { count: 0 };
    await walk(db, 'Page', { hidden: { $ne: true }, official: { $ne: true } },
      function (d) { bump(d, 'pages'); }, pc);
    await walk(db, 'Comment', { deleted: { $ne: true } },
      function (d) { bump(d, 'comments'); }, cc);
    report.scanned.pages = pc.count;
    report.scanned.comments = cc.count;

    // ===== 2) 黑名单（一次读全量，避免逐人查库）=====
    // 俱乐部的黑名单是个小集合，全量读进内存比 N 次查询快得多。
    // 上限兜底：真长到超过 2000 条时宁可少跳几个也不能让函数超时。
    const black = new Set();
    try {
      const bans = toList(await col(db, 'BlackNum').find({}, { limit: 2000 }));
      for (let i = 0; i < bans.length; i++) {
        const id = String((bans[i] && bans[i].id) || '').trim();
        if (id) black.add(id);
      }
    } catch (e) {
      console.error('[backfillCanPost] 读取黑名单失败，将不跳过任何人', (e && e.message) || e);
    }

    // ===== 3) 诊断：Feeder 样例，帮核对 userId / _id 的真实形态 =====
    if (event.diag !== false) {
      try {
        const sample = toList(await col(db, 'Feeder').find({}, { limit: 5 }));
        report.diag = {
          sampleCount: sample.length,
          samples: sample.map(function (f) {
            return {
              _id: f && f._id,
              userId: f && f.userId,
              nickName: f && f.nickName,
              canPost: !!(f && f.canPost),
              keys: Object.keys(f || {}),
            };
          }),
        };
      } catch (e) {
        report.diag = { error: String((e && e.message) || e) };
      }
    }

    // ===== 4) 逐个解析、判定、写入 =====
    const onlyUsers = Array.isArray(event.onlyUsers) && event.onlyUsers.length
      ? new Set(event.onlyUsers.map(function (x) { return String(x).trim(); }))
      : null;
    const grantedKeys = new Set(); // 防同一个 Feeder 被 userId 和 _id 各命中一次、写两遍
    const keys = Array.from(authors.keys());
    report.uniqueAuthors = keys.length;

    for (let i = 0; i < keys.length; i++) {
      const authorId = keys[i];
      const stat = authors.get(authorId);
      const { feeder, by } = await findFeeder(db, authorId);
      const item = {
        authorId: authorId,
        by: by,                       // 'userId' | '_id' | ''（未命中）
        userId: (feeder && feeder.userId) || '',
        nickName: (feeder && feeder.nickName) || '',
        pageCount: stat.pages,
        commentCount: stat.comments,
        action: '',
      };

      if (onlyUsers && !onlyUsers.has(authorId) && !(feeder && onlyUsers.has(String(feeder.userId || '')))) {
        item.action = 'skip:not-targeted';
        report.notTargeted++;
        report.items.push(item);
        continue;
      }

      if (!feeder) {
        report.unmatched++;
        item.action = 'skip:unmatched';
        report.items.push(item);
        continue;
      }
      report.matched++;
      if (by === 'userId') report.byUserId++; else report.byId++;

      const fid = String(feeder.userId || '').trim();
      const key = fid || String(feeder._id || '');
      if (grantedKeys.has(key)) {
        item.action = 'skip:duplicate-of-' + key;
        report.items.push(item);
        continue;
      }

      // 黑名单一票否决：先按 userId 判，再按 authorId 判（老数据 authorId 可能是 _id）
      if (black.has(fid) || black.has(authorId)) {
        report.skippedBlacklist++;
        item.action = 'skip:blacklist';
        report.items.push(item);
        continue;
      }

      if (feeder.canPost) {
        report.alreadyGranted++;
        item.action = 'skip:already';
        report.items.push(item);
        continue;
      }

      grantedKeys.add(key);
      item.action = 'grant';
      if (dryRun) {
        report.wouldGrant++;
        item.wouldApply = true;
      } else {
        // 【写入用 userId 而不是 _id】canPost 的读者是客户端 initUserState 里的
        //   find('Feeder', {userId: 会话id})，标记必须落在 userId 匹配的文档上。
        // 【为什么是 updateMany】Feeder 里同一个 userId 可能存在重复注册文档，
        //   而客户端读到哪一条是不确定的 —— 必须全部打上才保证生效。
        const set = { canPost: true, canPostBy: 'backfill', canPostTime: new Date() };
        if (fid) {
          await col(db, 'Feeder').updateMany({ userId: fid }, { $set: set });
        } else {
          // 畸形老数据：连 userId 都没有，只能按文档主键写，保证至少那条能生效
          await col(db, 'Feeder').updateOne({ _id: feeder._id }, { $set: set });
        }
        report.granted++;
        item.applied = true;
      }
      report.items.push(item);
    }

    // ===== 5) 计数自检 =====
    report.inconsistent =
      report.uniqueAuthors - (report.matched + report.unmatched + report.notTargeted);

    report.itemsTruncated = report.items.length > 500;
    report.items = report.items.slice(0, 500);
    return report;
  } catch (e) {
    console.error('[backfillCanPost] 执行失败', (e && e.message) || e);
    return { ok: false, dryRun: dryRun, msg: String((e && e.message) || e) };
  }
};
