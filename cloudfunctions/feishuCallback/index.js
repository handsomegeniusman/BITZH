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

/** 从推送原文解析「申请人ID」（【发布申请】推送里的「申请人ID：xxx」行）。
 *  「同意」/「拒绝」命令专用。
 *  【必须行首锚定（/m），且不能复用 extractOpenid】extractOpenid 会匹配「用户ID：」和
 *  「被举报人ID：」。若拿它做批准，管理员在**举报推送**下打「同意」（这是个很泛的词，
 *  完全可能手滑）就会把**被举报人**的 ID 解析出来并授予发布权 —— 给一个刚被举报的人开权限。
 *  场景守卫（resolveAction 里的 context 判断）是第二道防线，这里是第一道。 */
function extractApplicantId(text) {
  const s = String(text || '');
  const m = s.match(/^申请人ID[：:]\s*(\S+)/m);
  return (m && m[1]) ? m[1].trim() : '';
}

/** 从推送原文解析「用户ID」（【自助开通】通知卡片专供：撤销豁免命令用）。
 *  【为什么不复用 extractOpenid】它会连带匹配「被举报人ID：」和「封禁 <id>」字面量 ——
 *  在举报推送下回复「撤销豁免」就会撤掉**被举报人**的豁免，而报告出来的那个人并不是
 *  管理员想动的人。extractOpenid 的宽是「禁言用户」那种"全场景可用"命令要的，
 *  这里要的正好相反。
 *  【必须行首锚定（/m）】secCheck 的【待复核】/【已拦截】卡片也吐「用户ID：」行，
 *  行首锚定是让这行只在那张卡片里被认出来的第一道；第二道是 resolveAction 的场景守卫。 */
