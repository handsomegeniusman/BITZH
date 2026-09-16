/**
 * 云函数 secCheck —— 内容安全审核（服务端唯一安全边界）
 * ============================================================
 * 【作用】小程序 UGC（推文/评论/昵称）写库前的服务端审核：
 *    1. 本地敏感词预检（拦 msgSecCheck 识别滞后的赌博暗语等）
 *    2. 调微信 security.msgSecCheck（v2）文本检测
 *    3. 命中「疑似/违规」时，通知飞书管理员（优先自建应用 API 推送，缺配置回退群机器人 Webhook）
 *    4. action='notify' 时只做推送（举报/申诉等轻量通知复用本函数）
 *
 * 【部署】新建云函数 secCheck（Node.js 运行时），粘贴本文件 + sensitiveWords.js 即可运行。
 *        所有密钥（AppID/AppSecret/飞书机器人/管理员邮箱）都通过「环境变量」配置，
 *        代码里不硬编码任何真实值（避免误提交到公开仓库泄露）。
 *        本函数只用 Node 内置 https/url/crypto，无需 npm install。
 *
 * 【安全】appid/secret 只存环境变量，绝不下放前端。
 * 【降级】审核服务异常时返回 pass（放行），不让审核故障阻塞正常发布。
 * 【动态词库】除静态词表外，本函数还会读 `SensitiveWord` 集合里管理员运行时追加的词
 *        （写入端在 adminManage，需过密码 —— 本函数**只读**，见下方 loadExtraWords）。
 *        该集合**不存在或没权限时按"没有动态词"处理**，静态词表照常工作，不影响发布。
 */
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const sensitive = require('./sensitiveWords.js');

// 密钥：全部从「环境变量」读取，代码里绝不硬编码真实值。
// 缺省为空串（未配置时对应能力自动降级，不影响其它功能）。
// 请在云函数控制台配置：WX_APPID / WX_SECRET / FEISHU_WEBHOOK_URL / FEISHU_WEBHOOK_SECRET / ADMIN_EMAIL
//                   及（可选，推荐）：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID（应用 API 推送，评论区命令可回读解析）
// 配置来源：优先控制台环境变量 process.env；EMAS 小程序云没有环境变量入口时，
// 随函数部署一个 config.js（模板见同目录 config.example.js）兜底。
let CFG = {};
try { CFG = require('./config.js') || {}; } catch (e) { /* 无 config.js 时忽略 */ }
function getCfg(name) { return process.env[name] || CFG[name] || ''; }

const APPID = getCfg('WX_APPID');
const SECRET = getCfg('WX_SECRET');
const FEISHU_WEBHOOK_URL = getCfg('FEISHU_WEBHOOK_URL');
const FEISHU_WEBHOOK_SECRET = getCfg('FEISHU_WEBHOOK_SECRET');
const ADMIN_EMAIL = getCfg('ADMIN_EMAIL');
// 自建应用凭证 + 通知群 chat_id：让通知用「应用 API」发送（机器人自己发的消息一定能被 feishuCallback 回读）
const FEISHU_APP_ID = getCfg('FEISHU_APP_ID');
const FEISHU_APP_SECRET = getCfg('FEISHU_APP_SECRET');
const FEISHU_CHAT_ID = getCfg('FEISHU_CHAT_ID');
// 「发布申请」新群：发布权限申请卡片推到这里，与违规告警群分开，
// 免得申请卡片把告警刷走、也免得申请群的成员顺手看到违规内容。
// 未配置时一律回落主群（降级不阻塞，与全文件其余推送一致）。
const FEISHU_APPLY_CHAT_ID = getCfg('FEISHU_APPLY_CHAT_ID');
const FEISHU_APPLY_WEBHOOK_URL = getCfg('FEISHU_APPLY_WEBHOOK_URL');
const FEISHU_APPLY_WEBHOOK_SECRET = getCfg('FEISHU_APPLY_WEBHOOK_SECRET');

