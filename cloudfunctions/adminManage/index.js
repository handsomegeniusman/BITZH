/**
 * 云函数 adminManage —— 管理员「列表 / 添加 / 移除」服务端执行器
 * ============================================================
 * 【为什么要有这个函数】管理员 = 集合 BITZHAdministrator 里一行 {userId, name}。
 *   前端 utils/db.js 的 initUserState() 是在**客户端**读这个集合来判断"我是不是管理员"的，
 *   而 miniprogram/config.js 里的 clientSecret 会随小程序包一起发到用户手机上，反编译即可拿到。
 *   所以：
 *     - "把密码存进数据库、提交时前端查库比对"**防不住任何真想进来的人** —— 他不必打开我们的
 *       页面，拿到 clientSecret 就能直接调数据库接口往 BITZHAdministrator 插一行，密码那一步
 *       根本不会被执行到；密码存在集合里他顺手也能读出来。
 *     - 唯一有意义的位置是**服务端**：密码放云函数环境变量，永远不进小程序包；写库也在这里做。
 *
 * 【两道锁，但第二道锁的成色要实测才知道（重要）】
 *   第一道：调用者本身必须是现有管理员 —— 依赖 resolveCallerId() 能否**独立确认**调用者身份
 *           （ctx.mpserverless.user.getInfo()）。阿里云文档说云函数里可以这样取，但本项目此前的
 *           云函数（secCheck）一直是信任客户端传来的 openid，所以**读代码无法判定，必须实测**。
 *           实测办法见 action='whoami'。
 *   第二道：密码（服务端环境变量，timingSafeEqual 比对）。
 *   两道锁是否都成立，由返回里的 identityMode 如实标注，并且页面会把 untrusted 显示成红色提醒条 ——
 *   不许让人误以为有两把锁。
 *
 * 【这个函数挡不住的事（必须写清楚，别让人误以为已经安全）】
 *   客户端仍然可以用 clientSecret 绕过本函数直写 BITZHAdministrator。要堵这个只能去 MPServerless
 *   控制台给集合开"权限校验 + 规则"，把客户端的写权限收走（但**必须保留客户端读权限**，否则
 *   initUserState 拿不到管理员判定，全站后台一起失效）。步骤见 README 第六.5 节。
 *
 * 【接口】ctx.args：
 *   { action:'list',   password? }                     → 管理员列表（身份不可信时必须带密码）
 *   { action:'grant',  userId, name?, password }       → 设为管理员
 *   { action:'revoke', userId, password }              → 移除管理员
 *   { action:'whoami', password }                      → 诊断身份来源（实测第一道锁用）
 *   { action:'list'|'grant'|'revoke', callerId? }      → callerId 仅作为身份不可信时的降级来源
 *   返回 { ok:true, ... } 或 { ok:false, code, msg }；异常兜底不抛。
 */
'use strict';
const crypto = require('crypto');

// 管理员名单集合（与 utils/db.js 的 initUserState 一致，改名要两边一起改）
const ADMIN_COLL = 'BITZHAdministrator';
// 已注册用户集合（添加管理员前必须确认对方已注册）
const FEEDER_COLL = 'Feeder';
// 密码失败计数集合（防暴力猜密码）
const AUTHFAIL_COLL = 'AdminAuthFail';
// 管理员列表一次最多取多少条（也是 revoke 的"最后一位"判据所依赖的上界）
const ADMIN_LIST_LIMIT = 200;

// ============================================================
// 配置：优先控制台环境变量 process.env，EMAS 无环境变量入口时用随函数部署的 config.js 兜底
// 【注意】必须在**函数体内**调用 getCfg，不能在模块顶层定值 ——
//   顶层定值会让密码在 require 时就固化，测试就无法用 process.env 注入了（moderate 是顶层定值的，
//   这里是刻意不同）。
// ============================================================
let CFG = {};
try { CFG = require('./config.js') || {}; } catch (e) { /* 无 config.js 时忽略 */ }
function getCfg(name) { return process.env[name] || CFG[name] || ''; }

