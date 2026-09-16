/**
 * 云函数 postApply —— 普通用户「申请发布权限」
 * ============================================================
 * 【背景】发布权限收紧成"申请-审批制"后：已注册用户在「我的」页点「申请发送帖子」，
 *   本函数写一条申请记录并推卡片到飞书的新群，管理员在小程序或飞书群里批准，
 *   批准后 Feeder.canPost = true（写入动作在 adminManage 的 applyDecision，不在这里）。
 *
 * 【为什么身份必须服务端派生、取不到就硬失败】
 *   本函数在 MPServerless 云函数里跑，`ctx.mpserverless.user.getInfo()` 能拿到**真实调用者**。
 *   而客户端自报的 userId 是可以随便填的 —— 一旦接受它，任何人都能替别人刷申请，
 *   还能绕过"一天只能申请一次"（换个 id 就是新的一天）。所以这里**刻意不设客户端兜底**，
 *   拿不到身份就返回 NO_IDENTITY，宁可这个功能暂时不能申请。
 *   （先例：adminManage 的 resolveCallerId，本项目已实测该接口可用、identityMode=trusted。）
 *
 * 【一天只能申请一次怎么做到原子的】
 *   申请记录的 `_id` 就是 `<userId>_<北京时间日期>`。同一天再申请时 insertOne 会因主键
 *   冲突失败 —— 一个原子操作，不需要事务（本 DB 层没有多文档事务）。
 *   同一手法本仓已在用：moderate/index.js 的 ModerateOps.insertOne({_id: opId})，
 *   `_id` 冲突视为已处理。
 *
 * 【接口】ctx.args：
 *   { action:'apply' }   → 提交申请（其余参数一律忽略，只认服务端派生的身份）
 *   返回 { ok:true, code:'PENDING' } 或 { ok:false, code, msg }；异常兜底不抛。
 *
 * 【这个函数挡不住的事】
 *   客户端仍可用 clientSecret 绕过本函数直写 PostApply / Feeder。真正的收口是控制台集合
 *   权限规则（README 第七节），但 regist.js 目前就在客户端写 Feeder，收口会打断注册流程，
 *   本期不做。详见 README。
 */
'use strict';

// 已注册用户集合
const FEEDER_COLL = 'Feeder';
// 黑名单集合
const BLACK_COLL = 'BlackNum';
// 发布申请集合（_id = userId_日期）
const APPLY_COLL = 'PostApply';
// 推送目标：secCheck 的 normTarget 白名单里 'apply' 指向"发布申请"新群
const PUSH_TARGET = 'apply';

// ============================================================
// 配置：优先控制台环境变量 process.env，EMAS 无环境变量入口时用随函数部署的 config.js 兜底
// 【必须在函数体内调用 getCfg】顶层定值会让配置在 require 时固化，测试无法用 process.env 注入。
// ============================================================
let CFG = {};
try { CFG = require('./config.js') || {}; } catch (e) { /* 无 config.js 时忽略 */ }
function getCfg(name) { return process.env[name] || CFG[name] || ''; }

function col(db, name) {
  if (!db || !db.collection) throw new Error('无数据库访问 (ctx.mpserverless.db)');
  return db.collection(name);
}

/** find 结果归一化成数组：兼容直接返回数组或 {result:[...]} 两种形态 */
function toList(r) {
  if (Array.isArray(r)) return r;
  return (r && r.result) || [];
}

/** user id 脱敏（日志里只出现前后几位） */
function maskId(id) {
  const s = String(id || '');
  if (!s) return '';
  if (s.length <= 8) return s.slice(0, 2) + '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

/**
 * 北京时间当天键（YYYY-MM-DD）。
 * 【为什么要自己算】云函数容器是 UTC：`new Date().toISOString().slice(0,10)` 会在
 *   北京时间早上 8 点翻日，于是"一天只能申请一次"的边界会落在早上 8 点而不是零点。
 * 【与 adminManage 里的同名函数逐字相同 —— 刻意复制，别顺手重构】
 *   云函数各自独立打包，跨目录 require 在这里不可用。要改就两边一起改。
 */
function beijingDayKey(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 从 getInfo 的几种可能返回形状里取出 userId（与 adminManage.pickUserId 同款）。
 * {result:{user:{userId}}} / {result:{userId}} / {user:{userId}} / {userId}
 */
function pickUserId(r) {
  const cands = [r && r.result && r.result.user, r && r.result, r && r.user, r];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (c && typeof c.userId === 'string' && c.userId) return c.userId;
  }
  return '';
}

/**
 * 服务端派生调用者身份。**取不到就返回空串**，绝不退回客户端自报（理由见文件头）。
 * @returns {Promise<{id:string, error:string}>}
 */
async function resolveUserId(ctx) {
  const user = ctx && ctx.mpserverless && ctx.mpserverless.user;
  if (!user || typeof user.getInfo !== 'function') {
    return { id: '', error: 'ctx.mpserverless.user.getInfo 不存在' };
  }
  try {
    const id = pickUserId(await user.getInfo());
    return id ? { id: id, error: '' } : { id: '', error: 'getInfo 返回里没有 userId' };
  } catch (e) {
    return { id: '', error: String((e && e.message) || e) };
  }
}

/** 飞书推送卡片正文。**申请人ID 必须独立成行、行首写「申请人ID：」** ——
 *  feishuCallback 的 extractApplicantId 是按行首锚定的正则解析这一行的，
 *  改格式必须两边一起改，否则管理员回「同意」会报"未能解析出申请人ID"。 */
function buildCard(opt) {
  return [
    '【发布申请】',
    '有用户申请发布权限，回复「同意」或「拒绝」。',
    '',
    '申请人ID：' + opt.userId,
    '昵称：' + (opt.nickName || '（无昵称）'),
    '申请时间：' + opt.timeText,
  ].join('\n');
}

/** 北京时间 "YYYY-MM-DD HH:mm"（云函数容器是 UTC，必须手动 +8） */
function beijingTimeText(d) {
  const b = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate()) +
    ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes());
}

