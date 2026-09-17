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
 *   { action:'apply' }        → 提交申请（其余参数一律忽略，只认服务端派生的身份）
 *   { action:'selfEnable' }   → 自助开通「审核模式豁免」（Feeder.enable = true）+ 推一条通知
 *   返回 { ok:true, code:'PENDING' | 'ENABLED' | 'ALREADY_ENABLED' } 或 { ok:false, code, msg }；
 *   异常兜底不抛。
 *   失败码 BLACKLISTED / ENABLE_FAILED / **ENABLE_REVOKED**（豁免被管理员收回过，见 selfEnable）。
 *
 * 【它给不了什么：一个被锁住的账号】
 *   管理员可以在飞书里对某个人发「撤销豁免」（adminManage.revokeEnable），那会同时把
 *   enable 置 false 并写上 enableRevoked —— 后者专门用来**否决本函数**，见下面 selfEnable 的
 *   第 0 步。也就是说"连点五次"不是万能的：它是自助的入口，不是能覆盖管理员决定的入口。
 *   【被锁住之后怎么回来】只有一条路：本人重新走一次申请（action:'apply'），管理员审批通过
 *   → adminManage.applyDecision 顺带把 enableRevoked 清掉。原先还有一条管理员侧的
 *   「恢复豁免」命令，2026-09-17 按需求方口径删除 —— 于是这把锁的**唯一**钥匙变成
 *   "申请人自己再申请一次"，所以审批那条路上的清锁不是可选项（有测试钉着）。
 *
 * 【为什么「连点五次」也放在这个函数里】
 *   它是**另一条改权限的路**，与「申请」共享三样东西：同一个申请群通道（通知发往
 *   「发布申请」群，管理员在那里就能看到谁自助开了）、同一套身份硬失败规则、
 *   同一份「必须是已注册用户」的前置检查。为它单开一个云函数，这三样都要抄一遍，
 *   而抄漏任何一样都是安全问题（最要命的是身份 —— 见文件头第二条）。
 *
 * 【这个函数挡不住的事】
 *   客户端仍可用 clientSecret 绕过本函数直写 PostApply / Feeder。真正的收口是控制台集合
 *   权限规则（README 第七节），但 regist.js 目前就在客户端写 Feeder，收口会打断注册流程，
 *   本期不做。详见 README。
 *   ⚠️ 所以 staffTap 改走本函数**是防"改客户端替别人开通"，不是防"绕开小程序"**：
 *      绕过本函数的人本来就能直写库。别把它当成一道真正的门。
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

/**
 * 自助开通的通知卡片正文（发到「发布申请」群；本身不需要回复，但它是**撤销豁免的锚点卡片**）。
 *
 * 🔴 【四条格式约束，每一条都关着飞书那边的解析器，改文案之前先读完】
 *   ① 第一行**绝不许**出现「【发布申请】」字样。feishuCallback.detectContext 只看**第一行**
 *      判场景，判成 'apply' 就会把管理员随手回的「同意」当成审批 —— 而下面的「用户ID：」那行
 *      会被 extractApplicantId 之外的路径拿去当申请人，等于**凭空造出一张能批发布权的申请卡**。
 *      用「【自助开通】」是**必须的、不是随便选的**：detectContext 专门为它开了 'selfenable'
 *      场景，而 resolveAction 里「撤销豁免」的裸命令**只认这个场景**
 *      （理由见那边注释：撤销是粘性状态，撤错人不报错）。改这一行 = 撤销功能失效。
 *      ⚠️ 与 feishuCallback 的 SELF_ENABLE_TITLE 是一对跨函数常量，改名要两边一起改。
 *   ② 用户 ID 那行**绝不许**写成「申请人ID：」。extractApplicantId 是行首锚定的
 *      （`/^申请人ID[：:]/m`），写成同一个行首就等于伪造申请卡；同理不许出现「举报人ID：」
 *      「目标ID：」「类型：」（extractReporterId / extractTarget 的锚点）。
 *      解析器的锚点一共五组，抄一遍免得后人回去翻：申请人ID / 举报人ID / 目标ID / 类型 / 用户ID。
 *      「用户ID：」这一组（extractExemptUserId，撤销豁免专用）是本卡片引入的 —— **必须行首**：
 *      secCheck 的【待复核】/【已拦截】卡片也吐「用户ID：」行，所以撤销那边除了认这一行，
 *      还额外用场景守卫把范围锁死在【自助开通】上。两道一起才保证撤不到别人头上。
 *   ③ 必须明写「无需回复」。不写的话，管理员看到群里一条带 ID 的通知，很自然会回一句
 *      「同意」—— 虽然会被 ① 挡下并回一句报错，但那是一次白挨的困惑。
 *   ④ 结尾要**点名撤销命令**。这条通知的全部用途之一就是让管理员顺手收回误触的那次开通，
 *      不写命令的话他只会去小程序里翻，而那边目前没有这个按钮。
 *
 * 【为什么要把用户ID 明文推给管理员】这条通知的全部意义就是让管理员知道"谁自助开了"。
 *   脱敏了就等于没通知。它是社团内部的申请群，本来就在传用户 ID（见 buildCard）。
 */
