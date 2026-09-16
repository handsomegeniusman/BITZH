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
  const data = opt.data || {};
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
