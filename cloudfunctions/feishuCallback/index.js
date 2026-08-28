/**
 * 云函数 feishuCallback —— 飞书「自建应用」消息回调（评论区式封禁/解封）
 * ============================================================
 * 【作用】管理员在飞书里，对「内容违规/举报」推送**在下方评论区回复命令**，
 *         机器人读取评论 → 从被回复的推送原文解析目标 → 触发 moderate 执行，
 *         完成后由 moderate 在评论区回复「✅ 已封禁/解封」确认。
 *         以「最新一条评论」为准（后发覆盖先发，封禁/解封幂等，重复无害）。
 *
 * 【命令词汇表（裸命令主体是「帖子」，作用于用户需显式说「…用户」）】
 *   封禁     → 封禁该帖子（下架单条内容；无帖子ID时提示「已被删除」）
 *   封禁帖子 → 封禁该帖子
 *   封禁用户 → 封禁该用户（作者，软删其全部内容 + 拉黑）
 *   解封     → 解封该帖子（恢复单条内容；无帖子ID时提示「已被删除」）
 *   解封帖子 → 解封该帖子
 *   解封用户 → 解除该用户黑名单（账号可再发帖，内容保持隐藏）
 *   全部解封 → 解除黑名单 + 恢复该用户全部内容（显式全量恢复，防误触）
 *   拉黑用户 → 永久拉黑该用户（全场景可用；标记 BlackNum.permanent，不再受理申诉）
 *   也兼容旧用法：私聊机器人发「封禁 <openid>」/「解封 <openid>」/「全部解封 <openid>」/「拉黑用户 <openid>」。
 *
 * 【实现：评论区只写「封禁」不带 openid，机器人怎么知道封谁？】
 *   1. 飞书回复消息带 root_id（指向被回复的那条推送）。
 *   2. 机器人用 app_id/app_secret 换 tenant_access_token，调 im/v1/messages/{root_id} 读回推送原文。
 *   3. 封禁/解封用户 → 解析「用户ID/被举报人ID」；封禁/解封帖子 → 解析「目标ID + 类型」。
 *   （webhook 响应不回 message_id，故不能靠推送时存映射，必须回读父消息。）
 *
 * 【部署前提（飞书后台，缺一不可）】
 *   1. 应用开通权限 im:message（获取与发送消息），并发布版本。
 *   2. 把机器人拉进通知群，设为「接收所有消息」（否则收不到评论区回复）；或评论时 @机器人。
 *   3. FEISHU_APP_ID / FEISHU_APP_SECRET 已填（应用凭证页）。
 */
'use strict';
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

// ===== 飞书配置（优先控制台环境变量 process.env；EMAS 无环境变量入口时用随函数部署的 config.js 兜底）=====
let CFG = {};
try { CFG = require('./config.js') || {}; } catch (e) { /* 无 config.js 时忽略 */ }
function getCfg(name) { return process.env[name] || CFG[name] || ''; }

const FEISHU_VERIFICATION_TOKEN = getCfg('FEISHU_VERIFICATION_TOKEN');
const FEISHU_APP_ID = getCfg('FEISHU_APP_ID'); // 应用凭证页 cli_xxx
const FEISHU_APP_SECRET = getCfg('FEISHU_APP_SECRET'); // 应用凭证页 secret
// 通知群机器人 webhook（回复失败/无消息可回复时的回退通道）
const FEISHU_WEBHOOK_URL = getCfg('FEISHU_WEBHOOK_URL');
const FEISHU_WEBHOOK_SECRET = getCfg('FEISHU_WEBHOOK_SECRET');

// ---- tenant_access_token 缓存（single-flight）----
let tokenCache = { token: null, expireAt: 0 };
let tokenPromise = null;

/** 飞书自定义机器人签名 */
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

