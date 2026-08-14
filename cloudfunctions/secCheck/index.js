/**
 * 云函数 secCheck —— 内容安全审核（服务端唯一安全边界）
 * ============================================================
 * 【作用】小程序 UGC（推文/评论/昵称）写库前的服务端审核：
 *    1. 本地敏感词预检（拦 msgSecCheck 识别滞后的赌博暗语等）
 *    2. 调微信 security.msgSecCheck（v2）文本检测
 *    3. 命中「疑似/违规」时，发飞书群机器人 Webhook 通知管理员
 *    4. action='notify' 时只做推送（举报/申诉等轻量通知复用本函数）
 *
 * 【部署】新建云函数 secCheck（Node.js 运行时），粘贴本文件 + sensitiveWords.js 即可运行。
 *        所有密钥（AppID/AppSecret/飞书机器人/管理员邮箱）都通过「环境变量」配置，
 *        代码里不硬编码任何真实值（避免误提交到公开仓库泄露）。
 *        本函数只用 Node 内置 https/url/crypto，无需 npm install。
 *
 * 【安全】appid/secret 只存环境变量，绝不下放前端。
 * 【降级】审核服务异常时返回 pass（放行），不让审核故障阻塞正常发布。
 */
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const sensitive = require('./sensitiveWords.js');

// 密钥：全部从「环境变量」读取，代码里绝不硬编码真实值。
// 缺省为空串（未配置时对应能力自动降级，不影响其它功能）。
// 请在云函数控制台配置：WX_APPID / WX_SECRET / FEISHU_WEBHOOK_URL / FEISHU_WEBHOOK_SECRET / ADMIN_EMAIL
const APPID = process.env.WX_APPID || '';
const SECRET = process.env.WX_SECRET || '';
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL || '';
const FEISHU_WEBHOOK_SECRET = process.env.FEISHU_WEBHOOK_SECRET || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

// ---------- access_token 缓存（single-flight，防并发重复刷新） ----------
// 说明：云函数并发执行，多请求同时发现 token 过期时会各刷一次 → 被微信限流。
//      用「共享 in-flight Promise」保证同一时刻只有一个刷新请求，其余 await 同一结果。
let tokenCache = { token: null, expireAt: 0 };
let tokenPromise = null; // 进行中的刷新请求（single-flight）

// ---------- 飞书推送限流/去重（防刷帖把群刷爆） ----------
const PUSH_MAX_PER_MIN = 30;   // 每分钟最多推送条数（超出丢弃 + 告警日志）
const PUSH_DEDUP_MS = 60000;   // 相同内容去重窗口（60s）
const PUSH_SEEN_MAX = 200;     // 去重表上限，超过清理最旧，防内存无界增长
let pushWindow = { count: 0, windowStart: 0 };
const pushSeen = {};           // text -> 上次推送时间戳

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

function httpsPostJson(url, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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

/** 飞书群机器人推送（未配置 URL 则跳过；带限流 + 去重防刷屏；可选签名） */
async function feishuPush(text) {
  if (!FEISHU_WEBHOOK_URL) {
    console.warn('[secCheck] 未配置 FEISHU_WEBHOOK_URL，跳过飞书推送');
    return;
  }
  const now = Date.now();
  // 去重：相同内容在窗口内只推一次（防同一违规内容反复刷屏）
  if (pushSeen[text] && now - pushSeen[text] < PUSH_DEDUP_MS) return;
  // 去重表无界增长防护：超上限清掉最旧一半
  const keys = Object.keys(pushSeen);
  if (keys.length >= PUSH_SEEN_MAX) {
    keys.slice(0, Math.floor(PUSH_SEEN_MAX / 2)).forEach(function (k) { delete pushSeen[k]; });
  }
  // 限流：滚动窗口每分钟最多 PUSH_MAX_PER_MIN 条
  if (now - pushWindow.windowStart > 60000) pushWindow = { count: 0, windowStart: now };
  if (pushWindow.count >= PUSH_MAX_PER_MIN) {
    console.warn('[secCheck] 飞书推送限流，丢弃一条:', text.slice(0, 50));
    return;
  }
  pushSeen[text] = now;
  pushWindow.count++;
  try {
    const body = { msg_type: 'text', content: { text: text } };
    if (FEISHU_WEBHOOK_SECRET) {
      const ts = String(Math.floor(now / 1000));
      body.timestamp = ts;
      body.sign = feishuSign(ts, FEISHU_WEBHOOK_SECRET);
    }
    await httpsPostJson(FEISHU_WEBHOOK_URL, body);
  } catch (e) {
    console.error('[secCheck] 飞书推送失败', e && e.message);
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
  lines.push('· 解封用户 = 解封该用户');
  lines.push('· 拉黑用户 = 永久拉黑该用户');
  return lines.join('\n');
}

module.exports = async function (ctx) {
  // MPServerless 云函数：客户端参数在 ctx.args，返回值成为 res.result（不能用 callback）
  const event = (ctx && ctx.args) || {};
  // 每次调用生成 requestId，随返回 + 推送带出，便于关联云函数日志与飞书消息排查
  const requestId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  try {
    // ---- 轻量通知模式：举报/申诉等只推送，不做内容检测 ----
    if (event.action === 'notify') {
      await feishuPush(String(event.text || '').slice(0, 2000));
      return { ok: true, requestId: requestId };
    }

    const content = String(event.content || '').slice(0, 2000);
    if (!content.trim()) return { ok: true, suggest: 'pass', requestId: requestId };

    // 1) 本地敏感词预检（先于 msgSecCheck，拦赌博暗语延迟）
    const local = sensitive.match(content);
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