function extractExemptUserId(text) {
  const s = String(text || '');
  const m = s.match(/^用户ID[：:]\s*(\S+)/m);
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

/** 【自助开通】通知卡片的首行标记。⚠️ 与 postApply 的 buildSelfEnableCard 第一行是
 *  一对**跨函数常量**（两个函数各自独立打包，require 不到对方），改名要两边一起改。 */
const SELF_ENABLE_TITLE = '【自助开通】';

/** 从推送原文判断场景：申诉 / 举报 / 发布申请 / 自助开通 / 审核（默认）。
 *  只看第一行标题，避免正文内容误含「【申诉】/【举报】」字样导致误判场景。 */
function detectContext(text) {
  const s = String(text || '');
  const firstLine = (s.split('\n')[0] || s).trim();
  if (firstLine.indexOf('【申诉】') >= 0) return 'appeal';
  if (firstLine.indexOf('【举报】') >= 0) return 'report';
  // 发布权限申请卡片（postApply 通过 secCheck 推到「发布申请」群）
  if (firstLine.indexOf('【发布申请】') >= 0) return 'apply';
  // 【自助开通】通知卡片（postApply 的 selfEnable 推的）。
  // 【为什么它必须自成一类，而不是继续落在默认档 review】裸「撤销豁免」是唯一一条
  //   "回读父消息决定目标"的**粘性**命令：撤错了不会报错、当场也看不出来（对方只是忽然
  //   在审核模式下看不见内容了），要等本人来问才发现。而带「用户ID：」行的卡片不止这一张
  //   （secCheck 的【待复核】/【已拦截】也有），所以必须能把这张从里面挑出来，
  //   resolveAction 才好限定"只认它"。见那边的 revokeEnable 分支。
  //   注意：往这里加场景**不影响**既有命令 —— 封禁/解封/禁言用的是 extractOpenid，不看场景；
  //   「同意」要求 context === 'apply'，本卡片从前落在 'review'、现在落在 'selfenable'，
  //   两边都同样被拒（这条正是当初把首行写成「【自助开通】」的目的，不能被破坏）。
  if (firstLine.indexOf(SELF_ENABLE_TITLE) >= 0) return 'selfenable';
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

  // 「同意」/「拒绝」= 发布权限审批。**必须限定场景**：
  //   这两个词极短极泛（群里聊别的事打「同意」完全正常），不限定的话
  //   ① 在举报推送下打「同意」会去解析被举报人的 ID 并给他开发布权；
  //   ② 在审核推送下打「同意」会被当成审批推文。
  //   context !== 'apply' 一律拒绝，宁可让管理员多打一次，也不能批错人。
  if (verb === 'grantPost' || verb === 'denyPost') {
    if (context !== 'apply') {
      return { error: '❌ 「同意」/「拒绝」只能在【发布申请】推送下回复（当前是【' + context + '】场景）' };
    }
    const uid = cmd.userId || extractApplicantId(parentText);
    if (!uid) {
      return { error: '❌ 未能解析出申请人ID（可回复「同意 <申请人ID>」）' };
    }
    return {
      action: 'applyDecision',
      decision: verb === 'grantPost' ? 'approve' : 'reject',
      userId: uid,
    };
  }

  // 「撤销豁免」= 收回「审核模式豁免」（Feeder.enable），走 adminManage。
  // **必须限定场景**，理由与上面的「同意」同源但要更硬：
  //   ① 「同意」批错人是"多发一个权限"，本人和群里都会立刻有反馈，容易发现；
  //      而撤销豁免是**粘性状态**（撤了不点开回来就不生效，而且还会上锁），撤错人不会报错、
  //      当场也看不出来 —— 对方只是忽然在审核模式下看不见内容了，得等他来问。
  //      所以宁可让管理员多打一次 ID。
  //   ② 带「用户ID：」行的卡片**不止一张**：secCheck 的【待复核】/【已拦截】推送也有。
  //      若做成"全场景可用"（像「禁言用户」那样用 extractOpenid），在【待复核】卡片下
  //      回复「撤销豁免」就会去撤被复核作者的豁免 —— 而管理员当时想的多半不是这件事。
  // 所以：带 ID 的写法不要求场景（手打的 ID 不存在解析错人）；回读卡片的写法只认【自助开通】。
  // 【没有"恢复豁免"这条命令】撤销多按一次就要能退回来，这个需求是真实的，但它由
  //   **被撤销者本人重新走一次申请**完成（postApply 申请 → 管理员审批通过 → 顺带解锁
  //   enableRevoked，见 adminManage.applyDecision）—— 自助、留痕、且不新增一条
  //   "管理员凭一张卡片就能把权限给回去"的通道。回执里写明这条路。
  if (verb === 'revokeEnable') {
    if (cmd.userId) return { action: 'revokeEnable', userId: cmd.userId };
    if (context !== 'selfenable') {
      return {
        error: '❌ 「撤销豁免」只能在【自助开通】通知下回复（当前是【' + context +
          '】场景），或者直接发「撤销豁免 <用户ID>」',
      };
    }
    const uid = extractExemptUserId(parentText);
    if (!uid) {
      return { error: '❌ 未能解析出用户ID（该通知里的 ID 行格式可能被改过，可发「撤销豁免 <用户ID>」）' };
    }
    return { action: 'revokeEnable', userId: uid };
  }

  // 禁言 / 解除禁言：全场景可用（与「拉黑用户」同形，都是明确作用于用户且不会误伤帖子的命令）
  // 【为什么要和 ban 分开】禁言**保留既有内容**、不进黑名单，是比封禁轻一档的处置 ——
  //   群里看到刷屏但不能一上来就把人拉黑时用它。目标用户同样从推送的「被举报人ID」行解析。
  if (verb === 'mute' || verb === 'unmute') {
    const userId = cmd.userId || extractOpenid(parentText);
    if (!userId) return { error: '❌ 未能解析出用户ID（可回复「' + (verb === 'mute' ? '禁言用户' : '解除禁言') + ' <用户ID>」）' };
    return { action: verb, userId: userId, reason: '飞书指令' };
  }

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
 *   verb:   'ban' | 'unban' | 'reject' | 'mute' | 'unmute' | 'grantPost' | 'denyPost'
 *         | 'revokeEnable'
 *   object: 'user' | 'post' | null（null=裸命令，默认对象由 resolveAction 定为「帖子」）
 *   私聊带 openid：封禁 <openid> / 解封 <openid> / 拉黑用户 <openid> / 同意 <申请人ID>
 *                 禁言用户 <ID> / 解除禁言 <ID> / 撤销豁免 <ID>
 * 【注意 1】「同意」/「拒绝」用的 verb 是 grantPost/denyPost，**不能复用 'reject'** ——
 *   那个词已经被「拉黑用户」占了，复用会让「拒绝」变成把申请人拉进黑名单。
 * 【注意 2】mute/unmute 的 verb 名**必须与 moderate 的 action 名逐字相同**：上面
 *   `if (cmd.userId)` 那条分支会把 cmd.verb 原样当 action 丢给 moderate（见入口函数），
 *   名字对不上就会得到一个"未知 action"。这两处一起改。
 * 【注意 3】revokeEnable 走的是**另一条线**（adminManage），而且**必须**在
 *   入口函数里 `if (cmd.userId)` 之前被截住 —— 否则带 ID 的写法会被原样丢给 moderate，
 *   得到一个"未知 action"。它与 grantPost 同级，见入口函数的分流区。
 */
function parseCommand(content) {
  const c = String(content || '').trim();
  let m = c.match(new RegExp('^封禁\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'ban', object: 'user', userId: m[1] };
  m = c.match(new RegExp('^解封\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'unban', object: 'user', userId: m[1] };
  m = c.match(new RegExp('^拉黑用户\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'reject', object: 'user', userId: m[1] };
  // 禁言（剥夺发帖/评论权，但保留既有内容、不进黑名单）的"带 ID"形式
  m = c.match(new RegExp('^禁言用户\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'mute', object: 'user', userId: m[1] };
  m = c.match(new RegExp('^解除禁言\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'unmute', object: 'user', userId: m[1] };
  // 审核模式豁免（Feeder.enable）的撤销，走 adminManage（不是 moderate）。
  // 【为什么词是「豁免」而不是「权限」】本项目里"权限"默认指发布权（canPost），
  //   而这条命令**不碰** canPost（见 adminManage.revokeEnable）。用「撤销权限」这种词，
  //   管理员会以为它能把发帖权收走 —— 这是个会让人做出错误决定的歧义，必须避开。
  // 【不撞既有正则】既不落在 `^封禁|^解封` 前缀里，也不是任何精确词。
  m = c.match(new RegExp('^撤销豁免\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'revokeEnable', object: 'user', userId: m[1] };
  m = c.match(new RegExp('^全部解封\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'unban', object: 'all', userId: m[1] };
  // 发布权限审批的"带 ID"形式：回读不到父消息（比如卡片是 webhook 发的）时唯一可用的写法
  m = c.match(new RegExp('^同意\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'grantPost', object: 'user', userId: m[1] };
  m = c.match(new RegExp('^拒绝\\s+(' + ID_PAT + ')$'));
  if (m) return { verb: 'denyPost', object: 'user', userId: m[1] };
  if (c === '同意') return { verb: 'grantPost', object: 'user' };
  if (c === '拒绝') return { verb: 'denyPost', object: 'user' };
  if (c === '封禁用户') return { verb: 'ban', object: 'user' };
  if (c === '封禁举报人') return { verb: 'ban', object: 'reporter' };
  if (c === '解封举报人') return { verb: 'unban', object: 'reporter' };
  if (c === '封禁帖子') return { verb: 'ban', object: 'post' };
  if (c === '解封用户') return { verb: 'unban', object: 'user' };
  if (c === '解封帖子') return { verb: 'unban', object: 'post' };
  if (c === '全部解封') return { verb: 'unban', object: 'all' };
  if (c === '拉黑用户') return { verb: 'reject', object: 'user' };
  if (c === '禁言用户') return { verb: 'mute', object: 'user' };
  if (c === '解除禁言') return { verb: 'unmute', object: 'user' };
  // 裸形式：只认【自助开通】通知卡片（场景守卫在 resolveAction 里），目标是卡片上的「用户ID：」
  if (c === '撤销豁免') return { verb: 'revokeEnable', object: 'user' };
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

/**
 * 触发并等待 adminManage 执行一个动作（飞书 → adminManage 的**唯一**通道）。
 *   action: 'decidePostApply'（发布申请审批）/ 'revokeEnable'（收回豁免）
 * 【为什么调 adminManage 而不是自己写库】写入逻辑只能有一份（adminManage 的 applyDecision /
 *   revokeEnable），否则小程序那边和飞书这边两份实现迟早漂移。飞书回调里没有终端用户身份，
 *   走不了 adminManage 那两道锁，所以用 FEISHU_INTERNAL_SECRET 作为这条通道的凭据。
 * 【为什么不用 fireModerate】授予类动作刻意不放 moderate（它是无鉴权的公开函数，
 *   加授予等于开一个客户端可直接调用的自助提权接口）。走独立的一条线，互不干扰。
 * 【action 为什么是参数而不是写死】原先只有审批一条，函数名就叫 fireApplyDecision；
 *   加豁免的撤销时若再抄一份，去重、超时、诊断文案这三样必然开始漂移 ——
 *   而它们正是"出问题时能不能看见"的全部依靠。所以收成一个，动作名由调用方给。
 */
async function fireAdminManage(ctx, action, params, messageId) {
  const opId = String(messageId || '').trim();
  const dedupKey = dedupKeyOf(opId, params);
  if (dedupCheck(dedupKey)) {
    console.log('[feishuCallback] 该指令已处理过，跳过重复触发:', opId || dedupKey);
    return 'skip';
  }
  const t0 = Date.now();
  let r = null;
  try {
    r = await withTimeout(
      ctx.mpserverless.function.invoke('adminManage', Object.assign({}, params, {
        action: action,
        internalSecret: getCfg('FEISHU_INTERNAL_SECRET'),
      })),
      MODERATE_AWAIT_MS
    );
  } catch (e) {
    console.error('[feishuCallback] 触发 adminManage 失败', e && e.message);
  }
  const elapsed = Date.now() - t0;
  if (elapsed > 5000) {
    console.warn('[feishuCallback] adminManage 执行耗时过长:', action, elapsed + 'ms');
  }
  if (r === null || r === 'skip') {
    console.error('[feishuCallback] 触发 adminManage 失败（adminManage 是否已部署？）');
    await confirmPush('❌ 诊断：未能触发 ' + action + '。请检查 adminManage 云函数是否已部署、' +
      'FEISHU_INTERNAL_SECRET 是否已在 feishuCallback 与 adminManage 两侧配成同一个值。');
  } else if (r && typeof r === 'object' && r.ok === false) {
    console.error('[feishuCallback] adminManage 返回失败:', r.code, r.msg);
  }
  return r;
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

/**
 * 处理「同意」/「拒绝」：解析出申请人 → 触发 adminManage → 返回回执文案。
 * 【两种写法，风险不同】
 *   · 「同意」       —— 靠回读被回复的推送原文拿申请人ID。**必须限定场景**：
 *       这两个词太短太泛，群里聊别的事打「同意」完全正常。不限定的话，在举报推送下打
 *       「同意」就会去解析「被举报人ID」并把发布权批给刚被举报的人。
 *   · 「同意 <ID>」  —— 手打了明确的 ID，不存在解析错人的风险，所以不要求场景。
 *       这条也是卡片由 webhook 发出（回读不到父消息）时唯一能用的写法。
 * @returns {Promise<{reply:string, ok:boolean}>} 永远返回可回发的文案，不抛
 */
async function handlePostDecision(ctx, message, cmd, text) {
  const approve = cmd.verb === 'grantPost';
  const verbText = approve ? '同意' : '拒绝';

  let parentText = '';
  let context = 'apply'; // 手打 ID 时无需场景校验
  if (!cmd.userId) {
    const rootId = message.root_id || message.parent_id || '';
    if (!rootId) {
      return { ok: false, reply: '❌ 没有可关联的推送。请在该申请卡片下回复，或直接发「' + verbText + ' <申请人ID>」' };
    }
    try {
      const tk = await getTenantToken();
      parentText = parseContentText(await fetchMessageText(tk, rootId));
    } catch (e) {
      console.error('[feishuCallback] 回读父消息失败', e && e.message);
    }
    context = detectContext(parentText);
  }

  const resolved = resolveAction(cmd, context, parentText);
  if (resolved.error) {
    // 诊断：与 moderate 那条线同款，把场景和回读结果推给管理员自己看
    await confirmPush('🔍 诊断：指令「' + text + '」→ 场景=' + context + '，被拒绝：' + resolved.error +
      '\n父推送（前120字）：\n' + String(parentText || '(回读为空)').slice(0, 120));
    return { ok: false, reply: resolved.error };
  }

  const r = await fireAdminManage(ctx, 'decidePostApply', {
    decision: resolved.decision,
    userId: resolved.userId,
  }, message.message_id || '');

  if (r === 'skip') return { ok: true, reply: '⚠️ 收到相同指令，已在执行中，不重复处理' };
  if (!r || typeof r !== 'object') {
    return { ok: false, reply: '❌ 未能触发审批，请检查 adminManage 是否已部署、FEISHU_INTERNAL_SECRET 是否两侧一致' };
  }
  if (r.ok === false) {
    return { ok: false, reply: '❌ ' + (r.msg || '执行失败') + '（' + (r.code || '?') + '）' };
  }

  const who = r.nickName ? ('「' + r.nickName + '」') : resolved.userId;
  if (approve) {
    return {
      ok: true,
      reply: '✅ 已通过 ' + who + ' 的发布申请。\n' +
        '对方需**完全退出小程序再重新进入**才生效（只是返回上一页或切后台都不算）。',
    };
  }
  return {
    ok: true,
    reply: '✅ 已拒绝 ' + who + ' 的发布申请。对方已有权限（如有）不受影响，今天不能再申请。',
  };
}

/**
 * 处理「撤销豁免」：解析出目标用户 → 触发 adminManage → 返回回执文案。
 * 结构与 handlePostDecision 同款（带 ID 时不回读、不带 ID 时回读父消息判场景），
 * 差别只有一处：resolveAction 对这条命令**强制要求 selfenable 场景**，理由见那边注释。
 *
 * @param {string} fromUser 发送者 open_id，落进 Feeder.enableRevokedBy 作审计。
 *   【与 handlePostDecision 不同】审批那边 actorId 写死 'feishu'（授予类不追问到人），
 *   而撤销是剥夺类：出了争议要能回答"是谁撤的"，飞书通道里唯一稳定的人标识就是这个。
 * @returns {Promise<{reply:string, ok:boolean}>} 永远返回可回发的文案，不抛
 */
async function handleRevokeEnable(ctx, message, cmd, text, fromUser) {
  const name = '撤销豁免';

  let parentText = '';
  let context = 'selfenable'; // 手打 ID 时用不到场景（resolveAction 对带 ID 的写法不判场景）
  if (!cmd.userId) {
    const rootId = message.root_id || message.parent_id || '';
    if (!rootId) {
      return { ok: false, reply: '❌ 没有可关联的推送。请在【自助开通】通知下回复，或直接发「' + name + ' <用户ID>」' };
    }
    try {
      const tk = await getTenantToken();
      parentText = parseContentText(await fetchMessageText(tk, rootId));
    } catch (e) {
      console.error('[feishuCallback] 回读父消息失败', e && e.message);
    }
    context = detectContext(parentText);
  }

  const resolved = resolveAction(cmd, context, parentText);
  if (resolved.error) {
    // 诊断：与审批那条线同款。撤销被拒时管理员最需要知道的就是"我回在哪张卡片上了"，
    // 所以把回读到的父推送原文（前 120 字）一并推出去。
    await confirmPush('🔍 诊断：指令「' + text + '」→ 场景=' + context + '，被拒绝：' + resolved.error +
      '\n父推送（前120字）：\n' + String(parentText || '(回读为空)').slice(0, 120));
    return { ok: false, reply: resolved.error };
  }

  const r = await fireAdminManage(ctx, cmd.verb, {
    userId: resolved.userId,
    actorId: fromUser || 'feishu',
  }, message.message_id || '');

  if (r === 'skip') return { ok: true, reply: '⚠️ 收到相同指令，已在执行中，不重复处理' };
  if (!r || typeof r !== 'object') {
    return { ok: false, reply: '❌ 未能触发，请检查 adminManage 是否已部署、FEISHU_INTERNAL_SECRET 是否两侧一致' };
  }
  if (r.ok === false) {
    return { ok: false, reply: '❌ ' + (r.msg || '执行失败') + '（' + (r.code || '?') + '）' };
  }

  // 【回执里为什么一定要显示昵称】撤销是"认错人也看不出来"的操作，光回一串 ID，
  //   管理员没法确认自己撤的是不是想撤的那个人。昵称由 adminManage.revokeEnable 一并返回。
  const who = r.nickName ? ('「' + r.nickName + '」') : resolved.userId;
  // 【为什么回执里要写清"怎么还原"】这条命令没有逆操作（原来那句"要还原就回复恢复豁免 X"
  //   已随命令一起删掉）。撤销是粘性的，管理员撤错人却不知道下一步做什么的话，
  //   对方就只能一直看不见内容 —— 所以必须把唯一的还原路径写在回执里，且写成
  //   **对方自己能做的动作**，而不是"你再去飞书里回一句什么"。
  return {
    ok: true,
    reply: '✅ 已收回 ' + who + ' 的审核模式豁免。\n' +
      '对方在审核模式下将看不见内容，且**在「关于」页连点五次也开不回来**（已上锁）。\n' +
      '撤错了怎么办：**让对方自己在「我的」页重新提交发布权限申请**，你审批通过即可 ——\n' +
      '通过时会顺带把这道锁清掉（不再有直接的「恢复豁免」命令）。',
  };
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
    // chat_id 跟着这条回执一起发回群里。上面 649 行已经把 chat_id 打进日志，但 EMAS 控制台
    // **看不到运行日志**（只有入参 + 请求响应状态），建新群时要拿 chat_id 就只能靠这条回执：
    // 在群里 @ 一次机器人（随便发句话）即可看到本群 chat_id。
    // 【放最后一行】可用的命令列表在前，别让这行排查信息把它挤下去。
    const chatIdLine = message.chat_id ? '\n本群 chat_id：' + message.chat_id : '';
    await respond(message, '⚠️ 未识别：「' + text + '」（来自 ' + fromUser + '）\n可用：封禁 / 封禁帖子 / 封禁用户 / 封禁举报人 / 解封 / 解封帖子 / 解封用户 / 解封举报人 / 全部解封 / 拉黑用户 / 禁言用户 / 解除禁言\n发布申请：同意 / 拒绝（在该申请卡片下回复）\n审核模式豁免：撤销豁免（在【自助开通】通知下回复；也可写「撤销豁免 <用户ID>」）\n（拉黑 = 隐藏其全部内容；禁言 = 只停发帖评论，内容保留；豁免 = 审核模式下看不看得见内容，与发帖权无关；撤销豁免后要还原，让对方重新申请、你审批通过即可）' + chatIdLine);
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

  // ---- 发布权限审批：「同意」/「拒绝」（走 adminManage，不走 moderate）----
  // 【为什么必须拦在这里】下面 `if (cmd.userId)` 会把任何带 userId 的命令原样丢给 moderate，
  //   而 grantPost/denyPost 对 moderate 来说是未知 action。必须在分流之前截住。
  if (cmd.verb === 'grantPost' || cmd.verb === 'denyPost') {
    const decided = await handlePostDecision(ctx, message, cmd, text);
    await respond(message, decided.reply);
    return { code: 0 };
  }

  // ---- 撤销「审核模式豁免」（同样走 adminManage，不走 moderate）----
  // 【为什么必须拦在这里，与上面「同意」同理】下面 `if (cmd.userId)` 会把任何带 userId 的
  //   命令原样丢给 moderate，而 revokeEnable 对 moderate 是未知 action。
  //   postApply 那边靠"action 名不在白名单"挡住了，这里必须显式截住。
  if (cmd.verb === 'revokeEnable') {
    const done = await handleRevokeEnable(ctx, message, cmd, text, fromUser);
    await respond(message, done.reply);
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
module.exports.extractApplicantId = extractApplicantId;
module.exports.extractExemptUserId = extractExemptUserId;