// 推送目标白名单。不认的值一律按 'main' —— 调用方拼错参数时宁可推到主群，
// 也不要静默丢弃（丢一条违规告警比推错群严重得多）。
const PUSH_TARGETS = ['main', 'apply'];
function normTarget(t) {
  const s = String(t || '');
  return PUSH_TARGETS.indexOf(s) >= 0 ? s : 'main';
}

// ---------- access_token 缓存（single-flight，防并发重复刷新） ----------
// 说明：云函数并发执行，多请求同时发现 token 过期时会各刷一次 → 被微信限流。
//      用「共享 in-flight Promise」保证同一时刻只有一个刷新请求，其余 await 同一结果。
let tokenCache = { token: null, expireAt: 0 };
let tokenPromise = null; // 进行中的刷新请求（single-flight）

// ---------- 飞书推送限流/去重（防刷帖把群刷爆） ----------
const PUSH_MAX_PER_MIN = 30;   // 每分钟最多推送条数（超出丢弃 + 告警日志）
const PUSH_DEDUP_MS = 60000;   // 相同内容去重窗口（60s）
const PUSH_SEEN_MAX = 200;     // 去重表上限，超过清理最旧，防内存无界增长
// 【为什么去重/限流要按群分桶】这两个表原来是全局共享的，多一个群就会互相顶掉：
//   ① 申请卡片会消耗主群的 PUSH_MAX_PER_MIN 配额 → 同一分钟内的高危违规告警被静默丢弃；
//   ② 相同文案跨群互相去重 → 第二条申请直接不推（看起来像"申请丢了"）。
//   所以按 target 分桶，各群各算各的。
const pushBuckets = {};        // target -> { window:{count,windowStart}, seen:{text:ts} }
function bucket(t) {
  const k = normTarget(t);
  if (!pushBuckets[k]) pushBuckets[k] = { window: { count: 0, windowStart: 0 }, seen: {} };
  return pushBuckets[k];
}
// ---- tenant_access_token 缓存（single-flight，应用 API 推送用）----
let appTokenCache = { token: null, expireAt: 0 };
let appTokenPromise = null;

function httpsGet(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, function (res) {
      let data = '';
      res.on('data', function (d) { data += d; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('非 JSON 响应: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, function () { req.destroy(new Error('https 请求超时')); });
  });
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
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('非 JSON 响应: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, function () { req.destroy(new Error('https 请求超时')); });
    req.write(payload);
    req.end();
  });
}

/** 获取并缓存 access_token（提前 300 秒过期；single-flight 防并发重复刷新） */
async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expireAt) return tokenCache.token;
  if (!tokenPromise) {
    tokenPromise = (async function () {
      if (!APPID || !SECRET) throw new Error('未配置 WX_APPID / WX_SECRET 环境变量');
      const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + APPID + '&secret=' + SECRET;
      const r = await httpsGet(url);
      if (!r || !r.access_token) throw new Error('获取 access_token 失败: ' + JSON.stringify(r));
      tokenCache = { token: r.access_token, expireAt: Date.now() + (r.expires_in - 300) * 1000 };
      return tokenCache.token;
    })();
    // 无论成功失败，都清掉 in-flight 标记，让下次重新发起
    tokenPromise.then(function () { tokenPromise = null; }, function () { tokenPromise = null; });
  }
  return tokenPromise;
}

/** 微信文本安全检测 v2 */
async function msgSecCheck(openid, scene, content) {
  const token = await getAccessToken();
  const url = 'https://api.weixin.qq.com/wxa/msg_sec_check?access_token=' + token;
  return httpsPostJson(url, { version: 2, openid: openid || '', scene: scene || 3, content: content });
}

/** 飞书自定义机器人签名：sign = base64(HmacSHA256(空数据, key=timestamp+"\n"+secret)) */
function feishuSign(timestamp, secret) {
  const stringToSign = String(timestamp) + '\n' + String(secret);
  return crypto.createHmac('sha256', stringToSign).update(Buffer.alloc(0)).digest('base64');
}

/** 飞书群机器人推送（未配置 URL 则跳过；带限流 + 去重防刷屏；可选签名）
 *  @param {String} text   推送正文
 *  @param {String} target 'main'（默认，违规告警群）| 'apply'（发布申请群） */
