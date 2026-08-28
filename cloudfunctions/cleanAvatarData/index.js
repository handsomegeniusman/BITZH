/**
 * 云函数 cleanAvatarData —— 清洗「本地临时图片路径」脏数据
 * ============================================================
 * 【背景】历史版本把微信"选择头像"返回的本地临时文件路径
 *        （wxfile://tmp_... 或 http://tmp/...）写进了数据库：
 *          - Feeder.avatarUrl   （用户资料头像）
 *          - Page.authorImg     （推文作者头像，由 userInfo.avatarUrl 复制而来）
 *          - Comment.authorImg  （评论作者头像，同上）
 *        本地临时路径只在"当前设备、当前会话"有效：换设备 / 重启后失效，
 *        其他人看到会破图，且文件随时可能被微信清理。必须替换成 COS 永久地址。
 * 【修复规则】
 *   1. Feeder.avatarUrl 是本地路径 → 改为 cos.profileUrl(nickName)
 *       即 ROOT + 'profile/' + nickName + '.png'（与 regist 页写库规则一致）
 *   2. Page.authorImg 是本地路径 → 优先按 authorId 找 Feeder，抄其（已修复的）avatarUrl；
 *       找不到 Feeder 时按 author 名推导 cos.profileUrl(author)
 *   3. Comment.authorImg 是本地路径 → 同上
 * 【用法】控制台「云函数 → cleanAvatarData → 测试」传参：
 *   { "dryRun": true }   只出报告、不改库（默认，安全优先）
 *   { "dryRun": false }  真正执行修复
 * 【返回】{ ok, dryRun, collections:{ Feeder:{...}, Page:{...}, Comment:{...} } }
 * 【安全】dryRun 默认 true；修复只改"当前字段是本地路径"的记录，其余一律不动。
 * 【用完即删】确认无误后，本函数可从控制台删除，不留在线上。
 */
'use strict';

const BATCH = 200;  // 分批取数，防单次查询过大

// COS 图片访问根地址（与 miniprogram/config.js imageUrl 保持一致）
const COS_ROOT = 'https://bitzh-1318479541.cos.ap-guangzhou.myqcloud.com/main/images/';

// 微信默认头像（用户从未上传头像时的占位，与 regist / userManage 页一致）
const DEFAULT_AVATAR = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0';

function col(db, name) {
  if (!db || !db.collection) throw new Error('无数据库访问 (ctx.mpserverless.db)');
  return db.collection(name);
}

/** find 结果归一化成数组：兼容直接返回数组或 {result:[...]} 两种形态 */
function toList(r) {
  if (Array.isArray(r)) return r;
  return (r && r.result) || [];
}

/** 判断图片地址是否为「微信本地临时文件」（未上传到 COS） */
function isLocalUrl(u) {
  return typeof u === 'string' &&
    (u.indexOf('wxfile://') === 0 || u.indexOf('http://tmp') === 0);
}

/** 判断昵称是否有效（昵称会用作 COS 头像文件名，空昵称会产生残缺地址） */
function hasNickName(f) {
  return !!(f && typeof f.nickName === 'string' && f.nickName.trim() !== '');
}

/** 由昵称推导 COS 头像地址（与 utils/cos.js profileUrl 一致） */
function profileUrl(nickName) {
  return COS_ROOT + 'profile/' + (nickName || '') + '.png';
}