/** 读一个正整数配置项，非法/缺失时用默认值 */
function numCfg(name, def) {
  const v = Number(getCfg(name));
  return (isFinite(v) && v > 0) ? v : def;
}

// ---- 集合/结果的小工具（与 moderate/index.js 同款）----

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

/** user id 脱敏（日志里只出现前后几位，配合"绝不记密码"一起用） */
function maskId(id) {
  const s = String(id || '');
  if (!s) return '';
  if (s.length <= 8) return s.slice(0, 2) + '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

/** 日志用的 event 副本：**删掉 password 字段**。
 *  所有日志一律走这里，禁止直接 JSON.stringify(event) —— 那是密码泄漏最常见的一条路。 */
function safeEvent(event) {
  const out = {};
  Object.keys(event || {}).forEach(function (k) { if (k !== 'password') out[k] = event[k]; });
  return out;
}

/** 时间格式化（Date → "YYYY-MM-DD HH:mm"），脏值返回空串 */
function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 姓名清洗（云函数不能 require miniprogram/utils/guard.js，这里内联一份）：
 *  去控制字符/空白、去掉 ".."、截断 20 字；清完为空则用 fallback。 */
function sanitizeName(v, fallback) {
  let s = String(v == null ? '' : v);
  s = s.replace(/[\u0000-\u001f\u007f]/g, ''); // 控制字符（含 DEL）
  s = s.replace(/\s+/g, '');                    // 所有空白
  s = s.replace(/\.\./g, '');                   // 防路径穿越（姓名会进 COS 文件名的地方要留意）
  // 【按码点截断，不用 slice】姓名现在是人工输入的，可能含 emoji/生僻字（代理对，.length 为 2）。
  //   按 UTF-16 码元 slice 会把代理对劈成两半，写出一个孤立代理项 —— 存进库里就是一个"碎掉"的字符，
  //   而且页面上看不出它是怎么来的。Array.from 按码点切，不会劈开。
  s = Array.from(s).slice(0, 20).join('');
  if (!s) s = String(fallback == null ? '' : fallback);
  return s;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// ============================================================
// 身份解析：这是"第一道锁"的根基，也是本函数最需要实测的一处
// ============================================================

/** 从 getInfo 的三种可能返回形状里取出 userId：
 *  {result:{user:{userId}}} / {result:{userId}} / {user:{userId}} / {userId} */
function pickUserId(r) {
  const cands = [r && r.result && r.result.user, r && r.result, r && r.user, r];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (c && typeof c.userId === 'string' && c.userId) return c.userId;
  }
  return '';
}

/**
 * 解析调用者身份。
 * @returns {{id:string, trusted:boolean, via:string, error:string}}
 *   trusted=true  → id 由服务端独立确认，第一道锁成立
 *   trusted=false → id 来自客户端自报（**可伪造**），此时密码成为唯一真实门槛
 *
 * 【环境变量】
 *   ADMIN_TRUST_CALLER_ID=1 → 已确认可信路径可用，**拒绝降级**到客户端自报（拿不到就当没身份）。
 *                             实测出 trusted 之后建议设成 1，彻底关掉可伪造的分支。
 *   ADMIN_TRUST_CALLER_ID=0 → 强制按"不可信"处理（id 仍取可信来源，只是不给 trusted 标记）。
 *                             用于在能取到可信身份的机器上模拟/验证单锁路径（此时 list 也要密码）。
 */
async function resolveCallerId(ctx) {
  const mode = String(getCfg('ADMIN_TRUST_CALLER_ID') || '').trim();
  const claimed = String((ctx && ctx.args && ctx.args.callerId) || '').trim();

  let trustedId = '';
  let err = '';
  const user = ctx && ctx.mpserverless && ctx.mpserverless.user;
  if (user && typeof user.getInfo === 'function') {
    try {
      trustedId = pickUserId(await user.getInfo());
      if (!trustedId) err = 'getInfo 返回里没有 userId';
    } catch (e) {
      err = String((e && e.message) || e);
      console.warn('[adminManage] 服务端身份获取失败：' + err);
    }
  } else {
    err = 'ctx.mpserverless.user.getInfo 不存在';
  }

  if (mode === '0') {
    const id = trustedId || claimed;
    return {
      id: id,
      trusted: false,
      via: trustedId ? 'getInfo(按配置降级)' : (claimed ? 'ctx.args.callerId' : 'none'),
      error: err,
    };
  }
  if (trustedId) {
    return { id: trustedId, trusted: true, via: 'ctx.mpserverless.user.getInfo', error: '' };
  }
  if (mode === '1') {
    // 配了"只认服务端身份"却没拿到 → 硬失败，不给降级机会
    return { id: '', trusted: false, via: 'none', error: err || '配置要求服务端身份，但不可用' };
  }
  if (claimed) {
    console.warn('[adminManage] 退回客户端自报身份（可伪造）：' + maskId(claimed));
    return { id: claimed, trusted: false, via: 'ctx.args.callerId', error: err };
  }
  return { id: '', trusted: false, via: 'none', error: err };
}

// ============================================================
// 密码校验（第二道锁）
// ============================================================

/** 服务端配置的密码摘要（64 位 hex）；没配返回空串。
 *  二选一：ADMIN_PASSWORD（明文）或 ADMIN_PASSWORD_SHA256（摘要，可让明文只存在于密码管理器里）。 */
function passwordDigestConfigured() {
  const direct = String(getCfg('ADMIN_PASSWORD_SHA256') || '').trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(direct)) return direct;
  const plain = String(getCfg('ADMIN_PASSWORD') || '');
  return plain ? sha256Hex(plain) : '';
}