async function feishuPush(text, target) {
  const t = normTarget(target);
  let url = FEISHU_WEBHOOK_URL;
  let secret = FEISHU_WEBHOOK_SECRET;
  if (t === 'apply') {
    if (FEISHU_APPLY_WEBHOOK_URL) {
      url = FEISHU_APPLY_WEBHOOK_URL;
      secret = FEISHU_APPLY_WEBHOOK_SECRET;
    } else {
      console.warn('[secCheck] 未配置 FEISHU_APPLY_WEBHOOK_URL，申请推送回落主群');
    }
  }
  if (!url) {
    console.warn('[secCheck] 未配置 FEISHU_WEBHOOK_URL，跳过飞书推送');
    return;
  }
  const b = bucket(t);
  const now = Date.now();
  // 去重：相同内容在窗口内只推一次（防同一违规内容反复刷屏）
  if (b.seen[text] && now - b.seen[text] < PUSH_DEDUP_MS) return;
  // 去重表无界增长防护：超上限清掉最旧一半
  const keys = Object.keys(b.seen);
  if (keys.length >= PUSH_SEEN_MAX) {
    keys.slice(0, Math.floor(PUSH_SEEN_MAX / 2)).forEach(function (k) { delete b.seen[k]; });
  }
  // 限流：滚动窗口每分钟最多 PUSH_MAX_PER_MIN 条（按群各算各的）
  if (now - b.window.windowStart > 60000) b.window = { count: 0, windowStart: now };
  if (b.window.count >= PUSH_MAX_PER_MIN) {
    console.warn('[secCheck] 飞书推送限流，丢弃一条（' + t + '）:', text.slice(0, 50));
    return;
  }
  b.seen[text] = now;
  b.window.count++;
  try {
    const body = { msg_type: 'text', content: { text: text } };
    if (secret) {
      const ts = String(Math.floor(now / 1000));
      body.timestamp = ts;
      body.sign = feishuSign(ts, secret);
    }
    await httpsPostJson(url, body);
  } catch (e) {
    console.error('[secCheck] 飞书推送失败', e && e.message);
  }
}

/** 换 tenant_access_token（single-flight + 提前 300s 过期，应用 API 推送用） */
async function getTenantToken() {
  const now = Date.now();
  if (appTokenCache.token && now < appTokenCache.expireAt) return appTokenCache.token;
  if (!appTokenPromise) {
    appTokenPromise = (async function () {
      if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) throw new Error('未配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
      const r = await httpsPostJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET,
      });
      if (!r || !r.tenant_access_token) throw new Error('获取 tenant_access_token 失败: ' + JSON.stringify(r));
      appTokenCache = { token: r.tenant_access_token, expireAt: Date.now() + (r.expire - 300) * 1000 };
      return appTokenCache.token;
    })();
    appTokenPromise.then(function () { appTokenPromise = null; }, function () { appTokenPromise = null; });
  }
  return appTokenPromise;
}

/**
 * 应用 API 推送到群（自建应用 im/v1/messages，receive_id_type=chat_id）。
 * 机器人自己发的消息一定带 message_id，feishuCallback 回读父消息 100% 可用
 * → 评论区命令能准确解析出目标。未配置应用凭证/chat_id，或发送失败时返回 false（调用方回退 webhook）。
 * @param {String} target 'main'（默认）| 'apply'（发布申请群）
 * 【发布申请为什么必须走应用 API】只有应用 API 发的消息能被 feishuCallback 回读父消息文案，
 *   而「同意」/「拒绝」是两个不带参数的裸命令，必须从父消息里解析出申请人 ID。
 *   用 webhook 发的话管理员回「同意」会报"未能解析出申请人ID"。
 */
async function feishuPushApp(text, target) {
  const t = normTarget(target);
  let chatId = FEISHU_CHAT_ID;
  if (t === 'apply') {
    if (FEISHU_APPLY_CHAT_ID) {
      chatId = FEISHU_APPLY_CHAT_ID;
    } else {
      console.warn('[secCheck] 未配置 FEISHU_APPLY_CHAT_ID，申请推送回落主群（回读解析可能失效，建议尽快配置）');
    }
  }
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !chatId) return false;
  try {
    const token = await getTenantToken();
    const content = { text: String(text || '').slice(0, 2000) };
    await httpsPostJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'text', content: JSON.stringify(content) },
      { Authorization: 'Bearer ' + token }
    );
    return true;
  } catch (e) {
    console.error('[secCheck] 应用 API 推送失败，回退 webhook', e && e.message);
    return false;
  }
}

