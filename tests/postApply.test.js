'use strict';
/**
 * tests/postApply.test.js —— 「申请发布权限」云函数测试
 * ============================================================
 * 零框架，与 tests/adminManage.test.js 同一套写法（check + 退出码 + mockDb）。
 *
 * 【本函数的两条要害】
 *   1. **身份只能服务端派生**。客户端自报的 userId 一旦被采信，任何人都能替别人刷申请，
 *      还能靠换个 id 绕过"一天只能申请一次"。这里用"客户端谎报的 id 与 getInfo 不一致"
 *      的用例把它钉住。
 *   2. **一天只能申请一次靠 _id 主键冲突**（本 DB 层没有多文档事务）。所以 insertOne
 *      冲突必须被识别为**预期路径**并回一句人话，而不是掉进外层 catch 变成"服务异常"。
 *      桩里的 insertOne 必须真的对重复 _id 抛错，否则这条路径根本走不到。
 *
 * 最后一组是**跨云函数契约**测试：把 postApply 生成的飞书卡片正文，原样喂给
 * feishuCallback 的 extractApplicantId 解析。这两个函数各自独立打包、代码不共享，
 * 卡片格式是它们之间唯一的接口 —— 格式一改，管理员回「同意」就会报"未能解析出申请人ID"，
 * 而那种错在单测里看不出来（两边各自都"对"）。
 * ============================================================
 */
const mod = require('../cloudfunctions/postApply/index.js');
const cb = require('../cloudfunctions/feishuCallback/index.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      got : ' + g + '\n      want: ' + w); }
}

const UID = '64fa07d6a09a9bd68b13a8a2'; // 服务端派生的真实调用者
const OTHER = '64fa07d6a09a9bd68b13a8a3'; // 客户端可能谎报的那个 id