/**
 * 比对密码。
 * 【为什么比摘要不比明文】两边都定长 32 字节，timingSafeEqual 就不会因长度不等抛
 *   ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH；而且长度差异本身也不再是侧信道。
 * 【为什么没配密码是失败而不是放行】忘了配环境变量应该得到一个"哑掉"的模块，
 *   而不是一个"空密码就能进"的模块 —— 这是本文件最重要的一条。
 */
function verifyPassword(input) {
  const want = passwordDigestConfigured();
  if (!want) {
    return { ok: false, code: 'NO_PASSWORD_CONFIG', msg: '服务端未配置管理员密码（ADMIN_PASSWORD），请在云函数环境变量或同目录 config.js 里配置后重新部署' };
  }
  const a = Buffer.from(want, 'hex');
  const b = Buffer.from(sha256Hex(input == null ? '' : String(input)), 'hex');
  if (a.length !== b.length) return { ok: false, code: 'BAD_PASSWORD', msg: '密码错误' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, code: 'BAD_PASSWORD', msg: '密码错误' };
}

// ---- 失败计数与锁定 ----
// 存 AdminAuthFail 集合；集合不可用时降级为单容器内存（弱：容器会回收、多实例不共享），
// 只 console.error 一次，不抛 —— 锁失效好过整个模块崩掉。
const memFails = new Map();
let failCollBroken = false;

/** 锁定键：IP 由服务端派生、**不可伪造**，是必有的那一把；可信身份时再加一把用户维度。 */
function lockKeys(ctx, caller) {
  const keys = [];
  const ip = (ctx && ctx.env && ctx.env.MP_CLIENT_IP) || '';
  if (ip) keys.push('ip:' + ip);
  if (caller && caller.trusted && caller.id) keys.push('uid:' + caller.id);
  if (!keys.length) keys.push('anon');
  return keys;
}

async function failGet(db, key) {
  if (!failCollBroken) {
    try {
      const list = toList(await col(db, AUTHFAIL_COLL).find({ _id: key }, { limit: 1 }));
      return list[0] || null;
    } catch (e) {
      failCollBroken = true;
      console.error('[adminManage] AdminAuthFail 集合不可用，密码锁定降级为单容器内存（建议在控制台建好该集合）：', (e && e.message) || e);
    }
  }
  return memFails.get(key) || null;
}