/** 构造推送文案（分类 + 内容 + 作者 + 用户ID + 命中词 + 底部命令菜单） */
function buildPush(kind, categoryLabel, keywords, content, author, userId, requestId) {
  const snippet = String(content || '').slice(0, 120);
  const isReview = kind.indexOf('待复核') >= 0;
  const state = isReview ? '内容已发布（待复核）' : '内容已拦截（未发布）';
  const lines = ['【' + kind + '】' + (categoryLabel || '')];
  lines.push('内容：' + snippet);
  if (author) lines.push('作者：' + author);
  if (userId) lines.push('用户ID：' + userId);
  if (keywords && keywords.length) lines.push('命中词：' + keywords.join('、'));
  lines.push('状态：' + state);
  if (ADMIN_EMAIL) lines.push('管理员邮箱：' + ADMIN_EMAIL);
  lines.push('requestId：' + requestId);
  lines.push('——————');
  lines.push('评论区回复：');
  lines.push('· 封禁用户 = 封禁该用户');
  lines.push('· 解封用户 = 解除黑名单（内容仍隐藏）');
  lines.push('· 全部解封 = 解除黑名单 + 恢复全部内容');
  lines.push('· 拉黑用户 = 永久拉黑该用户');
  return lines.join('\n');
}

// ============================================================
// 动态词库（管理员在小程序里追加的词）
// ============================================================
// 【与静态词表的分工】sensitiveWords.js 是随包发布的，改一次要重新部署；
//   动态词库存在 SensitiveWord 集合里，管理员加进去**不需要重新部署**就能生效。
//   静态表仍然保留：它不依赖数据库可用性，动态表读不到时会回落到它。
const WORD_COLL = 'SensitiveWord';
// 缓存时长。secCheck 在发布热路径上（每次发帖/评论都要过一次），不能每次调用都查库；
// 但也不能太长 —— 管理员刚加完词，体感上要"基本立刻生效"。
// 【60 秒是每个容器各自计的】线上有多个容器实例，所以是"最迟约一分钟后全覆盖"，
//   不是"精确 60 秒后同时生效"。要立刻验证，用下面的 action:'reloadWords'。
const BANK_TTL_MS = 60000;
const BANK_LIMIT = 300;
let _bankWords = null; // [{word, tier}]；null = 本容器还没读过
let _bankAt = 0;
// 本容器最后一次读词库的**结局**：'never' | 'ok' | 'no_db' | 'read_failed'
// 【为什么必须要它】上面三种失败都会让词库变成"空"，结果一模一样，但原因完全不同：
//   集合没建 / 集合名写错 → 读成功但 0 条（state=ok）；云函数拿不到 db → no_db；
//   集合权限或网络报错 → read_failed。没有这个字段时，运维只能看到一个 extraWords:0，
//   而**控制台看不到 console.log**（只显示入参和响应状态），等于完全没有线索。
//   见下面 action:'reloadWords' —— 它把这个字段回给调用方，让探针能自己说清原因。
let _bankState = 'never';

/**
 * 读动态词库，带 TTL 缓存。
 * 【失败一律 fail-open】读不到只是"少了一层动态防护"，静态词表还在。若这里抛出去，
 *   整个内容审核会走进外层的降级放行分支 —— 为了让一个词生效而让审核整体哑掉，
 *   代价方向是反的。
 * 【失败也刷新时间戳】否则数据库持续不可用时会变成"每次发布都去撞一次失败的查询"。
 */