module.exports = async function (ctx) {
  const event = (ctx && ctx.args) || {};
  const dryRun = event.dryRun !== false; // 默认 dry-run，安全优先
  const db = ctx && ctx.mpserverless && ctx.mpserverless.db;

  // ===== 诊断模式：传 { "checkUser": "用户openid或Feeder._id" } 时，只查该用户资料 + 发帖/评论数，不改任何数据 =====
  if (event.checkUser) {
    try {
      const id = String(event.checkUser);
      const byUserId = toList(await col(db, 'Feeder').find({ userId: id }, { limit: 1 }));
      const byId = toList(await col(db, 'Feeder').find({ _id: id }, { limit: 1 }));
      const f = byUserId[0] || byId[0] || null;
      const posts = toList(await col(db, 'Page').find({ authorId: id }, { limit: 200 }));
      const comments = toList(await col(db, 'Comment').find({ authorId: id }, { limit: 200 }));
      return {
        ok: true,
        checkUser: id,
        matchedBy: byUserId[0] ? 'userId' : (byId[0] ? '_id' : '无匹配'),
        feeder: f ? {
          _id: f._id,
          userId: f.userId,
          nickName: f.nickName || '',
          avatarUrl: f.avatarUrl || '',
          phoneNum: f.phoneNum || '',
          enable: !!f.enable,
          feeded: f.feeded,
        } : null,
        postCount: posts.length,
        commentCount: comments.length,
        posts: posts.slice(0, 20).map(function (p) {
          return { _id: p._id, tittle: String(p.tittle || '').slice(0, 40), hidden: !!p.hidden };
        }),
        comments: comments.slice(0, 20).map(function (c) {
          return { _id: c._id, main: String(c.main || '').slice(0, 40), deleted: !!c.deleted };
        }),
      };
    } catch (e) {
      console.error('[cleanAvatarData] checkUser 失败', (e && e.message) || e);
      return { ok: false, checkUser: event.checkUser, msg: String((e && e.message) || e) };
    }
  }

  // ===== 模式二：清「无昵称残缺账号」的头像（账号保留，头像改为微信默认占位） =====
  // 传 { "fixNoNickname": true } 先预览（dry-run）；{ "fixNoNickname": false } 真正执行。
  // 仅处理「头像为本地路径 + 昵称为空」的 Feeder 记录，其余一律不动。
  if (event.fixNoNickname !== undefined) {
    const doFix = event.fixNoNickname === false; // true=预览，false=执行（与 dryRun 语义一致）
    const out = { ok: true, dryRun: !doFix, total: 0, fixed: 0, samples: [] };
    try {
      for (let skip = 0; ; skip += BATCH) {
        const rows = toList(await col(db, 'Feeder').find({}, { limit: BATCH, skip: skip }));
        if (!rows.length) break;
        for (let i = 0; i < rows.length; i++) {
          const f = rows[i] || {};
          if (!isLocalUrl(f.avatarUrl)) continue;   // 只动本地头像
          if (hasNickName(f)) continue;             // 有昵称的不在此模式处理
          out.total++;
          if (out.samples.length < 20) {
            out.samples.push({ _id: f._id, nickName: f.nickName || '', from: f.avatarUrl, to: DEFAULT_AVATAR });
          }
          if (!doFix) continue;
          try {
            await col(db, 'Feeder').updateOne({ _id: f._id }, { $set: { avatarUrl: DEFAULT_AVATAR } });
            out.fixed++;
          } catch (e) {
            console.error('[cleanAvatarData] fixNoNickname 失败', f._id, (e && e.message) || e);
          }
        }
        if (rows.length < BATCH) break;
      }
      return out;
    } catch (e) {
      console.error('[cleanAvatarData] fixNoNickname 执行失败', (e && e.message) || e);
      return { ok: false, dryRun: !doFix, msg: String((e && e.message) || e) };
    }
  }

  const report = {
    ok: true,
    dryRun: dryRun,
    collections: {},
  };

  try {
    // ===== 1. Feeder.avatarUrl =====
    // 规则：头像为本地路径 → 改为 cos.profileUrl(nickName)。
    //       没有昵称的记录无法生成有效 COS 地址，跳过并计入 needManual，等人工处理。
    const feeder = { total: 0, fixed: 0, needManual: 0, left: 0, samples: [] };
    report.collections.Feeder = feeder;
    for (let skip = 0; ; skip += BATCH) {
      const rows = toList(await col(db, 'Feeder').find({}, { limit: BATCH, skip: skip }));
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i++) {
        const f = rows[i] || {};
        if (!isLocalUrl(f.avatarUrl)) continue;
        feeder.total++;
        if (!hasNickName(f)) {
          // 没昵称 → 无法推导 COS 头像地址，跳过，人工处理
          feeder.needManual++;
          if (feeder.samples.length < 20) {
            feeder.samples.push({ _id: f._id, nickName: f.nickName || '', from: f.avatarUrl, to: '', reason: '无昵称，需人工处理' });
          }
          continue;
        }
        const to = profileUrl(f.nickName);
        if (feeder.samples.length < 20) {
          feeder.samples.push({ _id: f._id, nickName: f.nickName, from: f.avatarUrl, to: to });
        }
        if (!dryRun) {
          try {
            await col(db, 'Feeder').updateOne({ _id: f._id }, { $set: { avatarUrl: to } });
            feeder.fixed++;
          } catch (e) {
            feeder.left++;
            console.error('[cleanAvatarData] Feeder 修复失败', f._id, (e && e.message) || e);
          }
        }
      }
      if (rows.length < BATCH) break;
    }

    // ===== 2. Page.authorImg =====
    // 规则：优先按 authorId 找 Feeder 抄其（已修复的）avatarUrl；若 Feeder 头像仍是本地路径
    //       （可能被跳过未修）或查不到 Feeder，则按作者名推导 cos.profileUrl(author)。
    const page = { total: 0, fixed: 0, left: 0, samples: [] };
    report.collections.Page = page;
    for (let skip = 0; ; skip += BATCH) {
      const rows = toList(await col(db, 'Page').find({}, { limit: BATCH, skip: skip }));
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i++) {
        const p = rows[i] || {};
        if (!isLocalUrl(p.authorImg)) continue;
        page.total++;
        // 优先按 authorId 找 Feeder（抄其已修复的头像）；找不到则按 author 名推导
        let to = '';
        if (p.authorId) {
          const fList = toList(await col(db, 'Feeder').find({ userId: String(p.authorId) }, { limit: 1 }));
          // 只有 Feeder 头像已是有效 COS 地址才抄（防止把脏数据又复制一遍）
          if (fList[0] && !isLocalUrl(fList[0].avatarUrl) && fList[0].avatarUrl) to = fList[0].avatarUrl;
        }
        if (!to) to = profileUrl(p.author);
        if (page.samples.length < 20) {
          page.samples.push({ _id: p._id, tittle: String(p.tittle || '').slice(0, 30), authorId: p.authorId, from: p.authorImg, to: to });
        }
        if (!dryRun) {
          try {
            await col(db, 'Page').updateOne({ _id: p._id }, { $set: { authorImg: to } });
            page.fixed++;
          } catch (e) {
            page.left++;
            console.error('[cleanAvatarData] Page 修复失败', p._id, (e && e.message) || e);
          }
        }
      }
      if (rows.length < BATCH) break;
    }

    // ===== 3. Comment.authorImg =====
    // 规则：同 Page——优先抄 Feeder 的已修复头像，否则按作者名推导。
    const comment = { total: 0, fixed: 0, left: 0, samples: [] };
    report.collections.Comment = comment;
    for (let skip = 0; ; skip += BATCH) {
      const rows = toList(await col(db, 'Comment').find({}, { limit: BATCH, skip: skip }));
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i++) {
        const c = rows[i] || {};
        if (!isLocalUrl(c.authorImg)) continue;
        comment.total++;
        let to = '';
        if (c.authorId) {
          const fList = toList(await col(db, 'Feeder').find({ userId: String(c.authorId) }, { limit: 1 }));
          // 只有 Feeder 头像已是有效 COS 地址才抄（防止把脏数据又复制一遍）
          if (fList[0] && !isLocalUrl(fList[0].avatarUrl) && fList[0].avatarUrl) to = fList[0].avatarUrl;
        }
        if (!to) to = profileUrl(c.author);
        if (comment.samples.length < 20) {
          comment.samples.push({ _id: c._id, authorId: c.authorId, from: c.authorImg, to: to });
        }
        if (!dryRun) {
          try {
            await col(db, 'Comment').updateOne({ _id: c._id }, { $set: { authorImg: to } });
            comment.fixed++;
          } catch (e) {
            comment.left++;
            console.error('[cleanAvatarData] Comment 修复失败', c._id, (e && e.message) || e);
          }
        }
      }
      if (rows.length < BATCH) break;
    }

    report.ok = true;
    return report;
  } catch (e) {
    console.error('[cleanAvatarData] 执行失败', (e && e.message) || e);
    return { ok: false, dryRun: dryRun, msg: String((e && e.message) || e) };
  }
};