async function failSet(db, key, patch) {
  if (!failCollBroken) {
    try {
      // 与 moderate 的 ReportAgg 同一套 upsert 写法（已验证该 SDK 支持第三参 upsert）
      await col(db, AUTHFAIL_COLL).updateOne({ _id: key }, { $set: patch, $setOnInsert: { _id: key } }, { upsert: true });
      return;
    } catch (e) {
      failCollBroken = true;
      console.error('[adminManage] AdminAuthFail 写入失败，降级为单容器内存：', (e && e.message) || e);
    }
  }
  const cur = memFails.get(key) || {};
  memFails.set(key, Object.assign({}, cur, patch));
}

/** 当前是否处于锁定期；返回还需等待的毫秒数（0 = 没锁） */
async function lockedRemainMs(db, keys) {
  const now = Date.now();
  let max = 0;
  for (let i = 0; i < keys.length; i++) {
    const d = await failGet(db, keys[i]);
    const u = (d && Number(d.lockUntil)) || 0;
    if (u > now) max = Math.max(max, u - now);
  }
  return max;
}

/** 记一次失败；达到阈值则写 lockUntil（并把计数归零 —— 固定冷却，不被后续探测延长） */
async function failBump(db, key, maxFails, lockMs) {
  const cur = await failGet(db, key);
  const cnt = ((cur && Number(cur.failCount)) || 0) + 1;
  const locking = cnt >= maxFails;
  const now = Date.now();
  await failSet(db, key, {
    failCount: locking ? 0 : cnt,
    lastFailAt: new Date(now),
    lockUntil: locking ? now + lockMs : 0,
  });
  return locking ? lockMs : 0;
}

async function failReset(db, keys) {
  for (let i = 0; i < keys.length; i++) {
    await failSet(db, keys[i], { failCount: 0, lockUntil: 0 });
  }
}

/** 带锁定的密码校验。**先查锁再比对** —— 锁定期内即使密码正确也拒绝，否则锁定形同虚设。 */
async function checkPassword(ctx, db, input, caller) {
  if (!passwordDigestConfigured()) {
    return { ok: false, code: 'NO_PASSWORD_CONFIG', msg: '服务端未配置管理员密码（ADMIN_PASSWORD），请在云函数环境变量或同目录 config.js 里配置后重新部署' };
  }
  const keys = lockKeys(ctx, caller);
  const lockMs = numCfg('PW_LOCK_MS', 600000); // 默认 10 分钟

  const remain = await lockedRemainMs(db, keys);
  if (remain > 0) {
    const mins = Math.max(1, Math.ceil(remain / 60000));
    return { ok: false, code: 'LOCKED', msg: '密码错误次数过多，请 ' + mins + ' 分钟后重试', retryAfterMs: remain };
  }

  const v = verifyPassword(input);
  if (v.ok) {
    await failReset(db, keys);
    return { ok: true };
  }

  const maxFails = numCfg('PW_MAX_FAILS', 5);
  let lockedFor = 0;
  for (let i = 0; i < keys.length; i++) {
    const l = await failBump(db, keys[i], maxFails, lockMs);
    if (l) lockedFor = l;
  }
  if (lockedFor) {
    const mins = Math.max(1, Math.ceil(lockedFor / 60000));
    return { ok: false, code: 'LOCKED', msg: '密码错误次数过多，请 ' + mins + ' 分钟后重试', retryAfterMs: lockedFor };
  }
  return v;
}

// ============================================================
// 动作
// ============================================================

async function loadAdmins(db) {
  return toList(await col(db, ADMIN_COLL).find({}, { limit: ADMIN_LIST_LIMIT }));
}

/** 用户ID 形态校验：把畸形字符串挡在数据库过滤器之外（本项目的用户ID 是 24 位空间用户 ID） */
function badUserId(userId) {
  return !/^[A-Za-z0-9_-]{8,64}$/.test(userId);
}