async function loadExtraWords(db) {
  const now = Date.now();
  if (_bankWords && (now - _bankAt) < BANK_TTL_MS) return _bankWords;
  if (!db || !db.collection) {
    // 【这一条最容易把人卡住】拿不到 db 时静默返回空数组、**连日志都不打**。
    //   之前它会和"集合是空的"长得一模一样，所以必须记进 _bankState。
    _bankState = 'no_db';
    return _bankWords || [];
  }
  try {
    const r = await db.collection(WORD_COLL).find({}, { limit: BANK_LIMIT });
    const list = Array.isArray(r) ? r : ((r && r.result) || []);
    _bankWords = list.map(function (d) {
      return {
        word: String((d && (d.word || d._id)) || ''),
        tier: (d && d.tier) === 'review' ? 'review' : 'block',
      };
    });
    _bankAt = now;
    _bankState = 'ok'; // 注意：读到 0 条也是 'ok' —— 读通了，只是库是空的
  } catch (e) {
    console.error('[secCheck] 读动态词库失败，本次只用静态词表：', (e && e.message) || e);
    if (!_bankWords) _bankWords = [];
    _bankAt = now;
    _bankState = 'read_failed';
  }
  return _bankWords;
}

/** 清掉本容器的词库缓存（管理员加完词想立刻验证时用） */
function dropExtraWordsCache() {
  _bankWords = null;
  _bankAt = 0;
  _bankState = 'never';
}

/**
 * 把"读到几个词 + 结局"翻译成一句人话，给 action:'reloadWords' 用。
 * 【为什么要专门写它】这个探针的调用方正在排查线上问题，而这个函数**看不到日志**。
 *   一个光秃秃的 extraWords:0 会让人以为是功能坏了，实际可能只是"还没导入过词"。
 */
function bankHint(n, state) {
  if (state === 'no_db') {
    return '云函数没拿到数据库句柄（ctx.mpserverless.db 为空）——这是平台侧的异常，不是词库的问题；静态词表仍在生效';
  }
  if (state === 'read_failed') {
    return '读词库时报错了，本次只用静态词表。查 ' + WORD_COLL + ' 集合是否存在、以及集合名是否一字不差';
  }
  if (n === 0) {
    return '集合读通了但一条词都没有：确认已经在「管理员 → 审核与安全 → 敏感词库」点过「导入推荐词表」，以及集合名是不是 ' + WORD_COLL;
  }
  return '动态词库正常，已读到 ' + n + ' 条';
}