function httpsGetJson(url, headers) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: headers || {} }, function (res) {
      let data = '';
      res.on('data', function (d) { data += d; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('非 JSON 响应: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, function () { req.destroy(new Error('https 超时')); });
  });
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

/** 在评论区回复某条消息（im/v1/messages/{id}/reply） */
async function replyMessage(token, messageId, text) {
  await httpsPostJson(
    'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reply',
    { msg_type: 'text', content: JSON.stringify({ text: String(text || '').slice(0, 500) }) },
    { Authorization: 'Bearer ' + token }
  );
}

/** 解析飞书消息 content 字段（text 消息是 JSON 字符串 {"text":"..."}，兼容 base64 变体） */
function parseContentText(raw) {
  if (!raw) return '';
  const s = String(raw);
  try { const o = JSON.parse(s); if (o && typeof o.text === 'string') return o.text; } catch (e) { /* 非 JSON */ }
  try { const o = JSON.parse(Buffer.from(s, 'base64').toString('utf8')); if (o && typeof o.text === 'string') return o.text; } catch (e) { /* 非 base64 */ }
  return '';
}

// 用户标识匹配：微信 openid（o 开头）或本空间用户 ID（Mongo ObjectId，24 位 hex）。
// 本项目 getInfo().userId 返回的是空间用户 ID（形如 64fa07d6a09a9bd68b13a8a0，非 openid），
// 飞书命令带 ID 必须两种都认，否则「封禁 <24位ID>」无法解析。
const ID_PAT = '(?:o[A-Za-z0-9_-]{10,}|[0-9a-fA-F]{24})';

/** 从推送原文解析 openid（「用户ID：」「被举报人ID：」或「封禁/解封 <id>」） */
function extractOpenid(text) {
  const s = String(text || '');
  const patterns = [
    /用户ID[：:]\s*(\S+)/,
    /被举报人ID[：:]\s*(\S+)/,
    new RegExp('封禁\\s+(' + ID_PAT + ')'),
    new RegExp('解封\\s+(' + ID_PAT + ')'),
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = s.match(patterns[i]);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

/** 从推送原文解析「举报人ID」（【举报】推送里的「举报人ID：xxx」行）。
 *  「封禁举报人」命令专用：与 extractOpenid 相互独立（extractOpenid 匹配「被举报人ID」），
 *  避免「封禁用户」误封到举报人。
 *  注意必须行首锚定（/m）：「举报人ID」是「被举报人ID」的后缀子串，否则会误匹配到被举报人。 */
function extractReporterId(text) {
  const s = String(text || '');
  const m = s.match(/^举报人ID[：:]\s*(\S+)/m);
  return (m && m[1]) ? m[1].trim() : '';
}

/** 从推送原文解析「类型 + 目标ID」（封禁/解封帖子用） */
function extractTarget(text) {
  const s = String(text || '');
  let type = 'page';
  // 兼容「类型：推文/评论」与「【举报】推文/评论」两种格式
  const tm = s.match(/类型[：:]\s*(\S+)/) || s.match(/【举报】\s*(\S+)/);
  if (tm) {
    const t = tm[1];
    if (t.indexOf('评论') >= 0 || t.toLowerCase().indexOf('comment') >= 0) type = 'comment';
    else type = 'page';
  }
  const im = s.match(/目标ID[：:]\s*(\S+)/);
  return { type: type, id: (im && im[1]) ? im[1].trim() : '' };
}

/** 从推送原文判断场景：申诉 / 举报 / 审核（默认）。
 *  只看第一行标题，避免正文内容误含「【申诉】/【举报】」字样导致误判场景。 */
function detectContext(text) {
  const s = String(text || '');
  const firstLine = (s.split('\n')[0] || s).trim();
  if (firstLine.indexOf('【申诉】') >= 0) return 'appeal';
  if (firstLine.indexOf('【举报】') >= 0) return 'report';
  return 'review';
}

/**
 * 按「命令 × 推送场景」解析为 moderate 入参。
 * 规则：
 *   - 裸「封禁」「解封」主体是「帖子」；无帖子ID（审核/申诉）时按场景提示
 *   - 「封禁用户 / 解封用户 / 拉黑用户」明确作用于用户
 *   - 「拉黑用户」全场景可用（有用户ID即可永久拉黑）
 */
function resolveAction(cmd, context, parentText) {
  const verb = cmd.verb;
  const object = cmd.object;

  if (verb === 'reject') { // 拉黑用户：全场景可用
    const userId = cmd.userId || extractOpenid(parentText);
    return userId ? { action: 'reject', userId: userId, reason: '永久拉黑' } : { error: '❌ 未能解析出用户ID' };
  }

  if (verb === 'ban') {
    const obj = object || 'post'; // 裸「封禁」= 封禁帖子
    if (obj === 'user') {
      // 2026-08-28 用户要求：回「封禁用户」一律直接封禁（申诉人可能本就不在黑名单里，不拒绝）
      const userId = cmd.userId || extractOpenid(parentText);
      return userId ? { action: 'ban', userId: userId } : { error: '❌ 未能解析出用户ID' };
    }
    if (obj === 'reporter') {
      // 2026-08-28 「封禁举报人」：封禁提交举报的用户（恶意/滥用举报）。
      // 只从【举报】推送的「举报人ID」行解析；extractReporterId 与 extractOpenid 相互独立，
      // 保证「封禁用户」仍解析「被举报人ID」、不会误封到举报人。
      const reporterId = cmd.userId || extractReporterId(parentText);
      return reporterId
        ? { action: 'ban', userId: reporterId, reason: '举报人滥用举报被封禁' }
        : { error: '❌ 未能解析出举报人ID（仅举报推送可回复「封禁举报人」）' };
    }
    const t = extractTarget(parentText);
    if (!t.id) {
      return context === 'appeal' ? { error: '❌ 该帖子已被封禁' } : { error: '❌ 该帖子已被删除' };
    }
    return { action: 'hide', targetType: t.type, targetId: t.id };
  }

  if (verb === 'unban') {
    const obj = object || 'post'; // 裸「解封」= 解封帖子
    if (obj === 'user') {
      // 「解封用户」只解除黑名单（账号可再发帖），内容保持隐藏；要恢复全部内容需显式「全部解封」
      const userId = cmd.userId || extractOpenid(parentText);
      return userId ? { action: 'unblacklist', userId: userId } : { error: '❌ 未能解析出用户ID' };
    }
    if (obj === 'all') {
      // 「全部解封」= 解除黑名单 + 恢复该用户全部内容（显式全量恢复，防误触）
      const userId = cmd.userId || extractOpenid(parentText);
      return userId ? { action: 'unban', userId: userId } : { error: '❌ 未能解析出用户ID' };
    }
    if (obj === 'reporter') {
      // 「解封举报人」：解除举报人的黑名单（内容保持隐藏，与「解封用户」语义一致）
      const reporterId = cmd.userId || extractReporterId(parentText);
      return reporterId
        ? { action: 'unblacklist', userId: reporterId }
        : { error: '❌ 未能解析出举报人ID（仅举报推送可回复「解封举报人」）' };
    }
    const t = extractTarget(parentText);
    if (!t.id) {
      return context === 'appeal'
        ? { error: '❌ 该帖子已被删除，解封失败（申诉请回复「解封用户」或「全部解封」）' }
        : { error: '❌ 该帖子已被删除' };
    }
    return { action: 'restore', targetType: t.type, targetId: t.id };
  }

  return { error: '❌ 未知命令' };
}

/**
 * 解析文本命令 → { verb, object, userId? }
 *   verb:   'ban' | 'unban' | 'reject'
 *   object: 'user' | 'post' | null（null=裸命令，默认对象由 resolveAction 定为「帖子」）
 *   私聊带 openid：封禁 <openid> / 解封 <openid> / 拉黑用户 <openid>
 */
function parseCommand(content) {
  const c = String(content || '').trim();
  let m = c.match(new RegExp('^封禁\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'ban', object: 'user', userId: m[1] };
  m = c.match(new RegExp('^解封\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'unban', object: 'user', userId: m[1] };
  m = c.match(new RegExp('^拉黑用户\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'reject', object: 'user', userId: m[1] };
  m = c.match(new RegExp('^全部解封\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'unban', object: 'all', userId: m[1] };
  if (c === '封禁用户') return { verb: 'ban', object: 'user' };
  if (c === '封禁举报人') return { verb: 'ban', object: 'reporter' };
  if (c === '解封举报人') return { verb: 'unban', object: 'reporter' };
  if (c === '封禁帖子') return { verb: 'ban', object: 'post' };
  if (c === '解封用户') return { verb: 'unban', object: 'user' };
  if (c === '解封帖子') return { verb: 'unban', object: 'post' };
  if (c === '全部解封') return { verb: 'unban', object: 'all' };
  if (c === '拉黑用户') return { verb: 'reject', object: 'user' };
  if (c === '封禁') return { verb: 'ban', object: null };   // 裸封禁 → 帖子
  if (c === '解封') return { verb: 'unban', object: null }; // 裸解封 → 帖子
  return null;
}

/** 去掉群聊里 @机器人 的前缀（形如 @_user_1 或 @所有人） */
function cleanText(t) {
  return String(t || '').replace(/^(@_?[\w-]+\s*)+/, '').trim();
}

/** 回发到飞书群机器人 webhook（best-effort） */
async function confirmPush(text) {
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
    console.error('[feishuCallback] 确认推送失败', e && e.message);
  }
}

/** 回复管理员：优先评论区回复（有 message_id），失败回退 webhook */
async function respond(message, text) {
  const mid = message && message.message_id;
  if (mid) {
    try {
      const tk = await getTenantToken();
      await replyMessage(tk, mid, text);
      return;
    } catch (e) {
      console.error('[feishuCallback] 评论区回复失败，回退 webhook', e && e.message);
    }
  }
  await confirmPush(text);
}

/** 从 ctx.args 取请求 body（飞书 POST 的是 JSON） */
function getJsonBody(ctx) {
  const args = (ctx && ctx.args) || {};
  let b = args.body;
  if (b === undefined || b === null) return null;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch (e) { return null; }
  }
  return b;
}

/** 回读飞书消息原文 content（GET im/v1/messages/{message_id}） */
async function fetchMessageText(token, messageId) {
  const r = await httpsGetJson('https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId), {
    Authorization: 'Bearer ' + token,
  });
  const item = r && r.data && r.data.items && r.data.items[0];
  if (!item) return '';
  return (item.body && item.body.content) || '';
}

// ---- 幂等去重（防飞书超时重试 / 网络抖动对同一事件重复执行）----
// 内存去重表：同一 message_id 在窗口内只处理一次（moderate 侧另有持久化去重兜底跨实例）
const DEDUP_MAX = 500;          // 去重表上限，超过清理最旧，防内存无界增长
const DEDUP_WINDOW_MS = 5000;   // 同一事件去重窗口（5 秒，覆盖飞书即时重试）
const DEDUP_CMD_MS = 30000;     // 相同指令内容去重窗口（30 秒：同一命令发两次 → 第二次只回执「重复指令」）
const MODERATE_AWAIT_MS = 8000; // await moderate 的最长等待：正常秒级内完成，此值只防飞书回调超时重试
const dedupSeen = {};           // key -> 最近处理时间戳(ms)

function dedupKeyOf(messageId, params) {
  const mid = String(messageId || '').trim();
  if (mid) return 'msg:' + mid;
  return 'op:' + JSON.stringify(params || {});
}

/** 窗口内已处理 → true；否则登记本次时间戳并返回 false；windowMs 缺省用 DEDUP_WINDOW_MS */
function dedupCheck(key, windowMs) {
  const now = Date.now();
  const win = (typeof windowMs === 'number' && windowMs > 0) ? windowMs : DEDUP_WINDOW_MS;
  const last = dedupSeen[key];
  if (last && now - last < win) return true;
  dedupSeen[key] = now;
  const keys = Object.keys(dedupSeen);
  if (keys.length > DEDUP_MAX) {
    keys.slice(0, Math.floor(DEDUP_MAX / 2)).forEach(function (k) { delete dedupSeen[k]; });
  }
  return false;
}

/** 给 promise 包一层超时：ms 内未完成即 resolve，避免等待提示回发阻塞主流程 */
function withTimeout(p, ms) {
  return Promise.race([
    Promise.resolve(p).catch(function () {}),
    new Promise(function (resolve) { setTimeout(resolve, ms); }),
  ]);
}

/** 诊断：moderate 执行过慢（>5s）时推群里一条，正常只记 console（用户看不到云函数日志，只能看群） */
function diagSlow(action, t0) {
  const elapsed = Date.now() - t0;
  if (elapsed > 5000) {
    console.warn('[feishuCallback] moderate 执行耗时过长:', elapsed + 'ms', action);
    confirmPush('⚠️ 诊断：' + (action || '?') + ' 执行耗时 ' + (elapsed / 1000).toFixed(1) + 's');
  }
}

/** 等待 moderate 完成（上限 MODERATE_AWAIT_MS 保护飞书回调不超时重试），并做耗时 + 失败诊断 */
async function fireModerateAndDiag(ctx, params, messageId) {
  const t0 = Date.now();
  const r = await withTimeout(fireModerate(ctx, params, messageId), MODERATE_AWAIT_MS);
  diagSlow((params && params.action) || '?', t0);
  const action = (params && params.action) || '?';
  // 诊断：invoke 失败 / moderate 返回失败时推群里（用户看不到云函数日志，只能看群）
  if (r === null) {
    console.error('[feishuCallback] 触发 moderate 失败（已重试 1 次）:', action);
    confirmPush('❌ 诊断：未能触发 moderate（' + action + '），请检查 moderate 云函数是否已部署');
  } else if (r && typeof r === 'object' && r.ok === false) {
    console.error('[feishuCallback] moderate 返回失败:', action, r.msg);
    confirmPush('❌ 诊断：moderate 执行失败（' + action + '）：' + (r.msg || '未知'));
  }
}

/**
 * 触发并等待 moderate 执行审核指令。
 * 早期版本是 fire-and-forget（不 await），但 EMAS 里 invoke 在 handler 返回后会悬挂/冻结，
 * moderate 迟迟不执行 → 表现为「⏳ 秒回、✅ 却要几分钟甚至第二次/第三次发送才来」。
 * 现改为 await：moderate 已改为一次 updateMany（封禁秒级），await 不会触发飞书超时重试；
 * 同指令 30s 内容去重 + moderate 侧 opId 持久化幂等兜底，飞书重试也不会重复执行。
 * 注：不再回发「⏳ 已收到指令」即时提示（处理已足够快，结果由 moderate 回发 ✅/❌）。
 */
async function fireModerate(ctx, params, messageId) {
  const opId = String(messageId || '').trim();
  const dedupKey = dedupKeyOf(opId, params);
  if (dedupCheck(dedupKey)) {
    console.log('[feishuCallback] 该指令已处理过，跳过重复触发:', opId || dedupKey);
    return 'skip'; // 区分「已去重」与「触发失败」两种空返回
  }

  const invokeParams = Object.assign({}, params);
  if (opId) invokeParams.opId = opId; // 透传给 moderate 做持久化幂等
  return await invokeModerate(ctx, invokeParams);
}

/** 调用 moderate 并 await 完成。调用失败时自动重试 1 次；配合 moderate 侧 opId 幂等，重试不重复执行。 */
async function invokeModerate(ctx, params) {
  let tries = 0;
  const MAX = 2; // 首次 + 1 次重试
  for (;;) {
    tries++;
    try {
      return await ctx.mpserverless.function.invoke('moderate', params);
    } catch (e) {
      console.error('[feishuCallback] 触发 moderate 失败' + (tries > 1 ? '（第' + tries + '次）' : ''), e && e.message);
      if (tries >= MAX) return null;
      await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    }
  }
}

module.exports = async function (ctx) {
  console.log('[feishuCallback] ctx.args keys =', Object.keys((ctx && ctx.args) || {}));

  const data = getJsonBody(ctx);
  if (!data || typeof data !== 'object') {
    console.error('[feishuCallback] 未解析到 JSON body');
    return { code: 1 };
  }

  // ---- URL 验证 ----
  if (data.type === 'url_verification' && data.challenge) {
    if (FEISHU_VERIFICATION_TOKEN && data.token && data.token !== FEISHU_VERIFICATION_TOKEN) {
      return { code: 1 };
    }
    return { challenge: data.challenge };
  }

  // ---- 事件回调（兼容 v1 / v2）----
  let token = '';
  let eventType = '';
  let event = null;
  if (data.schema === '2.0') {
    token = (data.header && data.header.token) || '';
    eventType = (data.header && data.header.event_type) || '';
    event = data.event || {};
  } else if (data.type === 'event_callback') {
    token = data.token || '';
    eventType = (data.event && data.event.type) || '';
    event = data.event || {};
  } else {
    return { code: 0 };
  }

  if (FEISHU_VERIFICATION_TOKEN && token && token !== FEISHU_VERIFICATION_TOKEN) {
    return { code: 1 };
  }

  if (eventType !== 'im.message.receive_v1' && eventType !== 'message') {
    return { code: 0 };
  }

  const message = event.message || {};
  // 只处理真实用户发来的消息；机器人（自定义机器人 webhook 推送、应用自己发的评论回复）触发的回调
  // 一律静默忽略，否则会形成「机器人回复 → 回调 → 再回复」的自言自语循环：
  // 🛠 诊断 / ✅ 回执 / ⚠️ 重复指令回执都会被当成新评论解析出「未识别」或再次触发去重回执。
  // sender_type 缺失时放行（兼容旧事件格式），只有明确是 app/机器人时才忽略。
  const senderType = (event.sender && event.sender.sender_type) || '';
  if (senderType && senderType !== 'user') {
    console.log('[feishuCallback] 忽略非用户消息 sender_type=' + senderType);
    return { code: 0 };
  }
  // 调试：把 chat_id 打进日志，方便从云函数日志里拿到「通知群 chat_id」（机器人入群后在群里 @它即可看到）
  if (message.chat_id) console.log('[feishuCallback] chat_id =', message.chat_id);
  const text = cleanText(parseContentText(message.content));
  const fromUser = (event.sender && event.sender.sender_id &&
    (event.sender.sender_id.open_id || event.sender.sender_id.user_id || event.sender.sender_id.union_id)) || '';

  const cmd = parseCommand(text);
  if (!cmd) {
    console.log('[feishuCallback] 未识别:', text);
    await respond(message, '⚠️ 未识别：「' + text + '」（来自 ' + fromUser + '）\n可用：封禁 / 封禁帖子 / 封禁用户 / 封禁举报人 / 解封 / 解封帖子 / 解封用户 / 解封举报人 / 全部解封 / 拉黑用户');
    return { code: 0 };
  }

  // 重复指令识别：同一命令内容 + 同一会话在窗口内重复出现 → 只回执、不重复触发执行
  //（区别于 fireModerate 按 message_id 去重：两次发送 message_id 不同，但命令内容相同）
  const sessionKey = message.root_id || message.parent_id || 'dm';
  const cmdDedupKey = 'cmd:' + text + '|' + sessionKey;
  if (dedupCheck(cmdDedupKey, DEDUP_CMD_MS)) {
    console.log('[feishuCallback] 重复指令，仅回执:', text);
    await respond(message, '⚠️ 收到相同指令，已在执行中，不重复处理');
    return { code: 0 };
  }

  // 处理已足够快（await moderate 秒级完成）：不再回发「⏳ 已收到指令」，直接执行，结果由 moderate 回发
  // 私聊带 openid 的旧用法：封禁 <openid> / 解封 <openid>（message_id 作为幂等 opId）
  if (cmd.userId) {
    await fireModerateAndDiag(ctx, { action: cmd.verb, userId: cmd.userId, reason: '飞书指令', confirm: true, replyTo: message.message_id || '' }, message.message_id || '');
    return { code: 0 };
  }

  // 评论区裸命令：回读被回复的推送，按推送场景解析目标
  const rootId = message.root_id || message.parent_id || '';
  if (!rootId) {
    await respond(message, '❌ 没有可关联的推送。请在推送评论区回复命令，或私聊发「封禁 <openid>」');
    return { code: 0 };
  }

  let parentText = '';
  try {
    const tk = await getTenantToken();
    parentText = parseContentText(await fetchMessageText(tk, rootId));
  } catch (e) {
    console.error('[feishuCallback] 回读父消息失败', e && e.message);
  }

  const context = detectContext(parentText);
  const resolved = resolveAction(cmd, context, parentText);
  if (resolved.error) {
    // 诊断：被拒原因 + 回读到的父推送 + 场景推群里，便于核对是否回错推送/误判场景
    await confirmPush('🔍 诊断：指令「' + text + '」→ 场景=' + context + '，被拒绝：' + resolved.error +
      '\n父推送（前120字）：\n' + String(parentText || '(回读为空)').slice(0, 120));
    await respond(message, resolved.error);
    return { code: 0 };
  }

  const params = Object.assign({
    reason: '飞书评论区指令',
    confirm: true,
    replyTo: message.message_id || '',
  }, resolved);

  // await moderate 完成（已改为秒级）：不挂后台、不排队，飞书回调在上限内拿到 ack；
  // message_id 作为幂等 opId，同指令 30s 内容去重 + moderate 侧 opId 幂等共同兜底
  await fireModerateAndDiag(ctx, params, message.message_id || '');
  return { code: 0 };
};

// ---- 导出纯解析函数，供本地测试 / 后续复用（云函数入口仍是上面的 async function）----
module.exports.parseCommand = parseCommand;
module.exports.resolveAction = resolveAction;
module.exports.detectContext = detectContext;
module.exports.extractTarget = extractTarget;
module.exports.extractOpenid = extractOpenid;
module.exports.extractReporterId = extractReporterId;