function buildSelfEnableCard(opt) {
  return [
    '【自助开通】审核模式豁免',
    '有同学在小程序「关于」页连点 logo 五次，自助开通了豁免。',
    '（无需回复本卡；要收回豁免就在本卡下回复「撤销豁免」。撤错了让对方重新申请即可 —— 审批通过会解锁）',
    '',
    '用户ID：' + opt.userId,
    '昵称：' + (opt.nickName || '（无昵称）'),
    '时间：' + opt.timeText,
  ].join('\n');
}

/** 北京时间 "YYYY-MM-DD HH:mm"（云函数容器是 UTC，必须手动 +8） */
function beijingTimeText(d) {
  const b = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate()) +
    ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes());
}

/**
 * 自助开通「审核模式豁免」：给**调用者本人**写 `Feeder.enable = true`，并推一条通知到申请群。
 *
 * 【为什么这件事必须挪进云函数（原来是 about.js 直接写库）】
 *   客户端写库时，`userId` 是客户端自己传的。小程序里当然传的是自己，但改过的客户端可以传
 *   **别人的** —— 那就是"替别人开通"。改成云函数后 userId 由 getInfo 服务端派生，
 *   这个 action **在结构上就没有"开通别人"这个参数**：一次调用只可能改自己那一条。
 *   这不是防越权攻击（绕过云函数的人本来就能直写库，见文件头），是防改客户端。
 *
 * 【为什么只写 enable、绝不碰 canPost】`enable` = 审核模式下能看见内容；`canPost` = 发帖权。
 *   连点五次换的是前者。canPost 的唯一写入者是 adminManage.applyDecision，
 *   在别处再写一次就等于开了一条自助审批后门 —— 这条线本项目已明确拒绝过（见 README §八）。
 *
 * 【为什么是 updateMany 而不是 updateOne】Feeder 里同一 userId 可能存在重复注册文档，
 *   客户端 initUserState 读到哪条不确定 —— 只改一条会出现"开通了但还是看不见"这种假成功。
 *   与 moderate 的 mute、adminManage 的 applyDecision 同一理由。
 *
 * 【幂等 + 不刷群】已经是 true 的直接返回 ALREADY_ENABLED 且**不再推第二次通知** ——
 *   否则用户每连点五次（或反复确认"到底开通没有"）就往申请群里丢一条。
 *
 * @param {Object} feeder 已查到的本人 Feeder 文档（调用方保证存在）
 * @returns {Promise<Object>} 可直接作为云函数返回值的对象，不抛
 */
