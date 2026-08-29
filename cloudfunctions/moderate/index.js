/**
 * 云函数 moderate —— 内容安全「封禁 / 解封 / 下架 / 恢复」服务端执行器
 * ============================================================
 * 【作用】把封禁/解封/下架/恢复的写库逻辑收口到服务端（ctx.mpserverless.db），
 *         前端复核中心、举报流程、飞书评论区指令统一调本函数。
 *
 * 【接口】ctx.args：
 *   { action:'ban',      userId, reason }                          → 封禁用户（软删其全部推文/评论）
 *   { action:'unban',    userId }                                  → 解封用户（恢复其内容可见）
 *   { action:'hide',     targetType:'page'|'comment', targetId }   → 封禁帖子（下架单条内容，无阈值）
 *   { action:'restore',  targetType, targetId }                    → 解封帖子（恢复单条内容）
 *   { action:'reject',   userId }                                  → 永久拉黑（标记 BlackNum.permanent，不再受理申诉）
 *   { action:'takedown', targetType, targetId, reporterId }        → 举报即下架（≥阈值才软删）
 *   可选：confirm:true 时操作完成后回发确认；replyTo=<飞书消息id> 时用 API 在评论区回复，
 *        否则回退群机器人 webhook。返回 { ok:true } 或 { ok:false,msg }；异常兜底不抛。
 *
 * 【软删除约定】推文 Page 用 hidden 标志，评论 Comment 用 deleted 标志；
 *   推文按 _id 定位，评论按 myCommentId 定位（与前端 utils/db.js 一致）。取证留存、不物理删。
 *
 * 【健壮性】
 *   1. ban/unban 采用「分页取 _id + 分批 updateMany」，避免几百条内容单次更新触发 EMAS 写限制/超时。
 *   2. takedown 阈值计数用 ReportAgg 的 $addToSet 原子登记去重举报人，消除并发竞态。
 *   3. 确认消息在操作完成后由本函数自行回发（不依赖调用方实例存活），保证「已封禁/解封」可靠送达。
 */
'use strict';
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

// 下架阈值：同一内容被多少个「不同用户」举报后自动下架。默认 1（举报即下架）。
const TAKEDOWN_THRESHOLD = Number(process.env.TAKEDOWN_THRESHOLD || 1);

// 每批更新的文档数上限（分批软删，防单次 updateMany 命中过多触发写限制）
const BATCH = 200;

// 飞书配置（优先控制台环境变量 process.env；EMAS 无环境变量入口时用随函数部署的 config.js 兜底）
let CFG = {};
try { CFG = require('./config.js') || {}; } catch (e) { /* 无 config.js 时忽略 */ }
function getCfg(name) { return process.env[name] || CFG[name] || ''; }

// 飞书群机器人 webhook（确认消息回退通道，评论区回复失败时用）
const FEISHU_WEBHOOK_URL = getCfg('FEISHU_WEBHOOK_URL');
const FEISHU_WEBHOOK_SECRET = getCfg('FEISHU_WEBHOOK_SECRET');
// 飞书自建应用凭证（换 tenant_access_token，用于在评论区回复管理员）
const FEISHU_APP_ID = getCfg('FEISHU_APP_ID');
const FEISHU_APP_SECRET = getCfg('FEISHU_APP_SECRET');

// ---- tenant_access_token 缓存（single-flight）----
let tokenCache = { token: null, expireAt: 0 };
let tokenPromise = null;

/** 取集合对象；db 不存在时抛错（由外层兜底） */
function col(db, name) {
  if (!db || !db.collection) throw new Error('无数据库访问 (ctx.mpserverless.db)');
  return db.collection(name);
}

/** find 结果归一化成数组：兼容直接返回数组或 {result:[...]} 两种形态 */
function toList(r) {
  if (Array.isArray(r)) return r;
  return (r && r.result) || [];
}

/** 分批软删/恢复。
 *  优先一次 updateMany（Mongo 多文档更新，扫描一次即完成，封禁秒级）；
 *  若云数据库对超大批量 updateMany 报错，回退「游标式分页」（按 _id 递增推进，O(n)，
 *  而非旧 skip 分页的 O(n²)——旧实现内容多时封禁要跑几分钟，是「响应/确认很慢」的元凶）。 */