const MSG_LAST_ADMIN = '不能移除最后一位管理员（会锁死后台，只能去控制台手工恢复）';
const MSG_SELF_REVOKE = '不能移除自己，请让另一位管理员操作';

/** 管理员列表（补上昵称/头像，方便页面直接渲染） */
async function doList(db, admins, caller, identityMode) {
  const ids = admins.map(function (a) { return a && a.userId; }).filter(Boolean);
  let fmap = {};
  if (ids.length) {
    try {
      const feeders = toList(await col(db, FEEDER_COLL).find({ userId: { $in: ids } }, { limit: ADMIN_LIST_LIMIT }));
      feeders.forEach(function (f) { if (f && f.userId) fmap[f.userId] = f; });
    } catch (e) {
      // Feeder 里没有对应记录是**正常**的（手工插进控制台的管理员可能从没注册过），不影响列表
      console.warn('[adminManage] 补用户资料失败（不影响列表）', (e && e.message) || e);
    }
  }
  const rows = admins.map(function (a) {
    const uid = (a && a.userId) || '';
    const f = fmap[uid] || {};
    return {
      userId: uid,
      name: (a && a.name) || '',
      nickName: f.nickName || '',
      avatarUrl: f.avatarUrl || '',
      isSelf: !!caller.id && uid === caller.id,
      grantedTimeText: fmtTime(a && a.grantedTime),
    };
  });
  return { ok: true, action: 'list', admins: rows, total: rows.length, identityMode };
}

/** 添加管理员 */
async function doGrant(db, admins, caller, identityMode, event) {
  const userId = String(event.userId == null ? '' : event.userId).trim();
  if (badUserId(userId)) return { ok: false, code: 'BAD_USER_ID', msg: '用户ID 格式不正确' };

  // 【顺序很要紧】"他已经是管理员吗"必须在查 Feeder 之前问。
  //   反过来的话，一个在控制台手工插进去的管理员（Feeder 里没有对应资料）会被判成
  //   「该用户未注册，不能设为管理员」—— 对一个**已经是管理员**的人说这句话是纯粹的误导，
  //   而且这正是"重复点一次添加"最常见的场景。
  const existing = admins.filter(function (a) { return a && a.userId === userId; });
  if (existing.length) {
    // 已是管理员 → 不写库、不覆盖（保留原有的 name 与授予时间）
    return { ok: true, action: 'grant', userId: userId, name: existing[0].name || '', already: true, identityMode };
  }

  // 上限判定也放在 existing 之后：已经是管理员的人不该因为"人满了"而被报错
  const maxAdmins = numCfg('MAX_ADMINS', 20);
  if (admins.length >= maxAdmins) {
    return { ok: false, code: 'TOO_MANY', msg: '管理员数量已达上限（' + maxAdmins + ' 人）' };
  }

  // 必须是已注册用户：避免手抖写错一个 ID 就凭空多出一个永远登不上的管理员
  let feeders;
  try {
    feeders = toList(await col(db, FEEDER_COLL).find({ userId: userId }, { limit: 1 }));
  } catch (e) {
    // 【为什么与 NOT_FEEDER 分开】moderate 把"查不到"和"查询失败"合并成同一个错误码了，
    // 排查问题时这种合并很要命（数据库抖了一下会被当成"这人没注册"）。管理员工具里分开。
    return { ok: false, code: 'LOOKUP_FAILED', msg: '用户资料查询失败，请重试' };
  }
  if (!feeders.length) return { ok: false, code: 'NOT_FEEDER', msg: '该用户未注册，不能设为管理员' };

  const name = sanitizeName(event.name, sanitizeName(feeders[0].nickName, '管理员'));
  await col(db, ADMIN_COLL).insertOne({
    userId: userId,
    name: name,
    // 审计字段：对 initUserState 只读 name 无影响。grantedByTrusted=false 表示这次授予是在
    // "调用者身份不可信"的情况下发生的，日后在控制台一眼就能看出可疑的越权授予。
    grantedBy: caller.id,
    grantedByTrusted: !!caller.trusted,
    grantedTime: new Date(),
  });
  console.log('[adminManage] grant ok caller=' + maskId(caller.id) + ' trusted=' + !!caller.trusted +
    ' target=' + maskId(userId) + ' name=' + name);
  return { ok: true, action: 'grant', userId: userId, name: name, already: false, identityMode };
}