async function selfEnable(db, ctx, userId, feeder) {
  // 【第 0 步：先看锁】被管理员撤销过豁免的人，连点五次也**不许**开回来。
  //   没有这一步，撤销就只是把 enable 置回 false —— 本人再点五次就复原了，等于没撤，
  //   而且管理员完全看不见它被复原（不上锁时这里连通知都不会推，因为走的是同一条成功分支）。
  //   锁由 adminManage.revokeEnable 写（飞书「撤销豁免」）；审批通过时那份会把它清掉。
  //   ⚠️ 这是一对**跨函数契约**：字段名 enableRevoked 改了两边一起改。
  //   【为什么放在 enable 检查之前】撤销时 enable 已经被置成 false，先查 enable 的话
  //   用户会收到「你已经是开通状态，无需重复操作」—— 一句和他处境完全无关的话。
  if (feeder.enableRevoked) {
    // 【文案必须指向"存在的动作"】原来写的是"请联系管理员恢复"，而管理员侧的
    //   「恢复豁免」命令 2026-09-17 已删 —— 照原样留着，等于把用户支去问一件管理员
    //   已经做不到的事（管理员只能干看着他）。现在唯一的恢复路径是本人重新申请，
    //   所以文案直接说那个动作。
    return { ok: false, code: 'ENABLE_REVOKED', msg: '该账号的审核模式豁免已被管理员收回，如需恢复请在「我的」页重新申请发布权限' };
  }
  if (feeder.enable) {
    return { ok: true, code: 'ALREADY_ENABLED', msg: '你已经是开通状态，无需重复操作' };
  }

  // 黑名单：他们本来就被 banned 页拦着，开通豁免对他们毫无意义，给个明确答复即可。
  // 【失败了不阻断】理由同 apply 的黑名单检查：承重的判定不在这一层，这里只是提前给个说法。
  try {
    const banned = toList(await col(db, BLACK_COLL).find({ id: userId }, { limit: 1 }));
    if (banned.length) {
      return { ok: false, code: 'BLACKLISTED', msg: '当前账号无法开通' };
    }
  } catch (e) {
    console.warn('[postApply] 黑名单查询失败，放行自助开通', (e && e.message) || e);
  }

  const now = new Date();
  try {
    // 只 $set enable —— 不传 canPost、不传 mutePost，一次调用不可能动到别的权限
    await col(db, FEEDER_COLL).updateMany({ userId: userId }, { $set: { enable: true } });
  } catch (e) {
    console.error('[postApply] 写 enable 失败', (e && e.message) || e);
    return { ok: false, code: 'ENABLE_FAILED', msg: '开通失败，请稍后重试' };
  }

  // 推通知（best-effort：推失败不影响豁免已生效 —— 用户要的是能看见内容，不是群里那条消息）
  const text = buildSelfEnableCard({
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
    console.error('[postApply] 自助开通通知推送失败（豁免已生效）', (e && e.message) || e);
  }

  console.log('[postApply] 自助开通审核模式豁免 user=' + maskId(userId));
  return { ok: true, code: 'ENABLED', msg: '已开通审核模式豁免' };
}

module.exports = async function (ctx) {
  const event = (ctx && ctx.args) || {};
  const db = ctx && ctx.mpserverless && ctx.mpserverless.db;
  const action = String(event.action || '');

  try {
    if (action !== 'apply' && action !== 'selfEnable') {
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
      // 两种 action 共用同一个 code，但文案要各说各的 —— 对连点五次的用户说"再申请"很奇怪。
      // 这条也是审核模式挡陌生人的那道门：没有 Feeder 文档 = 无处可写 enable。
      return {
        ok: false, code: 'NOT_FEEDER',
        msg: action === 'selfEnable' ? '请先注册用户资料' : '请先注册用户资料再申请',
      };
    }
    const feeder = feeders[0] || {};

    // ===== 2.5) 自助开通：与「申请」共用身份和"已注册"检查，之后各走各的 =====
    if (action === 'selfEnable') {
      return await selfEnable(db, ctx, userId, feeder);
    }

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