async function batchUpdateAll(db, name, filter, setFields) {
  try {
    const r = await col(db, name).updateMany(filter, { $set: setFields });
    const c = (r && r.modifiedCount != null) ? r.modifiedCount
      : ((r && r.result && r.result.modifiedCount != null) ? r.result.modifiedCount : 0);
    return c;
  } catch (e) {
    console.warn('[moderate] 直接 updateMany 失败，回退游标分页', e && e.message);
  }
  let total = 0;
  let lastId = null;
  for (;;) {
    const q = Object.assign({}, filter);
    if (lastId !== null) q._id = { $gt: lastId };
    const list = toList(await col(db, name).find(q, { limit: BATCH, sort: { _id: 1 } }));
    if (!list.length) break;
    const ids = [];
    let maxId = null;
    list.forEach(function (x) {
      if (x && x._id) {
        ids.push(x._id);
        maxId = x._id; // 假定按 _id 增序返回，取末位为下一页游标
      }
    });
    if (ids.length) {
      await col(db, name).updateMany({ _id: { $in: ids } }, { $set: setFields });
      total += ids.length;
    }
    if (list.length < BATCH) break;
    if (maxId === null || maxId === lastId) break; // 无进展则终止，防死循环
    lastId = maxId;
  }
  return total;
}

/** 封禁用户：黑名单幂等写入 + 软删其全部推文/评论（分批） */
async function ban(db, userId, reason) {
  const id = String(userId || '').trim();
  if (!id) return { ok: false, msg: '缺 userId' };
  const now = new Date();
  const exist = toList(await col(db, 'BlackNum').find({ id: id }));
  if (!exist.length) {
    await col(db, 'BlackNum').insertOne({ id: id, time: now, reason: reason || '' });
  }
  const pages = await batchUpdateAll(db, 'Page', { authorId: id },
    { hidden: true, hiddenBy: 'ban', hiddenTime: now });
  const comments = await batchUpdateAll(db, 'Comment', { authorId: id },
    { deleted: true, deletedBy: 'ban', deletedTime: now });
  await cascadeHandled(db, { userId: id }); // 联动关闭该用户相关的待复核/举报/申诉
  return { ok: true, action: 'ban', userId: id, pages: pages, comments: comments };
}

/** 解封用户：移出黑名单 + 恢复其内容可见（分批） */
async function unban(db, userId) {
  const id = String(userId || '').trim();
  if (!id) return { ok: false, msg: '缺 userId' };
  const recs = toList(await col(db, 'BlackNum').find({ id: id }));
  for (let i = 0; i < recs.length; i++) {
    if (recs[i]._id) await col(db, 'BlackNum').deleteOne({ _id: recs[i]._id });
  }
  const pages = await batchUpdateAll(db, 'Page', { authorId: id }, { hidden: false });
  const comments = await batchUpdateAll(db, 'Comment', { authorId: id }, { deleted: false });
  await cascadeHandled(db, { userId: id }); // 联动关闭该用户相关的待复核/举报/申诉
  return { ok: true, action: 'unban', userId: id, pages: pages, comments: comments };
}

/** 解除黑名单（仅移出 BlackNum，不恢复内容）：账号可再发帖，历史内容保持隐藏；
 *  要恢复全部内容走「全部解封」action:'unban'。与 ban 的「拉黑+软删」互为反向的轻量解封。 */
async function unblacklist(db, userId) {
  const id = String(userId || '').trim();
  if (!id) return { ok: false, msg: '缺 userId' };
  const recs = toList(await col(db, 'BlackNum').find({ id: id }));
  for (let i = 0; i < recs.length; i++) {
    if (recs[i]._id) await col(db, 'BlackNum').deleteOne({ _id: recs[i]._id });
  }
  await cascadeHandled(db, { userId: id }); // 联动关闭该用户相关的待复核/举报/申诉
  return { ok: true, action: 'unblacklist', userId: id };
}

/** 封禁帖子：下架单条内容（管理员手动，无阈值，区别于举报 takedown） */
async function hide(db, targetType, targetId) {
  const type = targetType === 'page' ? 'page' : 'comment';
  const tid = String(targetId || '').trim();
  if (!tid) return { ok: false, msg: '缺 targetId' };
  const now = new Date();
  if (type === 'comment') {
    await col(db, 'Comment').updateOne({ myCommentId: tid },
      { $set: { deleted: true, deletedBy: 'admin', deletedTime: now } });
  } else {
    await col(db, 'Page').updateOne({ _id: tid },
      { $set: { hidden: true, hiddenBy: 'admin', hiddenTime: now } });
  }
  await cascadeHandled(db, { targetType: type, targetId: tid }); // 联动关闭该内容的举报待办
  return { ok: true, action: 'hide', targetType: type, targetId: tid };
}