module.exports = async function (ctx) {
  // MPServerless 云函数：客户端参数在 ctx.args，返回值成为 res.result（不能用 callback）
  const event = (ctx && ctx.args) || {};
  // 每次调用生成 requestId，随返回 + 推送带出，便于关联云函数日志与飞书消息排查
  const requestId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  try {
    // ---- 轻量通知模式：举报/申诉/发布申请等只推送，不做内容检测 ----
    if (event.action === 'notify') {
      const text = String(event.text || '').slice(0, 2000);
      const target = normTarget(event.target); // 缺省/拼错一律主群
      // 优先应用 API 推送（保证评论区命令可回读解析），未配置/失败回退 webhook
      const viaApp = await feishuPushApp(text, target);
      if (!viaApp) await feishuPush(text, target);
      return { ok: true, requestId: requestId, channel: viaApp ? 'app' : 'webhook', target: target };
    }

    // ---- 运维口子：清掉本容器的动态词库缓存，让下次匹配重新查库 ----
    // 【为什么需要】缓存是每个容器各算各的 60 秒（见 BANK_TTL_MS），管理员刚加完词想立刻验证时，
    //   命中的容器不确定，等一分钟又不像"加完就生效"。这个 action 只清缓存 + 回报词数，
    //   不读内容、不写库、不回显词条本身，所以放在这个无鉴权云函数里也不构成信息泄露口。
    // 【为什么要回传 bankState】只用 extraWords 一个数字等于没有线索：
    //   集合没建（读通了但 0 条）/ 拿不到 db / 查库报错，三种都显示 0，而控制台看不到
    //   console.log。bankState 把结局编码回传，让这个探针能直接指出是哪一种。
    //   ⚠️ 它**只回标准化的状态词**，不回原始报错串（那可能带集合名等内部信息）。
    if (event.action === 'reloadWords') {
      dropExtraWordsCache();
      const db0 = (ctx && ctx.mpserverless && ctx.mpserverless.db) || null;
      const n = (await loadExtraWords(db0)).length;
      return {
        ok: true, requestId: requestId, action: 'reloadWords',
        extraWords: n, bankState: _bankState,
        bankHint: bankHint(n, _bankState),
      };
    }

    const content = String(event.content || '').slice(0, 2000);
    if (!content.trim()) return { ok: true, suggest: 'pass', requestId: requestId };

    // 1) 本地敏感词预检（先于 msgSecCheck，拦赌博暗语延迟）
    //    传 scene 给词库：仿冒官方昵称等 scene=1 专属类别只在昵称场景生效
    //    动态词库（管理员在小程序里追加的）在这里并入。一个词都没有时**不传 categories**，
    //    让 match 直接用静态表原引用 —— 走同一条零额外开销的路径，而不是每次复制一遍类别表。
    const db = (ctx && ctx.mpserverless && ctx.mpserverless.db) || null;
    const extraWords = await loadExtraWords(db);
    const local = sensitive.match(content, extraWords.length
      ? { scene: event.scene || 3, categories: sensitive.withExtraWords(sensitive.CATEGORIES, extraWords) }
      : { scene: event.scene || 3 });
    if (local.severity) {
      const suggest = local.severity === 'block' ? 'risky' : 'review';
      await feishuPush(buildPush(
        suggest === 'risky' ? '内容违规(本地词库)' : '内容待复核(本地词库)',
        local.categoryLabel, local.keywords, content, event.authorName || '', event.openid || '', requestId
      ));
      return {
        ok: true, suggest: suggest, requestId: requestId,
        category: local.category, categoryLabel: local.categoryLabel, hitKeywords: local.keywords,
        matchCostMs: local.matchCostMs, normalizedText: local.normalizedText, // 调试：定位规则误杀/评估性能
      };
    }

    // 2) 微信 msgSecCheck（v2）
    if (APPID && SECRET) {
      const r = await msgSecCheck(event.openid || '', event.scene || 3, content);
      if (r && r.errcode === 0 && r.result) {
        const suggest = r.result.suggest; // pass | review | risky
        if (suggest === 'risky' || suggest === 'review') {
          await feishuPush(buildPush(
            suggest === 'risky' ? '内容违规(msgSecCheck)' : '内容待复核(msgSecCheck)',
            '微信检测 label=' + (r.result.label != null ? r.result.label : ''),
            [], content, event.authorName || '', event.openid || '', requestId
          ));
        }
        return { ok: true, suggest: suggest, label: r.result.label, requestId: requestId };
      }
      if (r && r.errcode === 87014) { // 旧版 errcode：含违法违规内容
        await feishuPush(buildPush('内容违规(msgSecCheck)', '', [], content, event.authorName || '', event.openid || '', requestId));
        return { ok: true, suggest: 'risky', label: 87014, requestId: requestId };
      }
      // 其他 errcode（token 失效等）→ 降级放行，不阻塞发布
      console.error('[secCheck] msgSecCheck 返回异常', JSON.stringify(r));
    }

    return { ok: true, suggest: 'pass', requestId: requestId };
  } catch (e) {
    // 审核服务整体异常 → 降级放行（审核挂了不能让小程序停摆）
    console.error('[secCheck] 异常，降级放行', e && e.message);
    return { ok: true, suggest: 'pass', degrade: true, msg: String((e && e.message) || e), requestId: requestId };
  }
};

// 【测试钩子】把动态词库缓存函数挂到导出上，供 tests/secCheckBank.test.js 直接调。
// 本文件只依赖 Node 内置模块，所以能被 node require。
// 不构成线上风险：运行时只把 module.exports 当函数调用，不会读这两个属性。
module.exports.__test = {
  loadExtraWords: loadExtraWords,
  dropExtraWordsCache: dropExtraWordsCache,
  BANK_TTL_MS: BANK_TTL_MS,
  // bankState 是模块级变量，测试要读它只能通过取值函数（直接读会拿到快照）
  bankState: function () { return _bankState; },
  bankHint: bankHint,
  BANK_LIMIT: BANK_LIMIT,
};