/** 移除管理员（带两道防锁死保护） */
async function doRevoke(db, admins, caller, identityMode, event) {
  const userId = String(event.userId == null ? '' : event.userId).trim();
  if (badUserId(userId)) return { ok: false, code: 'BAD_USER_ID', msg: '用户ID 格式不正确' };
  if (admins.length <= 1) return { ok: false, code: 'LAST_ADMIN', msg: MSG_LAST_ADMIN };
  if (userId === caller.id) return { ok: false, code: 'SELF_REVOKE', msg: MSG_SELF_REVOKE };

  const removed = admins.filter(function (a) { return a && a.userId === userId; })[0];
  if (!removed) {
    return { ok: true, action: 'revoke', userId: userId, already: true, identityMode };
  }

  await col(db, ADMIN_COLL).deleteOne({ userId: userId });

  // 竞态补偿：两个管理员同时移除对方时，两次请求都可能通过上面那条 last-admin 判定，
  // 结果把人清空了。本 DB 层没有多文档事务（这也是为什么只能做"尽力而为"），
  // 所以删完再数一次，发现归零就把刚删的那条插回去。极端交错下仍可能短暂出现零管理员，
  // 真发生了的恢复途径是去控制台手工插一条。
  const rest = await loadAdmins(db);
  if (!rest.length) {
    try {
      await col(db, ADMIN_COLL).insertOne({
        userId: userId,
        name: removed.name || '',
        grantedTime: new Date(),
        restoredFromRace: true,
      });
      console.warn('[adminManage] 检测到并发移除导致管理员清空，已回插 ' + maskId(userId));
    } catch (e) {
      console.error('[adminManage] 竞态回插失败，后台可能已无管理员！请立刻去控制台手工插入一条', (e && e.message) || e);
    }
    return { ok: false, code: 'LAST_ADMIN', msg: MSG_LAST_ADMIN };
  }

  // 移除操作没有文档可以附加审计字段了，审计信息只落在日志里
  console.log('[adminManage] revoke ok caller=' + maskId(caller.id) + ' trusted=' + !!caller.trusted +
    ' target=' + maskId(userId));
  return { ok: true, action: 'revoke', userId: userId, already: false, identityMode };
}

/** 身份诊断：用来实测"第一道锁"到底成不成立。**本身要密码**，所以可以长期留着，不会成为后门。 */
async function doWhoami(ctx, db, caller, event) {
  const pw = await checkPassword(ctx, db, event.password, caller);
  if (!pw.ok) return pw;

  const env = (ctx && ctx.env) || {};
  const claimed = String(event.callerId || '').trim();
  const out = {
    ok: true,
    action: 'whoami',
    identityMode: caller.trusted ? 'trusted' : 'untrusted',
    trustedIdPresent: !!(caller.trusted && caller.id),
    trustedIdMatchesClaim: !!(caller.trusted && caller.id && claimed === caller.id),
    via: caller.via,
    getInfoOk: !!caller.trusted,
    getInfoError: caller.error || '',
    // 【只回显这两个平台变量】它们由 MPServerless 注入、不含任何密钥，且正是排查
    //   "请求到底从哪来 / 锁定键算得对不对"的依据。除它们以外，**任何环境变量的值都不回显**：
    //   ADMIN_PASSWORD 就躺在同一个 env 里，多回显一个字段就是多一条泄漏路径。
    clientIp: env.MP_CLIENT_IP || '',
    mpSource: env.MP_SOURCE || '',
  };
  // 具体 ID 只在一次性诊断开关下回显，测完把 ADMIN_DIAG 改回 0 重新发布
  if (String(getCfg('ADMIN_DIAG') || '') === '1') {
    out.trustedId = caller.trusted ? caller.id : '';
    // 只列**键名**（里面会包含 ADMIN_PASSWORD 这个名字，这是合理的：知道"配了"不代表知道"是什么"）
    out.envKeys = Object.keys(env);
  }
  return out;
}