/** 从 Report 集合兜底统计去重举报人数（非原子，仅 ReportAgg 失败时用） */
async function countFromReport(db, targetType, targetId) {
  const list = toList(await col(db, 'Report').find({ targetType: targetType, targetId: targetId }));
  const seen = {};
  list.forEach(function (x) { if (x && x.reporterId) seen[x.reporterId] = true; });
  return Object.keys(seen).length;
}

/** 举报即下架：不同举报人数量 ≥ 阈值才软删（ReportAgg 原子计数去重） */
async function takedown(db, targetType, targetId, reporterId) {
  const type = targetType === 'page' ? 'page' : 'comment';
  const tid = String(targetId || '').trim();
  if (!tid) return { ok: false, msg: '缺 targetId' };

  // 2026-08-28 举报人必须是已注册用户（Feeder 集合有资料），杜绝未注册账号/伪造 ID 举报。
  // 查不到资料一律拒绝（不下架、不计数）；查询失败也保守拒绝（宁可不下架，不让无效举报计数）。
  const rid = String(reporterId || '').trim();
  let feeders = [];
  try { feeders = toList(await col(db, 'Feeder').find({ userId: rid })); } catch (e) { feeders = []; }
  if (!rid || !feeders.length) {
    return { ok: false, code: 'NOT_FEEDER', msg: '举报人未注册，不能举报（请先注册）' };
  }

  let count = 0;
  try {
    await col(db, 'ReportAgg').updateOne(
      { targetType: type, targetId: tid },
      {
        $addToSet: { reporters: String(reporterId || '') },
        $setOnInsert: { targetType: type, targetId: tid, time: new Date() },
      },
      { upsert: true }
    );
    const aggList = toList(await col(db, 'ReportAgg').find({ targetType: type, targetId: tid }));
    const agg = aggList[0] || {};
    count = (agg.reporters && agg.reporters.length) || 0;
  } catch (e) {
    console.warn('[moderate] ReportAgg 计数失败，回退 Report 计数', e && e.message);
    count = await countFromReport(db, type, tid);
  }

  if (count < TAKEDOWN_THRESHOLD) {
    return { ok: true, action: 'takedown', takedown: false, count: count };
  }

  const now = new Date();
  if (type === 'comment') {
    await col(db, 'Comment').updateOne(
      { myCommentId: tid },
      { $set: { deleted: true, deletedBy: 'report', deletedTime: now } }
    );
  } else {
    await col(db, 'Page').updateOne(
      { _id: tid },
      { $set: { hidden: true, hiddenBy: 'report', hiddenTime: now } }
    );
  }
  return { ok: true, action: 'takedown', takedown: true, count: count };
}

/** 解封帖子：恢复单条内容（误报/误下架时由管理员恢复） */
async function restore(db, targetType, targetId) {
  const type = targetType === 'page' ? 'page' : 'comment';
  const tid = String(targetId || '').trim();
  if (!tid) return { ok: false, msg: '缺 targetId' };
  if (type === 'comment') {
    await col(db, 'Comment').updateOne({ myCommentId: tid }, { $set: { deleted: false } });
  } else {
    await col(db, 'Page').updateOne({ _id: tid }, { $set: { hidden: false } });
  }
  await cascadeHandled(db, { targetType: type, targetId: tid }); // 联动关闭该内容的举报待办
  return { ok: true, action: 'restore', targetType: type, targetId: tid };
}

/** 把某集合中满足条件的 pending 待办标记为已处理（单项失败不阻断其它集合，best-effort） */
async function markHandledWhere(db, name, filter) {
  try {
    await col(db, name).updateMany(Object.assign({ status: 'pending' }, filter), {
      $set: { status: 'handled', handledBy: 'moderate', handledTime: new Date() },
    });
  } catch (e) {
    console.warn('[moderate] 联动标记 ' + name + ' 失败（不影响主操作）', e && e.message);
  }
}

/** 联动清「复核中心」待办（2026-08-28）：
 *  用户在飞书被封禁/解封、内容被下架/恢复后，把与之相关的
 *  「待复核 Review(type=review) / 举报 Report / 申诉 Appeal」pending 记录
 *  全部标记为已处理，避免复核中心残留已被管理员处理过的旧待办。
 *  如：管理员在飞书回「封禁用户」后，该用户的举报/待复核/申诉不会再出现在复核中心。
 *  @param info { userId?, targetType?, targetId? } */
