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
 *   解封用户 → 解封该用户（恢复其内容可见 + 移出黑名单）
 *   拉黑用户 → 永久拉黑该用户（全场景可用；标记 BlackNum.permanent，不再受理申诉）
 *   也兼容旧用法：私聊机器人发「封禁 <openid>」/「解封 <openid>」/「拉黑用户 <openid>」。
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

// ===== 飞书配置（全部走环境变量，代码不硬编码真实值，防误提交泄露）=====
const FEISHU_VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN || '';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || ''; // 应用凭证页 cli_xxx
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || ''; // 应用凭证页 secret
// 通知群机器人 webhook（回复失败/无消息可回复时的回退通道）
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL || '';
const FEISHU_WEBHOOK_SECRET = process.env.FEISHU_WEBHOOK_SECRET || '';

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

/** 从推送原文解析 openid（「用户ID：」「被举报人ID：」或「封禁/解封 <openid>」） */
function extractOpenid(text) {
  const s = String(text || '');
  const patterns = [
    /用户ID[：:]\s*(\S+)/,
    /被举报人ID[：:]\s*(\S+)/,
    /封禁\s+(o[A-Za-z0-9_-]{10,})/,
    /解封\s+(o[A-Za-z0-9_-]{10,})/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = s.match(patterns[i]);
    if (m && m[1]) return m[1].trim();
  }
  return '';
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

/** 从推送原文判断场景：申诉 / 举报 / 审核（默认） */
function detectContext(text) {
  const s = String(text || '');
  if (s.indexOf('【申诉】') >= 0) return 'appeal';
  if (s.indexOf('【举报】') >= 0) return 'report';
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
      if (context === 'appeal') return { error: '❌ 该用户已被封禁，如需永久拒绝请回复「拉黑用户」' };
      const userId = cmd.userId || extractOpenid(parentText);
      return userId ? { action: 'ban', userId: userId } : { error: '❌ 未能解析出用户ID' };
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
      const userId = cmd.userId || extractOpenid(parentText);
      return userId ? { action: 'unban', userId: userId } : { error: '❌ 未能解析出用户ID' };
    }
    const t = extractTarget(parentText);
    if (!t.id) {
      return context === 'appeal'
        ? { error: '❌ 该帖子已被删除，解封失败（申诉请回复「解封用户」）' }
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
  let m = c.match(/^封禁\s+(o[A-Za-z0-9_-]{10,})$/);
  if (m) return { verb: 'ban', object: 'user', userId: m[1] };
  m = c.match(/^解封\s+(o[A-Za-z0-9_-]{10,})$/);
  if (m) return { verb: 'unban', object: 'user', userId: m[1] };
  m = c.match(/^拉黑用户\s+(o[A-Za-z0-9_-]{10,})$/);
  if (m) return { verb: 'reject', object: 'user', userId: m[1] };
  if (c === '封禁用户') return { verb: 'ban', object: 'user' };
  if (c === '封禁帖子') return { verb: 'ban', object: 'post' };
  if (c === '解封用户') return { verb: 'unban', object: 'user' };
  if (c === '解封帖子') return { verb: 'unban', object: 'post' };
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

/** fire-and-forget 触发 moderate（确认消息由 moderate 完成后自行回发到评论区） */
function fireModerate(ctx, params) {
  try {
    const p = ctx.mpserverless.function.invoke('moderate', params);
    if (p && typeof p.catch === 'function') {
      p.catch(function (e) {
        console.error('[feishuCallback] 触发 moderate 失败', e && e.message);
      });
    }
  } catch (e) {
    console.error('[feishuCallback] 触发 moderate 失败', e && e.message);
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
  const text = cleanText(parseContentText(message.content));
  const fromUser = (event.sender && event.sender.sender_id &&
    (event.sender.sender_id.open_id || event.sender.sender_id.user_id || event.sender.sender_id.union_id)) || '';

  const cmd = parseCommand(text);
  if (!cmd) {
    console.log('[feishuCallback] 未识别:', text);
    await respond(message, '⚠️ 未识别：「' + text + '」（来自 ' + fromUser + '）\n可用：封禁 / 封禁帖子 / 封禁用户 / 解封 / 解封帖子 / 解封用户 / 拉黑用户');
    return { code: 0 };
  }

  // 私聊带 openid 的旧用法：封禁 <openid> / 解封 <openid>
  if (cmd.userId) {
    fireModerate(ctx, { action: cmd.verb, userId: cmd.userId, reason: '飞书指令', confirm: true, replyTo: message.message_id || '' });
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

  const resolved = resolveAction(cmd, detectContext(parentText), parentText);
  if (resolved.error) {
    await respond(message, resolved.error);
    return { code: 0 };
  }

  const params = Object.assign({
    reason: '飞书评论区指令',
    confirm: true,
    replyTo: message.message_id || '',
  }, resolved);

  // 异步解耦：立即 ack 飞书，实际操作 + 评论区确认在 moderate 独立实例完成
  fireModerate(ctx, params);
  return { code: 0 };
};