// ============================================================
// 路由
// ============================================================

async function handle(ctx, event) {
  const db = ctx && ctx.mpserverless && ctx.mpserverless.db;
  if (!db || !db.collection) return { ok: false, msg: '无数据库访问 (ctx.mpserverless.db)' };

  const action = String(event.action || '');
  const caller = await resolveCallerId(ctx);

  if (action === 'whoami') return await doWhoami(ctx, db, caller, event);

  if (action !== 'list' && action !== 'grant' && action !== 'revoke') {
    return { ok: false, msg: '未知 action: ' + event.action };
  }

  // ---- 第一道锁：调用者本身必须是现有管理员 ----
  if (!caller.id) {
    return { ok: false, code: 'NO_IDENTITY', msg: '无法确认你的身份，请退出小程序重新进入后再试' };
  }
  const admins = await loadAdmins(db);
  if (!admins.some(function (a) { return a && a.userId === caller.id; })) {
    return { ok: false, code: 'NOT_ADMIN', msg: '你不是管理员，无权进行此操作' };
  }
  const identityMode = caller.trusted ? 'trusted' : 'untrusted';

  // ---- 第二道锁：密码 ----
  // list 只在身份不可信时才要密码：可信时"是不是管理员"已由服务端独立确认，读个名单不必再输一次；
  // 不可信时那道锁是自报的，所以必须用密码补上。
  if (action !== 'list' || !caller.trusted) {
    const pw = await checkPassword(ctx, db, event.password, caller);
    if (!pw.ok) return pw;
  }

  if (action === 'list') return await doList(db, admins, caller, identityMode);
  if (action === 'grant') return await doGrant(db, admins, caller, identityMode, event);
  return await doRevoke(db, admins, caller, identityMode, event);
}

module.exports = async function (ctx) {
  const event = (ctx && ctx.args) || {};
  try {
    return await handle(ctx, event);
  } catch (e) {
    // 日志里只能用 safeEvent（去掉 password），绝不整份打 event
    console.error('[adminManage] 执行失败', safeEvent(event).action, (e && e.message) || e);
    return { ok: false, msg: String((e && e.message) || e) };
  }
};

// 纯函数挂到导出上供测试直接调用（先例：feishuCallback 导出 parseCommand）。
// 【注意】绝不导出密码摘要本身。
module.exports.resolveCallerId = resolveCallerId;
module.exports.verifyPassword = verifyPassword;
module.exports.passwordDigestConfigured = passwordDigestConfigured;
module.exports.sanitizeName = sanitizeName;
module.exports.sha256Hex = sha256Hex;
module.exports.getCfg = getCfg;
/** 仅供测试：清掉模块级状态（内存降级计数、集合不可用标记） */
module.exports.__resetState = function () {
  memFails.clear();
  failCollBroken = false;
};

/**
 * 仅供测试：替换 config.js 兜底配置。
 * 【为什么必须有】一旦真机部署把真实密码写进 config.js，getCfg 的 `process.env[name] || CFG[name]`
 *   就会在"环境变量被删掉"时落到文件里的真实密码上 —— 于是"没配密码 → NO_PASSWORD_CONFIG"
 *   这类用例会被顶成 BAD_PASSWORD，测试结果开始取决于**本机 config.js 的内容**，
 *   在别人的机器上（config.js 为空）就又变回通过。这种"看运气"的绿灯比红灯更糟。
 *   所以测试会在开头显式把这个兜底清空，让用例只受 process.env 控制。
 */
module.exports.__setCfg = function (obj) { CFG = obj || {}; };