async function cascadeHandled(db, info) {
  const id = info && info.userId;
  const tid = info && info.targetId;
  if (id) {
    // 待复核：该作者内容被判定疑似的内容关闭
    await markHandledWhere(db, 'Review', { authorId: id, type: 'review' });
    // 举报：被举报人 = 该用户的内容，以及该用户发起的举报，全部关闭
    await markHandledWhere(db, 'Report', { targetAuthorId: id });
    await markHandledWhere(db, 'Report', { reporterId: id });
    // 申诉：该用户的申诉关闭（已通过飞书处理）
    await markHandledWhere(db, 'Appeal', { userId: id });
  }
  if (tid) {
    // 举报：目标内容被下架/恢复 → 该内容相关举报关闭（带 targetType 防推文/评论 ID 串扰）
    const filter = { targetId: tid };
    if (info.targetType) filter.targetType = info.targetType;
    await markHandledWhere(db, 'Report', filter);
  }
}

/** 永久拉黑：先封禁（幂等，软删内容 + 拉黑），再标记 permanent，之后不再受理申诉 */
async function reject(db, userId, reason) {
  const id = String(userId || '').trim();
  if (!id) return { ok: false, msg: '缺 userId' };
  const r = await ban(db, id, reason || '永久拉黑');
  await col(db, 'BlackNum').updateMany({ id: id }, { $set: { permanent: true } });
  return { ok: true, action: 'reject', userId: id, pages: r.pages, comments: r.comments };
}

// ===== 飞书推送 / 评论区回复 =====

/** 飞书自定义机器人签名：sign = base64(HmacSHA256(空数据, key=timestamp+"\n"+secret)) */
function feishuSign(timestamp, secret) {
  const stringToSign = String(timestamp) + '\n' + String(secret);
  return crypto.createHmac('sha256', stringToSign).update(Buffer.alloc(0)).digest('base64');
}

function httpsPostJson(url, body, extraHeaders) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        extraHeaders || {}
      ),
    }, function (res) {
      let data = '';
      res.on('data', function (d) { data += d; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, function () { req.destroy(new Error('https 超时')); });
    req.write(payload);
    req.end();
  });
}

/** 推送文本到飞书群机器人（best-effort，失败不阻塞主流程） */
async function pushFeishu(text) {
  if (!FEISHU_WEBHOOK_URL) return;
  try {
    const body = { msg_type: 'text', content: { text: String(text || '').slice(0, 500) } };
    if (FEISHU_WEBHOOK_SECRET) {
      const ts = String(Math.floor(Date.now() / 1000));
      body.timestamp = ts;
      body.sign = feishuSign(ts, FEISHU_WEBHOOK_SECRET);
    }
    await httpsPostJson(FEISHU_WEBHOOK_URL, body);
  } catch (e) {
    console.error('[moderate] 飞书确认推送失败', e && e.message);
  }
}

/** 换 tenant_access_token（single-flight + 提前 300s 过期） */
async function getTenantToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expireAt) return tokenCache.token;
  if (!tokenPromise) {
    tokenPromise = (async function () {
      if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) throw new Error('未配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
      const r = await httpsPostJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET,
      });
      if (!r || !r.tenant_access_token) throw new Error('获取 tenant_access_token 失败: ' + JSON.stringify(r));
      tokenCache = { token: r.tenant_access_token, expireAt: Date.now() + (r.expire - 300) * 1000 };
      return tokenCache.token;
    })();
    tokenPromise.then(function () { tokenPromise = null; }, function () { tokenPromise = null; });
  }
  return tokenPromise;
}

/** 在评论区回复某条消息（im/v1/messages/{id}/reply），确认消息嵌套在管理员评论下方 */
async function replyMessage(token, messageId, text) {
  await httpsPostJson(
    'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reply',
    { msg_type: 'text', content: JSON.stringify({ text: String(text || '').slice(0, 500) }) },
    { Authorization: 'Bearer ' + token }
  );
}

