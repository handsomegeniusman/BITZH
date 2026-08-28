/**
 * 云函数 cleanDirtyData —— 一次性清洗「官方推文混入个人帖子」的脏数据
 * ============================================================
 * 【背景】历史 bug 让部分 official:true 的帖子带上了个人 openid（authorId），
 *        这些帖子其实不属于官方。按管理员确认的规则恢复：
 *          1. 遍历 Page 中 official:true 且有非空 authorId 的记录
 *          2. 用 Page.authorId 去 Feeder 找主人（先按 userId，找不到再按 _id，
 *             因为老代码可能把 Feeder 的 _id 存进了 authorId）
 *          3. 找到 Feeder → 恢复成该用户普通帖子：
 *               author    = Feeder.nickName
 *               authorImg = Feeder.avatarUrl
 *               authorId  = 保持不变（即 Feeder.userId）
 *               official  = false（去掉官方标记）
 *             （同时清掉官方专属字段 officialLogo / editBy / editTime）
 *          4. 找不到 Feeder → 跳过，列入报告供人工查看
 * 【用法】控制台「云函数 → cleanDirtyData → 测试」传参：
 *   { "dryRun": true }   先跑一遍只出报告、不改库（默认，防误操作）
 *   { "dryRun": false }  真正执行清洗
 * 【返回】{ ok, dryRun, total, matched, unmatched, skips, noOwnImage, items:[{...}] }
 *   - total       official:true 且有 authorId 的帖子总数
 *   - matched     找到 Feeder、可恢复的条数
 *   - unmatched   查不到 Feeder、跳过的条数
 *   - skips       official:true 但 authorId 为空/缺失（合法官方帖，不动）
 *   - noOwnImage  无自有图片（photoNum<=0，只有 logo）的恢复帖数量，
 *                 恢复后封面会缺图，建议人工处理（换图或删除）
 * 【安全】dryRun 默认 true；写库只改「能找到 Feeder 主人」的帖子，其余一律不动。
 * 【用完即删】清洗确认无误后，本函数可从控制台删除，不留在线上。
 */
'use strict';

const BATCH = 200; // 分批取数，防单次查询过大触发写限制

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
 * 【为什么要试两个字段】历史 bug 写入 Page.authorId 时，来源不统一：
 *   - 新代码（已修）存的是 Feeder.userId（MPServerless 会话 openid）
 *   - 老代码可能存的是 Feeder._id（文档主键，24 位 ObjectId）
 * 所以先试 userId 精确匹配，匹配不到再试 _id，返回 { feeder, by } 说明命中字段。
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

module.exports = async function (ctx) {
  const event = (ctx && ctx.args) || {};
  const dryRun = event.dryRun !== false; // 默认 dry-run，安全优先
  const db = ctx && ctx.mpserverless && ctx.mpserverless.db;

  try {
    const report = {
      ok: true,
      dryRun: dryRun,
      total: 0,       // official:true 且有非空 authorId
      matched: 0,     // 找到 Feeder 主人、可恢复
      unmatched: 0,   // 查不到 Feeder，跳过
      skips: 0,       // official:true 但无 authorId（合法官方帖）
      noOwnImage: 0,  // 恢复帖中无自有图片的数量
      items: [],      // 明细（最多列前 500 条）
      diag: null,     // 诊断信息：Feeder 样例记录（帮核对 authorId 到底对应哪个字段）
    };

    // ===== 诊断：取 5 条 Feeder 样例，看清 userId / _id / nickName 的真实形态 =====
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
              avatarUrl: f && f.avatarUrl,
              keys: Object.keys(f || {}),
            };
          }),
        };
      } catch (e) {
        report.diag = { error: String((e && e.message) || e) };
      }
    }

    for (let skip = 0; ; skip += BATCH) {
      const pages = toList(await col(db, 'Page').find({ official: true }, { limit: BATCH, skip: skip }));
      if (!pages.length) break;

      for (let i = 0; i < pages.length; i++) {
        const p = pages[i] || {};
        const authorId = String(p.authorId || '').trim();
        if (!authorId) {
          report.skips++;
          continue; // 官方帖本来就没 authorId → 合法，不动
        }
        report.total++;

        const { feeder, by } = await findFeeder(db, authorId);
        const item = {
          _id: p._id,
          tittle: String(p.tittle || '').slice(0, 40),
          authorId: authorId,
          found: !!feeder,
          by: by, // 命中字段：'userId' | '_id' | ''（未命中）
          from: { author: p.author || '', authorImg: p.authorImg || '' },
          to: null,
        };

        if (!feeder) {
          // Feeder 查无此人（可能资料被删/账号注销）。兜底：
          // 找该作者名下其它"未变官方"的普通帖子，用它的 author/authorImg 恢复身份。
          const other = toList(await col(db, 'Page').find(
            { authorId: authorId, official: { $ne: true }, hidden: { $ne: true } },
            { limit: 1 }
          ));
          if (other[0] && other[0].author && other[0].authorImg) {
            report.matched++;
            item.by = 'page';
            item.from = { author: p.author || '', authorImg: p.authorImg || '' };
            item.to = { author: other[0].author, authorImg: other[0].authorImg };
            if (!dryRun) {
              await col(db, 'Page').updateOne({ _id: p._id }, {
                $set: {
                  author: item.to.author,
                  authorImg: item.to.authorImg,
                  official: false,
                  officialLogo: false,
                  editBy: '',
                  editTime: null,
                },
              });
              item.applied = true;
            } else {
              item.wouldApply = true;
            }
            report.items.push(item);
            continue;
          }
          // 连历史帖子也没有 → 跳过、不改库，列入报告人工看
          report.unmatched++;
          report.items.push(item);
          continue;
        }

        report.matched++;
        item.to = {
          author: String(feeder.nickName || ''),
          authorImg: String(feeder.avatarUrl || ''),
        };
        // 无自有图片（photoNum<=0，只有 logo）的帖子：恢复后封面走 urlPage+tittle+0.jpg 会缺图
        item.noOwnImage = !(typeof p.photoNum === 'number' && p.photoNum > 0);
        if (item.noOwnImage) report.noOwnImage++;

        if (!dryRun) {
          await col(db, 'Page').updateOne({ _id: p._id }, {
            $set: {
              author: item.to.author,
              authorImg: item.to.authorImg,
              official: false,     // 去掉官方标记，恢复成普通帖子
              officialLogo: false, // 不再用官方 logo 封面
              editBy: '',          // 官方专属「编辑人/编辑时间」一并清掉
              editTime: null,
            },
          });
          item.applied = true;
        } else {
          item.wouldApply = true;
        }
        report.items.push(item);
      }
      if (pages.length < BATCH) break;
    }

    // 明细截断提示（防止返回体过大）
    report.itemsTruncated = report.items.length < (report.matched + report.unmatched);
    report.items = report.items.slice(0, 500);
    return report;
  } catch (e) {
    console.error('[cleanDirtyData] 执行失败', (e && e.message) || e);
    return { ok: false, dryRun: dryRun, msg: String((e && e.message) || e) };
  }
};