module.exports = async function (ctx) {
  const event = (ctx && ctx.args) || {};
  const db = ctx && ctx.mpserverless && ctx.mpserverless.db;
  const action = String(event.action || '');

  try {
    if (action !== 'apply') {
      return { ok: false, code: 'UNKNOWN_ACTION', msg: '未知 action: ' + action };
    }

    // ===== 1) 身份（服务端派生，拿不到就硬失败）=====
    const who = await resolveUserId(ctx);
    if (!who.id) {
      console.error('[postApply] 无法确认调用者身份：' + who.error);
      return { ok: false, code: 'NO_IDENTITY', msg: '无法确认你的身份，请退出小程序重新进入后再试' };
    }
    const userId = who.id;

    // ===== 2) 必须是已注册用户 =====
    let feeders = [];
    try {
      feeders = toList(await col(db, FEEDER_COLL).find({ userId: userId }, { limit: 1 }));
    } catch (e) {
      console.error('[postApply] 查询用户资料失败', (e && e.message) || e);
      return { ok: false, code: 'LOOKUP_FAILED', msg: '用户资料查询失败，请稍后重试' };
    }
    if (!feeders.length) {
      return { ok: false, code: 'NOT_FEEDER', msg: '请先注册用户资料再申请' };
    }
    const feeder = feeders[0] || {};

    // ===== 3) 已经有权限就不用申请了 =====
    if (feeder.canPost) {
      return { ok: false, code: 'ALREADY_CAN_POST', msg: '你已经有发布权限了' };
    }

    // ===== 4) 黑名单：他们本来就被拦着，申请了也不会批 =====
    // 【失败了不阻塞】查黑名单出错时放行到申请环节 —— 审批时 adminManage 的
    //   applyDecision 还会再判一次黑名单（那才是承重的那道），这里只是提前给个明确提示。
    try {
      const banned = toList(await col(db, BLACK_COLL).find({ id: userId }, { limit: 1 }));
      if (banned.length) {
        return { ok: false, code: 'BLACKLISTED', msg: '当前账号无法申请发布权限' };
      }
    } catch (e) {
      console.warn('[postApply] 黑名单查询失败，改由审批环节兜底', (e && e.message) || e);
    }

    // ===== 5) 写申请记录（_id 即当天键，冲突 = 今天已经申请过）=====
    const now = new Date();
    const dayKey = beijingDayKey(now);
    const applyId = userId + '_' + dayKey;
    try {
      await col(db, APPLY_COLL).insertOne({
        _id: applyId,
        userId: userId,
        nickName: String(feeder.nickName || ''),
        avatarUrl: String(feeder.avatarUrl || ''),
        status: 'pending',
        appliedAt: now,
        dayKey: dayKey,
        handledAt: null,
        handledBy: '',
        handledByTrusted: false,
        source: 'miniapp',
      });
    } catch (e) {
      // 主键冲突 = 同一天第二次申请。这是**预期路径**，不是故障，所以要单独识别出来
      // 返回明确提示，而不是掉进外层 catch 变成"未知错误"。
      const msg = String((e && e.message) || e);
      console.warn('[postApply] 申请写入失败（可能是当天重复申请）', msg);
      let exists = [];
      try {
        exists = toList(await col(db, APPLY_COLL).find({ _id: applyId }, { limit: 1 }));
      } catch (e2) { /* 查不动就当重复处理，提示文案对两种原因都成立 */ }
      if (exists.length) {
        return { ok: false, code: 'ALREADY_APPLIED_TODAY', msg: '每天只能申请一次，请明天再试' };
      }
      return { ok: false, code: 'APPLY_FAILED', msg: '申请提交失败，请稍后重试' };
    }

    // ===== 6) 推飞书卡片（best-effort：推失败不影响申请已成立）=====
    const text = buildCard({
      userId: userId,
      nickName: feeder.nickName,
      timeText: beijingTimeText(now),
    });
    try {
      await ctx.mpserverless.function.invoke('secCheck', {
        action: 'notify',
        text: text,
        target: PUSH_TARGET,
      });
    } catch (e) {
      console.error('[postApply] 飞书推送失败（申请已记录）', (e && e.message) || e);
    }

    console.log('[postApply] 申请已提交 user=' + maskId(userId) + ' day=' + dayKey);
    return { ok: true, code: 'PENDING', msg: '已提交申请，等待管理员审核' };
  } catch (e) {
    console.error('[postApply] 执行失败', (e && e.message) || e);
    return { ok: false, code: 'INTERNAL', msg: '服务异常，请稍后重试' };
  }
};