/** 操作完成后回发确认：优先评论区回复（replyTo），失败/缺 replyTo 回退 webhook */
async function confirmResult(event, r) {
  let text;
  if (r.ok) {
    if (r.action === 'ban') text = '✅ 已封禁用户：' + r.userId;
    else if (r.action === 'unban') text = '✅ 已解封用户：' + r.userId;
    else if (r.action === 'hide') text = '✅ 已封禁该帖子：' + r.targetId;
    else if (r.action === 'restore') text = '✅ 已解封该帖子：' + r.targetId;
    else if (r.action === 'unblacklist') text = '✅ 已解封用户：' + r.userId + '（内容仍隐藏，恢复全部内容请回复「全部解封」）';
    else if (r.action === 'reject') text = '✅ 已永久拉黑用户：' + r.userId + '（不再受理申诉）';
    else text = '✅ 已执行 ' + r.action;
  } else {
    text = '❌ 操作失败：' + (r.msg || '未知');
  }
  if (event.replyTo) {
    try {
      const tk = await getTenantToken();
      await replyMessage(tk, event.replyTo, text);
      return;
    } catch (e) {
      console.error('[moderate] 评论区回复失败，回退 webhook', e && e.message);
    }
  }
  await pushFeishu(text);
}

/**
 * 幂等登记：以 opId（= 飞书消息 id）为唯一操作标识，防飞书超时重试/网络抖动导致重复执行。
 *   已处理过 → true（跳过）；未处理 → 写入标记并返回 false（_id 冲突视为已处理）。
 *   表查询/登记本身故障时降级放行（返回 false 继续执行），绝不因幂等表故障阻断封禁。
 */
async function markDone(db, opId, action) {
  if (!opId) return false;
  try {
    const list = toList(await col(db, 'ModerateOps').find({ _id: opId }));
    if (list.length) return true; // 已处理过（重试/重复触发）→ 跳过
  } catch (e) {
    console.warn('[moderate] 幂等表查询失败，继续执行（不幂等）', e && e.message);
    return false;
  }
  try {
    await col(db, 'ModerateOps').insertOne({ _id: opId, action: action || '', time: new Date() });
  } catch (e) {
    // 可能是并发同插（_id 冲突）→ 二次确认；也可能是其它故障 → 不阻塞执行
    try {
      const again = toList(await col(db, 'ModerateOps').find({ _id: opId }));
      if (again.length) return true;
    } catch (e2) { /* 忽略 */ }
    console.warn('[moderate] 幂等登记失败，继续执行', e && e.message);
    return false;
  }
  return false;
}

/** 执行失败时清除幂等标记，允许重试重新执行（防「登记了却半途而废」） */
async function unmarkDone(db, opId) {
  if (!opId) return;
  try { await col(db, 'ModerateOps').deleteOne({ _id: opId }); } catch (e) { /* 忽略 */ }
}

module.exports = async function (ctx) {
  const event = (ctx && ctx.args) || {};
  const db = ctx && ctx.mpserverless && ctx.mpserverless.db;
  const opId = String(event.opId || '').trim(); // 唯一操作标识（飞书消息 id）；无 opId 的调用（举报 takedown 等）不受幂等影响
  try {
    // 幂等：同一 opId 只执行一次
    if (opId && await markDone(db, opId, event.action)) {
      console.log('[moderate] 幂等跳过（该指令已处理过）:', opId);
      return { ok: true, skipped: true, opId: opId };
    }
    let r;
    // 幂等执行：命令对应操作直接执行（各 handler 内部天然幂等——黑名单按 id 去重、软删/恢复只写标志位），
    // 无论目标当前处于什么状态，回执统一为「已 X」成功文案，让操作者一眼确认命令已生效。
    switch (event.action) {
      case 'ban':
        r = await ban(db, event.userId, event.reason);
        break;
      case 'unblacklist':
        r = await unblacklist(db, event.userId);
        break;
      case 'unban':
        r = await unban(db, event.userId);
        break;
      case 'reject':
        r = await reject(db, event.userId, event.reason);
        break;
      case 'hide':
        r = await hide(db, event.targetType, event.targetId);
        break;
      case 'restore':
        r = await restore(db, event.targetType, event.targetId);
        break;
      case 'takedown':
        // 举报即下架：走阈值判定，不回发确认（避免刷屏）
        return await takedown(db, event.targetType, event.targetId, event.reporterId);
      default:
        return { ok: false, msg: '未知 action: ' + event.action };
    }
    if (event.confirm) await confirmResult(event, r);
    return r;
  } catch (e) {
    if (opId) await unmarkDone(db, opId); // 失败清除标记，允许重试重新执行
    console.error('[moderate] 执行失败', event && event.action, (e && e.message) || e);
    return { ok: false, msg: String((e && e.message) || e) };
  }
};