/** 与云函数里逐字相同的北京时间当天键（独立算一遍，不复用被测代码） */
function beijingDayKey(d) {
  return new Date((d ? d.getTime() : Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
const TODAY = beijingDayKey();
const APPLY_ID = UID + '_' + TODAY;

function match(doc, filter) {
  return Object.keys(filter || {}).every(function (k) {
    const v = filter[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$ne' in v) return doc[k] !== v.$ne;
      if ('$in' in v) return v.$in.indexOf(doc[k]) >= 0;
      return false;
    }
    return doc[k] === v;
  });
}

/**
 * @param opt.data   { 集合名: [文档...] }
 * @param opt.failOn ['Feeder.find', 'PostApply.insertOne', ...] 让指定调用抛错
 */
function makeDb(opt) {
  opt = opt || {};
  // 【必须把文档复制一份再存，不能直接用调用方传进来的对象】各组用例共用同一个模块级
  //   FEEDER 常量，而 updateMany / insertOne 会**就地改写**文档 —— 不复制的话，
  //   前一组写上的 enable 会带进后一组，于是"黑名单不该写入"这类用例会读到
  //   上一组留下的 enable=true，走进 ALREADY_ENABLED 分支，以"看起来跑过了"的形式空过。
  //   （这条陷阱是实际踩出来的：5 条断言同时变红，原因不在被测代码而在桩。
  //     浅拷贝够了 —— 被改动的都是顶层字段；appliedAt 这类 Date 引用照原样带过去。）
  const data = {};
  Object.keys(opt.data || {}).forEach(function (k) {
    data[k] = (opt.data[k] || []).map(function (d) {
      return (d && typeof d === 'object') ? Object.assign({}, d) : d;
    });
  });
  const failOn = opt.failOn || [];
  const calls = [];
  function maybeFail(key) {
    if (failOn.indexOf(key) >= 0) throw new Error('mock 故障: ' + key);
  }
  return {
    calls: calls,
    data: data,
    of: function (name, m) {
      return calls.filter(function (c) { return c.name === name && c.m === m; });
    },
    collection: function (name) {
      return {
        find: async function (f, o) {
          calls.push({ name: name, m: 'find', filter: f, options: o });
          maybeFail(name + '.find');
          let arr = (data[name] || []).filter(function (d) { return match(d, f || {}); });
          if (o && o.limit) arr = arr.slice(0, o.limit);
          return { result: arr };
        },
        // 【必须真的对重复 _id 抛错】"一天只能申请一次"完全建立在这条主键冲突上，
        // 桩若默默 push 进去，被测代码永远走不到 ALREADY_APPLIED_TODAY 分支，
        // 用例会以"成功"的形式空过。
        insertOne: async function (doc) {
          calls.push({ name: name, m: 'insertOne', doc: doc });
          maybeFail(name + '.insertOne');
          const arr = (data[name] = data[name] || []);
          if (doc && doc._id !== undefined && arr.some(function (d) { return d._id === doc._id; })) {
            throw new Error('duplicate key error collection: ' + name + ' index: _id_');
          }
          arr.push(doc);
          return {};
        },
        // 【必须真的把 $set 合并进文档】"自助开通绝不给 canPost"这条断言是靠
        // `'canPost' in doc === false` 判的 —— 桩若只记录调用而不改数据，文档永远没变，
        // 这条断言就永远为真，等于测了个寂寞（本仓踩过同形的坑：桩对重复 _id 不抛错）。
        updateMany: async function (f, update) {
          calls.push({ name: name, m: 'updateMany', filter: f, update: update });
          maybeFail(name + '.updateMany');
          const arr = (data[name] = data[name] || []);
          const hit = arr.filter(function (d) { return match(d, f || {}); });
          hit.forEach(function (d) {
            const set = update && update.$set;
            if (set) Object.keys(set).forEach(function (k) { d[k] = set[k]; });
          });
          return { result: { modifiedCount: hit.length } };
        },
      };
    },
  };
}

/** 造 ctx：默认服务端能确认身份 = UID；function.invoke 记录调用并返回成功 */
function mkCtx(opt) {
  opt = opt || {};
  const pushes = [];
  const mps = {
    db: opt.db,
    function: {
      invoke: async function (name, args) {
        pushes.push({ name: name, args: args });
        if (opt.invokeFail) throw new Error('mock 故障: invoke');
        return {};
      },
    },
  };
  if (opt.noUser !== true) {
    mps.user = {
      getInfo: opt.getInfo || (async function () { return { result: { user: { userId: UID } } }; }),
    };
  }
  return { ctx: { args: Object.assign({ action: 'apply' }, opt.args || {}), mpserverless: mps }, pushes: pushes };
}

const FEEDER = { _id: 'f1', userId: UID, nickName: '小明', avatarUrl: 'http://a/1.png' };

(async function () {
  console.log('[正常申请]');
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [], PostApply: [] } });
    const c = mkCtx({ db: db });
    const r = await mod(c.ctx);
    check('提交成功', { ok: r.ok, code: r.code }, { ok: true, code: 'PENDING' });

    const rows = db.data.PostApply;
    check('写了一条申请', rows.length, 1);
    check('  _id = userId_北京时间日期（"一天一次"的原子锁）', rows[0]._id, APPLY_ID);
    check('  dayKey 与 _id 后缀一致', rows[0].dayKey, TODAY);
    check('  状态 pending', rows[0].status, 'pending');
    check('  appliedAt 是 Date', rows[0].appliedAt instanceof Date, true);
    check('  昵称/头像留了快照（审批页与卡片直接渲染，不做 join）',
      { n: rows[0].nickName, a: rows[0].avatarUrl }, { n: '小明', a: 'http://a/1.png' });
    check('  审计字段先占位', { h: rows[0].handledAt, b: rows[0].handledBy, s: rows[0].source },
      { h: null, b: '', s: 'miniapp' });
  }

  console.log('\n[身份必须服务端派生]');
  {
    // 客户端谎报一个别人的 id —— 绝不能因此替别人申请
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [], PostApply: [] } });
    const c = mkCtx({ db: db, args: { userId: OTHER, callerId: OTHER, openid: OTHER } });
    const r = await mod(c.ctx);
    check('谎报的 userId 被完全忽略', { ok: r.ok, id: db.data.PostApply[0] && db.data.PostApply[0]._id }, { ok: true, id: APPLY_ID });
  }
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [], PostApply: [] } });
    const c = mkCtx({ db: db, getInfo: async function () { throw new Error('getInfo 不可用'); } });
    const r = await mod(c.ctx);
    check('取不到身份 → NO_IDENTITY（刻意不留客户端兜底）', { ok: r.ok, code: r.code }, { ok: false, code: 'NO_IDENTITY' });
    check('  零写入', db.data.PostApply.length, 0);
  }
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [], PostApply: [] } });
    const c = mkCtx({ db: db, noUser: true });
    const r = await mod(c.ctx);
    check('ctx 里没有 user → 同样 NO_IDENTITY', { ok: r.ok, code: r.code }, { ok: false, code: 'NO_IDENTITY' });
    check('  零写入', db.data.PostApply.length, 0);
  }

  console.log('\n[不该申请的人]');
  {
    const db = makeDb({ data: { Feeder: [], BlackNum: [], PostApply: [] } });
    const r = await mod(mkCtx({ db: db }).ctx);
    check('未注册 → NOT_FEEDER', { ok: r.ok, code: r.code, msg: r.msg },
      { ok: false, code: 'NOT_FEEDER', msg: '请先注册用户资料再申请' });
    check('  零写入', db.data.PostApply.length, 0);
  }
  {
    const db = makeDb({ data: { Feeder: [{ _id: 'f', userId: UID, canPost: true }], BlackNum: [], PostApply: [] } });
    const r = await mod(mkCtx({ db: db }).ctx);
    check('已有发布权 → ALREADY_CAN_POST', { ok: r.ok, code: r.code }, { ok: false, code: 'ALREADY_CAN_POST' });
    check('  零写入', db.data.PostApply.length, 0);
  }
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [{ _id: 'b', id: UID, reason: '内容违规' }], PostApply: [] } });
    const r = await mod(mkCtx({ db: db }).ctx);
    check('黑名单 → BLACKLISTED', { ok: r.ok, code: r.code }, { ok: false, code: 'BLACKLISTED' });
    check('  零写入（不给他们留下"申请过"的痕迹）', db.data.PostApply.length, 0);
  }

  console.log('\n[一天只能申请一次]');
  {
    // 当天已有一条：insertOne 会撞 _id
    const db = makeDb({
      data: {
        Feeder: [FEEDER], BlackNum: [],
        PostApply: [{ _id: APPLY_ID, userId: UID, status: 'pending', dayKey: TODAY, appliedAt: new Date() }],
      },
    });
    const r = await mod(mkCtx({ db: db }).ctx);
    // 【关键】这是**预期路径**，必须回一句人话，不能是 INTERNAL / 服务异常
    check('当天第二次 → ALREADY_APPLIED_TODAY（不是 500 服务异常）',
      { ok: r.ok, code: r.code, msg: r.msg },
      { ok: false, code: 'ALREADY_APPLIED_TODAY', msg: '每天只能申请一次，请明天再试' });
    check('  没有多写一条', db.data.PostApply.length, 1);
  }
  {
    // 昨天的申请不占用今天：_id 里带的是日期，天然按天隔离
    const YESTERDAY = UID + '_' + beijingDayKey(new Date(Date.now() - 24 * 3600 * 1000));
    const db = makeDb({
      data: {
        Feeder: [FEEDER], BlackNum: [],
        PostApply: [{ _id: YESTERDAY, userId: UID, status: 'rejected', dayKey: '昨天', appliedAt: new Date() }],
      },
    });
    const r = await mod(mkCtx({ db: db }).ctx);
    check('昨天申请过（且被拒）→ 今天仍可再申请', { ok: r.ok, code: r.code }, { ok: true, code: 'PENDING' });
  }
  {
    // 写入失败但查不到已存在的行 = 真的是数据库故障，如实报 APPLY_FAILED
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [], PostApply: [] }, failOn: ['PostApply.insertOne'] });
    const r = await mod(mkCtx({ db: db }).ctx);
    check('写入失败且无重复记录 → APPLY_FAILED（与"今天已申请"区分开）',
      { ok: r.ok, code: r.code }, { ok: false, code: 'APPLY_FAILED' });
  }

  console.log('\n[查询失败的兜底]');
  {
    const db = makeDb({ data: { Feeder: [], BlackNum: [], PostApply: [] }, failOn: ['Feeder.find'] });
    const r = await mod(mkCtx({ db: db }).ctx);
    check('用户资料查询抛错 → LOOKUP_FAILED（不当成"没注册"）',
      { ok: r.ok, code: r.code }, { ok: false, code: 'LOOKUP_FAILED' });
  }
  {
    // 黑名单查询失败**不阻断**：承重的那道判定在审批环节（adminManage.applyDecision）
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [], PostApply: [] }, failOn: ['BlackNum.find'] });
    const r = await mod(mkCtx({ db: db }).ctx);
    check('黑名单查询抛错不阻断申请（审批时还会再判一次）', { ok: r.ok, code: r.code }, { ok: true, code: 'PENDING' });
  }

  console.log('\n[自助开通（连点五次）：写 enable，绝不给 canPost]');
  let notifyText = '';
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [] } });
    const c = mkCtx({ db: db, args: { action: 'selfEnable' } });
    const r = await mod(c.ctx);
    check('开通成功 → ENABLED', { ok: r.ok, code: r.code }, { ok: true, code: 'ENABLED' });
    check('  Feeder.enable 写成布尔 true', db.data.Feeder[0].enable, true);
    // 【本组最重要的一条】连点五次换的是"审核模式下看得见"，不是发帖权。
    //   canPost 的唯一写入者是 adminManage.applyDecision —— 这里多写一次就是开了自助审批后门。
    check('  canPost 未被写（自助 ≠ 审批）', 'canPost' in db.data.Feeder[0], false);
    check('  其余权限字段一个都没碰',
      ['canPost', 'canPostBy', 'canPostTime', 'mutePost'].filter(function (k) { return k in db.data.Feeder[0]; }),
      []);
    check('  用 updateMany 而不是 updateOne（重复 Feeder 文档要一起打上）',
      db.of('Feeder', 'updateMany').length, 1);
    // 【取值必须兜底，不能直接 [0].update.$set】被测代码一旦根本没发起写入（比如身份
    //   校验被改坏，提前 return 了），`[0]` 就是 undefined，这一行会抛 TypeError
    //   把**后面所有断言连同结果行一起吞掉** —— 整个脚本以"只剩几条 FAIL"的样子死掉，
    //   看起来像小问题，实际是测试自己崩了。（这条是被变异测试逼出来的：
    //   把身份改回客户端自报时，脚本在第 3 条断言处就异常退出。）
    //   兜成 {} 之后，漏写就是 `[] !== ['enable']` 的一条干净 FAIL。
    const writes = db.of('Feeder', 'updateMany');
    check('  $set 里只有 enable 一个字段',
      Object.keys((writes[0] && writes[0].update && writes[0].update.$set) || {}), ['enable']);
    check('  推了一条通知到「发布申请」群',
      c.pushes.map(function (p) { return { n: p.name, a: p.args.action, t: p.args.target }; }),
      [{ n: 'secCheck', a: 'notify', t: 'apply' }]);
    // 同上，取值兜底：没推成功时 `c.pushes[0]` 是 undefined，直接取 .args.text 会抛，
    // 而下面那组「跨云函数契约」断言正是靠这个字符串 —— 抛了它就等于整组静默消失。
    notifyText = (c.pushes[0] && c.pushes[0].args && c.pushes[0].args.text) || '';
  }
  {
    // 【这一组是本次改动存在的全部理由】原来是客户端 updateOne('Feeder', {userId}) ——
    //   userId 取自客户端，改过的客户端能传别人的 id，就成了"替别人开通"。
    const db = makeDb({
      data: { Feeder: [FEEDER, { _id: 'f2', userId: OTHER, nickName: '别人' }], BlackNum: [] },
    });
    const c = mkCtx({ db: db, args: { action: 'selfEnable', userId: OTHER, callerId: OTHER } });
    const r = await mod(c.ctx);
    check('谎报的 userId 被忽略，开通的仍是服务端派生的本人', { ok: r.ok, me: db.data.Feeder[0].enable },
      { ok: true, me: true });
    check('  同一个请求**结构上就改不到别人**', 'enable' in db.data.Feeder[1], false);
  }
  {
    const db = makeDb({ data: { Feeder: [], BlackNum: [] } });
    const r = await mod(mkCtx({ db: db, args: { action: 'selfEnable' } }).ctx);
    check('未注册 → NOT_FEEDER，文案是「请先注册用户资料」（不带"再申请"）',
      { ok: r.ok, code: r.code, msg: r.msg },
      { ok: false, code: 'NOT_FEEDER', msg: '请先注册用户资料' });
  }
  {
    const db = makeDb({ data: { Feeder: [{ _id: 'f', userId: UID, enable: true }], BlackNum: [] } });
    const c = mkCtx({ db: db, args: { action: 'selfEnable' } });
    const r = await mod(c.ctx);
    check('已经是开通状态 → ALREADY_ENABLED', { ok: r.ok, code: r.code }, { ok: true, code: 'ALREADY_ENABLED' });
    check('  不再重复推通知（反复连点不能刷群）', c.pushes.length, 0);
    check('  也没有多余的写', db.of('Feeder', 'updateMany').length, 0);
  }
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [{ _id: 'b', id: UID }] } });
    const r = await mod(mkCtx({ db: db, args: { action: 'selfEnable' } }).ctx);
    check('黑名单 → BLACKLISTED 且零写入', { ok: r.ok, code: r.code }, { ok: false, code: 'BLACKLISTED' });
    check('  enable 没被写上', 'enable' in db.data.Feeder[0], false);
  }
  {
    // 黑名单查不动**不阻断**（与 apply 同口径：承重的判定不在这层）
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [] }, failOn: ['BlackNum.find'] });
    const r = await mod(mkCtx({ db: db, args: { action: 'selfEnable' } }).ctx);
    check('黑名单查询抛错不阻断自助开通', { ok: r.ok, code: r.code }, { ok: true, code: 'ENABLED' });
  }
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [] }, failOn: ['Feeder.updateMany'] });
    const c = mkCtx({ db: db, args: { action: 'selfEnable' } });
    const r = await mod(c.ctx);
    check('写库失败 → ENABLE_FAILED（不谎报成功）', { ok: r.ok, code: r.code }, { ok: false, code: 'ENABLE_FAILED' });
    check('  失败时不推「已开通」通知', c.pushes.length, 0);
  }
  {
    // 通知推失败**不影响豁免已生效**：用户要的是能看见内容，不是群里那条消息
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [] } });
    const r = await mod(mkCtx({ db: db, args: { action: 'selfEnable' }, invokeFail: true }).ctx);
    check('推送失败不影响开通（best-effort）', { ok: r.ok, code: r.code }, { ok: true, code: 'ENABLED' });
    check('  enable 已落库', db.data.Feeder[0].enable, true);
  }

  console.log('\n[自助开通的锁：管理员撤销过的人，连点五次也开不回来]');
  // 【这一组是「飞书撤销豁免」那一半的存在理由】撤销只把 enable 置回 false 的话，
  //   本人再连点五次就复原了 —— 而这条成功分支**不会推通知**（只有首次开通才推），
  //   所以管理员根本看不见它被撤销后又被打开。锁（enableRevoked）就是为此存在的，
  //   而它的**唯一读点**就在本文件被测的 selfEnable 里。
  //   ⚠️ 这是一对跨函数契约：字段名与 adminManage.revokeEnable 必须一致。
  {
    const LOCKED = Object.assign({}, FEEDER, { enableRevoked: true, enableRevokedBy: 'feishu' });
    const db = makeDb({ data: { Feeder: [LOCKED], BlackNum: [] } });
    const c = mkCtx({ db: db, args: { action: 'selfEnable' } });
    const r = await mod(c.ctx);
    check('被锁住 → ENABLE_REVOKED（不是 ENABLED）', { ok: r.ok, code: r.code },
      { ok: false, code: 'ENABLE_REVOKED' });
    // 【零写入是本组的核心】只回一句错误还不够 —— 只要写了 enable，锁就等于没有。
    check('  一个字段都没写（这才是"锁"的含义）', db.of('Feeder', 'updateMany').length, 0);
    check('  enable 仍然是假值', db.data.Feeder[0].enable, undefined);
    check('  也不推通知（不能靠连点把管理员刷回来）', c.pushes.length, 0);
    check('  文案告诉本人去找管理员（不是"稍后重试"这种无出路的话）',
      String(r.msg || '').indexOf('管理员') > 0, true);
  }
  {
    // 【顺序也是承重的】撤销时 enable 已经被置成 false。若把锁的检查放在 enable 检查**之后**，
    //   被撤销的人会收到「你已经是开通状态，无需重复操作」—— 一句与他处境完全无关的话，
    //   而且他会以为功能坏了（"我明明看不见内容，它却说我已开通"）。
    const LOCKED_AND_ON = Object.assign({}, FEEDER, { enable: true, enableRevoked: true });
    const db = makeDb({ data: { Feeder: [LOCKED_AND_ON], BlackNum: [] } });
    const r = await mod(mkCtx({ db: db, args: { action: 'selfEnable' } }).ctx);
    check('enable=true 与锁同时存在时（控制台手工改出来的脏状态）→ 仍然按锁处理',
      { ok: r.ok, code: r.code }, { ok: false, code: 'ENABLE_REVOKED' });
  }
  {
    // 反向：锁被清掉之后（**唯一**的清锁路径是审批通过，见 adminManage.applyDecision）
    //   必须能正常开通。原先这里还并列写着"管理员发「恢复豁免」"，那条命令 2026-09-17 已删 ——
    //   所以这个反向用例现在守的是"审批那条退路真的通"，不是"命令能解"。
    const RESTORED = Object.assign({}, FEEDER, { enableRevoked: false });
    const db = makeDb({ data: { Feeder: [RESTORED], BlackNum: [] } });
    const r = await mod(mkCtx({ db: db, args: { action: 'selfEnable' } }).ctx);
    check('锁被清掉（enableRevoked = false）→ 恢复成正常开通', { ok: r.ok, code: r.code },
      { ok: true, code: 'ENABLED' });
  }
  {
    // 没这个字段的人（库里绝大多数）不能因为本功能被误挡
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [] } });
    const r = await mod(mkCtx({ db: db, args: { action: 'selfEnable' } }).ctx);
    check('文档里没有 enableRevoked 字段（未撤销过）→ 照常开通', { ok: r.ok, code: r.code },
      { ok: true, code: 'ENABLED' });
  }

  console.log('\n[飞书推送]');
  let pushedText = '';
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [], PostApply: [] } });
    const c = mkCtx({ db: db });
    await mod(c.ctx);
    check('推到 secCheck 且 target=apply（发到「发布申请」新群）',
      c.pushes.map(function (p) { return { n: p.name, a: p.args.action, t: p.args.target }; }),
      [{ n: 'secCheck', a: 'notify', t: 'apply' }]);
    pushedText = c.pushes[0].args.text;
    check('  卡片标题带上【发布申请】（feishuCallback 靠第一行判场景）',
      pushedText.split('\n')[0], '【发布申请】');
  }
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [], PostApply: [] } });
    const r = await mod(mkCtx({ db: db, invokeFail: true }).ctx);
    check('推送失败不影响申请已成立（best-effort）', { ok: r.ok, code: r.code }, { ok: true, code: 'PENDING' });
    check('  申请记录仍在', db.data.PostApply.length, 1);
  }

  console.log('\n[跨云函数契约：卡片正文 ↔ feishuCallback 解析]');
  {
    // 【两个函数各自独立打包，代码不共享】卡片格式是它们之间唯一的接口。
    // 改卡片文案时若忘了改解析器（或反过来），管理员回「同意」就会得到
    // "未能解析出申请人ID" —— 而两边各自的单测都是绿的。这条测试就是那个连接点。
    check('extractApplicantId 能从卡片正文里解析出申请人ID', cb.extractApplicantId(pushedText), UID);
    check('detectContext 把它判成 apply 场景', cb.detectContext(pushedText), 'apply');
    check('  「同意」在该正文下解析为 applyDecision(approve)',
      cb.resolveAction(cb.parseCommand('同意'), cb.detectContext(pushedText), pushedText),
      { action: 'applyDecision', decision: 'approve', userId: UID });
    check('  「拒绝」同上 → reject',
      cb.resolveAction(cb.parseCommand('拒绝'), cb.detectContext(pushedText), pushedText),
      { action: 'applyDecision', decision: 'reject', userId: UID });
  }
  {
    // 【自助开通的通知发在同一个「发布申请」群里】管理员看到一条带 ID 的卡片，很自然会
    //   回一句「同意」。如果这条通知的第一行写成【发布申请】、或者 ID 那行写成「申请人ID：」，
    //   那么这一句「同意」会**真的批出发布权** —— 给一个根本没申请过的人。
    //   下面四条把这个可能性钉死，也是本组比上一组更值得存在的原因：
    //   两张卡片长得很像，而它们的后果差了一个权限。
    check('detectContext 判成 selfenable，**不是** apply', cb.detectContext(notifyText), 'selfenable');
    check('extractApplicantId 解析不出申请人ID', cb.extractApplicantId(notifyText), '');
    const r = cb.resolveAction(cb.parseCommand('同意'), cb.detectContext(notifyText), notifyText);
    check('  「同意」在该正文下被拒绝', typeof r.error === 'string', true);
    check('  且绝不会触达 applyDecision', r.action === undefined, true);
    check('  正文里没有**授予那条线**的任何行首锚点（申请人ID / 举报人ID / 目标ID / 类型）',
      /^(申请人ID|举报人ID|目标ID|类型)[：:]/m.test(notifyText), false);
    check('  明确告诉管理员"无需回复"', notifyText.indexOf('无需回复') > 0, true);

    // ---- 反向契约：撤销豁免那边**必须**能认出这张卡 ----
    // 【为什么这两条和上面同样承重】上面保证"这张卡不能被当成申请卡"（别多给权限）；
    //   这两条保证"这张卡能被人撤销"（该给的能力别丢）。而撤销的实现恰好是这个文件里
    //   最容易被后人"顺手统一掉"的两处：把首行改成【发布申请】、或觉得「用户ID：」这个
    //   锚点多余而删掉 —— 撤销功能会**静默失效**（飞书那边只回一句"未能解析出用户ID"，
    //   没人会想到是卡片格式被改过）。所以两边都钉死。
    check('extractExemptUserId 能从卡片正文里解析出用户ID', cb.extractExemptUserId(notifyText), UID);
    check('  正文里确实有行首的「用户ID：」（撤销命令的锚点）',
      /^用户ID[：:]/m.test(notifyText), true);
    check('  「撤销豁免」在该正文下解析为 revokeEnable',
      cb.resolveAction(cb.parseCommand('撤销豁免'), cb.detectContext(notifyText), notifyText),
      { action: 'revokeEnable', userId: UID });
    // 【同一天删掉的另一半】「恢复豁免」不再是命令 —— 撤错人的退路改成"让对方重新申请"，
    //   所以卡片正文也改写了（见 buildSelfEnableCard）。这里断言旧命令已经解析不出来，
    //   正是上面那条"卡片文案改了就别指望解析器还记得"的同一件事，只是方向朝外。
    check('  「恢复豁免」已不是命令（正文里也不再提它）',
      [cb.parseCommand('恢复豁免'), notifyText.indexOf('恢复豁免')],
      [null, -1]);
    check('  卡片首行就是 feishuCallback 的 SELF_ENABLE_TITLE（跨函数常量，改一边就哑）',
      notifyText.split('\n')[0].indexOf('【自助开通】'), 0);

    // 【本组最该存在的一条】把「撤销豁免」交给**另一张也带「用户ID：」行的卡片**。
    //   secCheck 的【待复核】/【已拦截】推送就是这种卡（下面这段是照 buildPush 的格式抄的）。
    //   如果撤销做成"全场景可用"（像「禁言用户」那样用 extractOpenid），
    //   管理员在【待复核】推送下回一句「撤销豁免」就会撤掉**那位作者**的豁免 ——
    //   而他当时多半是在处理那条内容，根本没打算动这个人的豁免。
    const reviewText = '【待复核】引流广告\n' +
      '内容：加群领养猫咪\n' +
      '作者：某同学\n' +
      '用户ID：' + UID + '\n' +
      '命中词：加群\n' +
      '状态：内容已发布（待复核）';
    check('  ⚠️【待复核】卡片（同样带「用户ID：」行）→ 场景判成 review',
      cb.detectContext(reviewText), 'review');
    check('  ⚠️ 裸「撤销豁免」在【待复核】下**必须被拒绝**（否则会撤错人）',
      typeof cb.resolveAction(cb.parseCommand('撤销豁免'), cb.detectContext(reviewText), reviewText).error,
      'string');
    check('  但带 ID 的写法不受场景限制（手打的 ID 不存在解析错人）',
      cb.resolveAction(cb.parseCommand('撤销豁免 ' + UID), cb.detectContext(reviewText), reviewText),
      { action: 'revokeEnable', userId: UID });
  }

  console.log('\n[路由]');
  {
    const db = makeDb({ data: { Feeder: [FEEDER], BlackNum: [], PostApply: [] } });
    const r = await mod(mkCtx({ db: db, args: { action: 'nope' } }).ctx);
    check('未知 action → UNKNOWN_ACTION', { ok: r.ok, code: r.code }, { ok: false, code: 'UNKNOWN_ACTION' });
    const r2 = await mod({ args: {}, mpserverless: {} });
    check('无 db → 不抛，返回可读结果', { ok: r2.ok, has: typeof r2.msg === 'string' }, { ok: false, has: true });
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常', e);
  process.exit(1);
});
