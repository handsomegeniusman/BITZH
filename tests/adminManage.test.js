'use strict';
/**
 * adminManage 云函数测试
 * ============================================================
 * 零框架，与 tests/moderateActions.test.js 同一套写法（check + 退出码）。
 *
 * 与既有测试的两点不同（都是刻意的，理由见下）：
 *   1. **mockDb 桩全部方法**（find/insertOne/updateOne/deleteOne/updateMany）。
 *      moderateActions.test.js 的 mockDb 只桩了 find + updateMany，漏桩的方法一被调用就抛，
 *      而云函数自己的 catch 会把它变成 {ok:false} —— 一个宽松的失败断言能"通过"，
 *      实际上什么都没测到。这里还额外断言**调用次数**，不只断言返回值。
 *   2. 环境变量用 withEnv 临时注入再还原。这正是云函数必须"在函数体内调 getCfg"的原因：
 *      顶层定值的话，process.env 到这里已经不起作用了。
 * ============================================================
 */
const mod = require('../cloudfunctions/adminManage/index.js');

// 【先清空 config.js 兜底】真机部署会把真实密码写进 cloudfunctions/adminManage/config.js，
//   而 getCfg 是 `process.env[name] || CFG[name] || ''`。withEnv 删掉环境变量时，取值会落到
//   本机那份 config.js 上 —— 于是"没配密码 → NO_PASSWORD_CONFIG"这类用例会变成 BAD_PASSWORD，
//   **测试结果开始取决于这台机器上 config.js 填没填**。在别人机器上是绿的、在你机器上是红的，
//   这种绿灯比红灯更危险。所以这里显式清空兜底，让所有用例只受 process.env 控制。
//   （下面 [配置来源] 那组会单独把兜底装回去，专门验证它确实生效。）
mod.__setCfg({});

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      got : ' + g + '\n      want: ' + w); }
}

// ---------- 环境变量注入（异步安全） ----------
async function withEnv(obj, fn) {
  const keys = Object.keys(obj);
  const saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; });
  keys.forEach((k) => {
    if (obj[k] === undefined) delete process.env[k];
    else process.env[k] = String(obj[k]);
  });
  try { return await fn(); }
  finally {
    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  }
}

// ---------- mock 数据库 ----------
/** 极简过滤器匹配：支持等值 与 { $in: [...] } 两种（本函数只用这两种） */
function match(doc, filter) {
  return Object.keys(filter || {}).every(function (k) {
    const v = filter[k];
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.indexOf(doc[k]) >= 0;
    return doc[k] === v;
  });
}

/**
 * @param opt.data    { 集合名: [文档...] }
 * @param opt.failOn  ['Feeder.find', 'AdminAuthFail.updateOne'] —— 让指定调用抛错
 * @param opt.findSeq { 集合名: [第一次返回, 第二次返回, ...] } 按调用次序返回（模拟并发竞态）
 */
function makeDb(opt) {
  opt = opt || {};
  const data = opt.data || {};
  const failOn = opt.failOn || [];
  const findSeq = opt.findSeq || {};
  const seqAt = {};
  const calls = [];

  function maybeFail(key) {
    if (failOn.indexOf(key) >= 0) throw new Error('mock 故障: ' + key);
  }

  return {
    calls: calls,
    /** 取某集合上某方法的调用记录 */
    of: function (name, m) {
      return calls.filter(function (c) { return c.name === name && c.m === m; });
    },
    data: data,
    collection: function (name) {
      return {
        find: async function (f) {
          calls.push({ name: name, m: 'find', filter: f });
          maybeFail(name + '.find');
          const seq = findSeq[name];
          if (seq && seqAt[name] === undefined) seqAt[name] = 0;
          if (seq && seqAt[name] < seq.length) return { result: seq[seqAt[name]++] };
          return { result: (data[name] || []).filter(function (d) { return match(d, f || {}); }) };
        },
        insertOne: async function (d) {
          calls.push({ name: name, m: 'insertOne', doc: d });
          maybeFail(name + '.insertOne');
          (data[name] = data[name] || []).push(d);
          return {};
        },
        // updateOne 必须真的落盘（含 upsert）：锁定计数靠"读-改-写"累加，
        // 一个只记录调用、不存结果的桩会让 failCount 永远停在 1，锁定测试就永远是假通过。
        updateOne: async function (f, u, o) {
          calls.push({ name: name, m: 'updateOne', filter: f, update: u, options: o });
          maybeFail(name + '.updateOne');
          const arr = (data[name] = data[name] || []);
          let doc = arr.filter(function (d) { return match(d, f || {}); })[0];
          if (!doc) {
            if (!(o && o.upsert)) return {};
            doc = Object.assign({}, f);
            if (u && u.$setOnInsert) Object.assign(doc, u.$setOnInsert);
            arr.push(doc);
          }
          if (u && u.$set) Object.assign(doc, u.$set);
          if (u && u.$inc) {
            Object.keys(u.$inc).forEach(function (k) { doc[k] = (Number(doc[k]) || 0) + u.$inc[k]; });
          }
          return {};
        },
        updateMany: async function (f, u) {
          calls.push({ name: name, m: 'updateMany', filter: f, update: u });
          maybeFail(name + '.updateMany');
          return {};
        },
        deleteOne: async function (f) {
          calls.push({ name: name, m: 'deleteOne', filter: f });
          maybeFail(name + '.deleteOne');
          const arr = data[name] || [];
          const i = arr.findIndex(function (d) { return match(d, f || {}); });
          if (i >= 0) arr.splice(i, 1);
          return {};
        },
      };
    },
  };
}

/**
 * 造 ctx。
 * @param opt.args      event
 * @param opt.db        mockDb
 * @param opt.getInfo   自定义 getInfo（返回 Promise 或抛错）
 * @param opt.noUser    true 则不提供 ctx.mpserverless.user
 * @param opt.ip        MP_CLIENT_IP，默认 1.1.1.1
 */
function mkCtx(opt) {
  opt = opt || {};
  const mps = { db: opt.db };
  if (opt.noUser !== true) {
    mps.user = {
      getInfo: opt.getInfo || (async function () { return { result: { user: { userId: AID } } }; }),
    };
  }
  return {
    args: opt.args || {},
    env: { MP_CLIENT_IP: opt.ip === undefined ? '1.1.1.1' : opt.ip },
    mpserverless: mps,
  };
}

// 常用夹具
const PW = 'correct-horse';
const AID = '64fa07d6a09a9bd68b13a8a0'; // 调用者本人（管理员A），24 位 hex 空间用户 ID
const BID = '64fa07d6a09a9bd68b13a8a1'; // 另一位管理员
const TID = '64fa07d6a09a9bd68b13a8a2'; // 已注册的普通用户（被授权对象）
const ADMIN_A = { userId: AID, name: '管理员A' };
const ADMIN_B = { userId: BID, name: '管理员B', grantedTime: new Date('2026-01-02T03:04:05Z') };

/** 一份标准集合数据：调用者 AID 是管理员，BID 也是；TID 是已注册的普通用户 */
function baseData(extra) {
  return Object.assign({
    BITZHAdministrator: [ADMIN_A, ADMIN_B],
    Feeder: [
      { _id: 'f0', userId: AID, nickName: '甲' },
      { _id: 'f1', userId: TID, nickName: '小明', avatarUrl: 'http://a/1.png' },
    ],
    AdminAuthFail: [],
  }, extra || {});
}

const ADMIN_ENV = { ADMIN_PASSWORD: PW, ADMIN_PASSWORD_SHA256: undefined, ADMIN_TRUST_CALLER_ID: undefined, ADMIN_DIAG: undefined, PW_MAX_FAILS: undefined, PW_LOCK_MS: undefined, MAX_ADMINS: undefined };

(async function () {
  // ============================================================
  console.log('[导出与路由]');
  check('纯函数已挂到导出（供测试直接调用）',
    ['resolveCallerId', 'verifyPassword', 'sanitizeName', 'passwordDigestConfigured', '__resetState', '__setCfg']
      .every(function (k) { return typeof mod[k] === 'function'; }), true);
  check('不导出密码摘要（导出的都是函数，没有字符串常量）',
    Object.keys(mod).filter(function (k) { return typeof mod[k] === 'string'; }).length, 0);

  // ============================================================
  // 配置来源：控制台环境变量优先，没有环境变量入口时用随函数部署的 config.js 兜底。
  // 这条路是真实部署路径（EMAS 控制台没有环境变量入口），必须有测试盯着，
  // 否则哪天有人把 getCfg 改成只读 process.env，线上表现是"密码明明填了却报未配置"。
  console.log('[配置来源]');
  await withEnv({ ADMIN_PASSWORD: undefined, ADMIN_PASSWORD_SHA256: undefined }, async function () {
    mod.__setCfg({ ADMIN_PASSWORD: 'from-config-file' });
    check('只有 config.js 时能读到（无环境变量的部署走这条）',
      mod.verifyPassword('from-config-file').ok, true);
    check('  此时摘要 = 该密码的 sha256',
      mod.passwordDigestConfigured(), mod.sha256Hex('from-config-file'));

    await withEnv({ ADMIN_PASSWORD: 'from-env' }, async function () {
      check('两边都配时环境变量赢', mod.verifyPassword('from-env').ok, true);
      check('  此时 config.js 里那个不再有效',
        mod.verifyPassword('from-config-file').code, 'BAD_PASSWORD');
    });

    mod.__setCfg({});
    check('兜底清空且无环境变量 → 回到 NO_PASSWORD_CONFIG（失败方向是可判断的）',
      mod.verifyPassword('from-config-file').code, 'NO_PASSWORD_CONFIG');
  });
  mod.__setCfg({}); // 还原：下面所有用例都只走 process.env

  await withEnv(ADMIN_ENV, async function () {
    let db = makeDb({ data: baseData() });
    let r = await mod(mkCtx({ db: db, args: { action: 'nope' } }));
    check('未知 action → 与 moderate 同款报错', { ok: r.ok, msg: r.msg }, { ok: false, msg: '未知 action: nope' });

    r = await mod({ args: { action: 'list' }, mpserverless: {} });
    check('无 db → 明确报错', { ok: r.ok, msg: r.msg }, { ok: false, msg: '无数据库访问 (ctx.mpserverless.db)' });

    db = makeDb({ data: baseData(), failOn: ['BITZHAdministrator.find'] });
    r = await mod(mkCtx({ db: db, args: { action: 'list', password: PW } }));
    check('顶层 catch 兜底（读管理员表抛错时不炸，返回 ok:false）',
      { ok: r.ok, hasMsg: typeof r.msg === 'string' && r.msg.length > 0 }, { ok: false, hasMsg: true });
  });

  // ============================================================
  console.log('[身份解析 resolveCallerId]');
  await withEnv(ADMIN_ENV, async function () {
    const shapes = [
      ['{result:{user:{userId}}}', { result: { user: { userId: 'u1' } } }],
      ['{user:{userId}}', { user: { userId: 'u1' } }],
      ['{userId}', { userId: 'u1' }],
    ];
    for (const [label, ret] of shapes) {
      const got = await mod.resolveCallerId(mkCtx({ getInfo: async function () { return ret; } }));
      check('取到可信身份 ' + label, { id: got.id, trusted: got.trusted }, { id: 'u1', trusted: true });
    }

    let got = await mod.resolveCallerId(mkCtx({
      getInfo: async function () { throw new Error('getInfo 不可用'); },
      args: { callerId: 'u2' },
    }));
    check('getInfo 抛错 → 退回客户端自报（trusted=false）',
      { id: got.id, trusted: got.trusted, via: got.via },
      { id: 'u2', trusted: false, via: 'ctx.args.callerId' });
    check('  并记录失败原因', /getInfo 不可用/.test(got.error), true);

    got = await mod.resolveCallerId(mkCtx({ noUser: true, args: { callerId: 'u2' } }));
    check('没有 ctx.mpserverless.user → 同样退回自报',
      { id: got.id, trusted: got.trusted }, { id: 'u2', trusted: false });
    check('  error 指明缺的是什么', /user\.getInfo 不存在/.test(got.error), true);

    got = await mod.resolveCallerId(mkCtx({ noUser: true }));
    check('既无可信身份也无人自报 → id 为空（调用方应回 NO_IDENTITY）',
      { id: got.id, trusted: got.trusted }, { id: '', trusted: false });

    got = await mod.resolveCallerId(mkCtx({ getInfo: async function () { return {}; } }));
    check('getInfo 返回空对象 → 不当成可信身份',
      { id: got.id, trusted: got.trusted }, { id: '', trusted: false });
    check('  error 指明没有 userId', /没有 userId/.test(got.error), true);

    await withEnv({ ADMIN_TRUST_CALLER_ID: '1' }, async function () {
      got = await mod.resolveCallerId(mkCtx({
        getInfo: async function () { throw new Error('boom'); },
        args: { callerId: 'u2' },
      }));
      check('ADMIN_TRUST_CALLER_ID=1 → 硬失败，不降级到自报',
        { id: got.id, trusted: got.trusted }, { id: '', trusted: false });
    });

    await withEnv({ ADMIN_TRUST_CALLER_ID: '0' }, async function () {
      got = await mod.resolveCallerId(mkCtx({ args: { callerId: 'ignored' } }));
      check('ADMIN_TRUST_CALLER_ID=0 → 有 id 但不给 trusted 标记',
        { id: got.id, trusted: got.trusted }, { id: AID, trusted: false });
      check('  via 标明是降级来的', /降级/.test(got.via), true);
    });
  });

  // ============================================================
  console.log('[密码校验]');
  await withEnv(ADMIN_ENV, async function () {
    check('ADMIN_PASSWORD → 摘要一致', mod.passwordDigestConfigured(), mod.sha256Hex(PW));
    check('密码正确', mod.verifyPassword(PW), { ok: true });
    check('密码错误', mod.verifyPassword('nope'), { ok: false, code: 'BAD_PASSWORD', msg: '密码错误' });
    check('未传密码 → 当成错误（不是当成通过）',
      mod.verifyPassword(undefined), { ok: false, code: 'BAD_PASSWORD', msg: '密码错误' });
    check('数字/对象等非字符串输入也不会崩',
      mod.verifyPassword({}).code, 'BAD_PASSWORD');

    await withEnv({ ADMIN_PASSWORD: undefined, ADMIN_PASSWORD_SHA256: mod.sha256Hex('only-digest') }, async function () {
      check('只配 SHA256 时以它为准', mod.passwordDigestConfigured(), mod.sha256Hex('only-digest'));
      check('  该摘要对应密码可用', mod.verifyPassword('only-digest').ok, true);
    });

    await withEnv({ ADMIN_PASSWORD: PW, ADMIN_PASSWORD_SHA256: mod.sha256Hex('digest-wins') }, async function () {
      check('两个都配时 SHA256 优先', mod.verifyPassword('digest-wins').ok, true);
      check('  此时明文密码不再有效', mod.verifyPassword(PW).code, 'BAD_PASSWORD');
    });

    await withEnv({ ADMIN_PASSWORD: undefined, ADMIN_PASSWORD_SHA256: '不是合法hex' }, async function () {
      check('摘要格式非法且无明文 → NO_PASSWORD_CONFIG（不是当成空密码放行）',
        mod.verifyPassword('').code, 'NO_PASSWORD_CONFIG');
    });
  });

  // 最要紧的一条：没配密码时一次库都不能写
  await withEnv(Object.assign({}, ADMIN_ENV, { ADMIN_PASSWORD: undefined }), async function () {
    const db = makeDb({ data: baseData() });
    const r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: '随便' } }));
    check('未配置密码 → grant 被拒且错误码明确', r.code, 'NO_PASSWORD_CONFIG');
    check('未配置密码 → 一次 insertOne 都没有', db.of('BITZHAdministrator', 'insertOne').length, 0);
  });

  // ============================================================
  console.log('[密码失败锁定]');
  await withEnv(ADMIN_ENV, async function () {
    // 前 4 次：普通错误；第 5 次：触发锁定
    mod.__resetState();
    let db = makeDb({ data: baseData() });
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: 'wrong' } }));
      codes.push(r.code);
    }
    check('前 4 次是 BAD_PASSWORD、第 5 次触发 LOCKED',
      codes, ['BAD_PASSWORD', 'BAD_PASSWORD', 'BAD_PASSWORD', 'BAD_PASSWORD', 'LOCKED']);

    const locked = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: PW } }));
    check('锁定期间【即使密码正确】也拒绝',
      { ok: locked.ok, code: locked.code }, { ok: false, code: 'LOCKED' });
    check('  且仍然没有写库', db.of('BITZHAdministrator', 'insertOne').length, 0);

    const key = db.of('AdminAuthFail', 'updateOne')[0].filter._id;
    check('锁定按服务端派生的 IP 分键（不可伪造）', key, 'ip:1.1.1.1');
    check('锁定走 upsert', db.of('AdminAuthFail', 'updateOne')[0].options, { upsert: true });

    // 可信身份时同时下 ip 与 uid 两把锁：换个 IP 也躲不掉。
    // 这是**刻意的账号级锁定** —— 防的是"同一个已被服务端确认身份的账号，换 IP 继续猜密码"。
    // 代价是本人连错 5 次后 10 分钟内换哪台设备都被拦，这个代价是接受的。
    let other = await mod(mkCtx({ db: db, ip: '2.2.2.2', args: { action: 'grant', userId: TID, password: PW } }));
    check('可信身份：换 IP 仍被 uid 那把锁拦住（账号级锁定）',
      { ok: other.ok, code: other.code }, { ok: false, code: 'LOCKED' });
    check('  同时写了 ip 与 uid 两个键',
      db.of('AdminAuthFail', 'updateOne').slice(0, 2).map(function (c) { return c.filter._id; }),
      ['ip:1.1.1.1', 'uid:' + AID]);

    // 身份不可信时没有可信 uid 可锁，只按 IP 分键 → 换 IP 就能继续
    mod.__resetState();
    const dbU = makeDb({ data: baseData() });
    for (let i = 0; i < 5; i++) {
      await mod(mkCtx({
        db: dbU, args: { action: 'grant', userId: TID, callerId: AID, password: 'wrong' },
        getInfo: async function () { throw new Error('x'); },
      }));
    }
    check('身份不可信：只写 ip 这一个键',
      dbU.of('AdminAuthFail', 'updateOne').slice(0, 1).map(function (c) { return c.filter._id; }),
      ['ip:1.1.1.1']);
    other = await mod(mkCtx({
      db: dbU, ip: '2.2.2.2', args: { action: 'grant', userId: TID, callerId: AID, password: PW },
      getInfo: async function () { throw new Error('x'); },
    }));
    check('  换个 IP 即可继续（此时没有可信 uid 可锁）', other.ok, true);

    // 密码正确会清空计数
    mod.__resetState();
    db = makeDb({ data: baseData() });
    await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: 'wrong' } }));
    await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: 'wrong' } }));
    const writes = db.of('AdminAuthFail', 'updateOne');
    check('失败时计数在涨', writes[writes.length - 1].update.$set.failCount, 2);
    await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: PW } }));
    const after = db.of('AdminAuthFail', 'updateOne');
    check('成功一次即清零（failCount / lockUntil）',
      { c: after[after.length - 1].update.$set.failCount, u: after[after.length - 1].update.$set.lockUntil },
      { c: 0, u: 0 });

    // 集合不可用时降级内存，仍然要锁得住
    mod.__resetState();
    db = makeDb({ data: baseData(), failOn: ['AdminAuthFail.find'] });
    const memCodes = [];
    for (let i = 0; i < 5; i++) {
      const r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: 'wrong' } }));
      memCodes.push(r.code);
    }
    check('AdminAuthFail 不可用 → 降级内存后仍然锁定（不崩、不放行）',
      memCodes[4], 'LOCKED');
    const memLocked = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: PW } }));
    check('  降级后锁定期间同样拒绝正确密码', memLocked.code, 'LOCKED');
    mod.__resetState();
  });

  // ============================================================
  console.log('[list]');
  await withEnv(ADMIN_ENV, async function () {
    let db = makeDb({ data: baseData() });
    let r = await mod(mkCtx({ db: db, args: { action: 'list' } }));
    check('可信身份 + 是管理员 → 不输密码也能列（first lock 已由服务端独立确认）',
      { ok: r.ok, total: r.total, mode: r.identityMode }, { ok: true, total: 2, mode: 'trusted' });
    check('  补齐昵称/头像', { n: r.admins[0].nickName, a: r.admins[0].avatarUrl }, { n: '甲', a: '' });
    check('  grantedTimeText 已格式化', r.admins[1].grantedTimeText, '2026-01-02 11:04');
    check('  isSelf 只标记自己', r.admins.map(function (a) { return a.isSelf; }), [true, false]);

    // 身份不可信 → list 也要密码
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({
      db: db, args: { action: 'list', callerId: AID },
      getInfo: async function () { throw new Error('x'); },
    }));
    check('身份不可信 + 没带密码 → 拒绝（密码在这种情况下是唯一门槛）', r.code, 'BAD_PASSWORD');

    r = await mod(mkCtx({
      db: db, args: { action: 'list', password: PW, callerId: AID },
      getInfo: async function () { throw new Error('x'); },
    }));
    check('身份不可信 + 带对密码 → 放行且如实标注 untrusted',
      { ok: r.ok, mode: r.identityMode }, { ok: true, mode: 'untrusted' });
    // 注意：这里的 callerId 只能来自客户端自报，且必须在管理员表里
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({
      db: db, args: { action: 'list', password: PW, callerId: TID },
      getInfo: async function () { throw new Error('x'); },
    }));
    check('自报一个非管理员 ID → NOT_ADMIN', r.code, 'NOT_ADMIN');

    r = await mod(mkCtx({ db: db, args: { action: 'list', password: PW }, noUser: true }));
    check('完全拿不到身份 → NO_IDENTITY', r.code, 'NO_IDENTITY');

    // Feeder 缺失 / 查询失败都不能让列表挂掉
    db = makeDb({ data: baseData({ Feeder: [] }) });
    r = await mod(mkCtx({ db: db, args: { action: 'list' } }));
    check('Feeder 里没有记录（控制台手工插的管理员）→ 列表照出，昵称留空',
      { ok: r.ok, n: r.admins[0].nickName }, { ok: true, n: '' });

    db = makeDb({ data: baseData(), failOn: ['Feeder.find'] });
    r = await mod(mkCtx({ db: db, args: { action: 'list' } }));
    check('补资料查询抛错 → 列表仍然返回（不该因为补字段失败就什么都看不到）',
      { ok: r.ok, total: r.total }, { ok: true, total: 2 });
  });

  // ============================================================
  console.log('[grant]');
  await withEnv(ADMIN_ENV, async function () {
    let db = makeDb({ data: baseData() });
    let r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: PW } }));
    check('添加成功', { ok: r.ok, userId: r.userId, name: r.name, already: r.already },
      { ok: true, userId: TID, name: '小明', already: false });
    const ins = db.of('BITZHAdministrator', 'insertOne');
    check('  写了一次库', ins.length, 1);
    check('  姓名取 Feeder 昵称', ins[0].doc.name, '小明');
    check('  带审计字段 grantedBy / grantedByTrusted',
      { by: ins[0].doc.grantedBy, trusted: ins[0].doc.grantedByTrusted }, { by: AID, trusted: true });
    check('  grantedTime 是 Date', ins[0].doc.grantedTime instanceof Date, true);

    // 身份不可信时，grant 必须带密码
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({
      db: db, args: { action: 'grant', userId: TID, callerId: AID },
      getInfo: async function () { throw new Error('x'); },
    }));
    check('身份不可信 + 无密码 → 拒绝', r.code, 'BAD_PASSWORD');
    check('  且没有写库', db.of('BITZHAdministrator', 'insertOne').length, 0);

    r = await mod(mkCtx({
      db: db, args: { action: 'grant', userId: TID, callerId: AID, password: PW },
      getInfo: async function () { throw new Error('x'); },
    }));
    check('身份不可信 + 对密码 → 放行', r.ok, true);
    check('  审计字段如实标记 trusted=false',
      db.of('BITZHAdministrator', 'insertOne')[0].doc.grantedByTrusted, false);

    // 已是管理员：不写库、不覆盖
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: BID, password: PW } }));
    check('已是管理员 → already:true 且保留原姓名',
      { ok: r.ok, already: r.already, name: r.name }, { ok: true, already: true, name: '管理员B' });
    check('  一次库都没写', db.of('BITZHAdministrator', 'insertOne').length, 0);

    // 已是管理员、但 Feeder 里没有资料（控制台手工插进去的）→ 仍然要说 already。
    // 校验顺序反过来的话这里会得到 NOT_FEEDER —— 对一个明明是管理员的人说"该用户未注册"是误导。
    db = makeDb({ data: baseData({ Feeder: [] }) });
    r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: BID, password: PW } }));
    check('已是管理员但 Feeder 无资料 → 仍是 already，不是 NOT_FEEDER',
      { ok: r.ok, already: r.already }, { ok: true, already: true });
    check('  且压根不必去查 Feeder', db.of('Feeder', 'find').length, 0);

    // 未注册 vs 查询失败：必须能区分
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: 'nobody000', password: PW } }));
    check('用户不存在 → NOT_FEEDER', r.code, 'NOT_FEEDER');
    db = makeDb({ data: baseData(), failOn: ['Feeder.find'] });
    r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, password: PW } }));
    check('查询抛错 → LOOKUP_FAILED（**不是** NOT_FEEDER，两者混在一起会害排查）', r.code, 'LOOKUP_FAILED');

    // 畸形 ID 一律挡在数据库过滤器之外
    for (const bad of ['', 'short', 'a'.repeat(65), 'has space', 'semi;colon']) {
      const d2 = makeDb({ data: baseData() });
      const r2 = await mod(mkCtx({ db: d2, args: { action: 'grant', userId: bad, password: PW } }));
      check('畸形 userId 被拒: ' + JSON.stringify(bad), r2.code, 'BAD_USER_ID');
      check('  且没查过 Feeder', d2.of('Feeder', 'find').length, 0);
    }

    // 姓名清洗与兜底
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, name: ' 坏' + String.fromCharCode(7) + '名 字 ', password: PW } }));
    check('姓名走服务端清洗（去控制字符/空白）', r.name, '坏名字');

    db = makeDb({ data: baseData({ Feeder: [{ _id: 'f1', userId: TID }] }) });
    r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, name: String.fromCharCode(1), password: PW } }));
    check('姓名清空且昵称也空 → 兜底「管理员」', r.name, '管理员');

    // ---- 人工填写的姓名（页面上现在必须输入，不再只靠昵称兜底）----
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, name: '北理珠流浪猫关爱部', password: PW } }));
    check('机构名原样存入，不被 Feeder 昵称顶掉', r.name, '北理珠流浪猫关爱部');
    check('  落库的也是它', db.of('BITZHAdministrator', 'insertOne')[0].doc.name, '北理珠流浪猫关爱部');

    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, name: '甲'.repeat(25), password: PW } }));
    check('超过 20 个码点 → 截到 20', r.name, '甲'.repeat(20));
    check('  截断后按码点数仍是 20', Array.from(r.name).length, 20);

    // 【为什么单测这一条】原来是 s.slice(0,20)，按 UTF-16 码元切。姓名改成人工输入后，
    //   里面可能有 emoji（代理对，占 2 个码元）—— 切在中间会留下一个孤立代理项，
    //   存进库里就是一个"碎掉"的字符，而且完全看不出是怎么来的。
    const emojiCat = String.fromCodePoint(0x1F63A); // 😺 占 2 个 UTF-16 码元
    const twentyCp = '喵'.repeat(19) + emojiCat;    // 20 个码点，但 UTF-16 长度是 21
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'grant', userId: TID, name: twentyCp, password: PW } }));
    check('恰好 20 个码点（末尾是 emoji）完整保留', r.name, twentyCp);
    check('  UTF-16 长度 21 = 代理对没被劈开', r.name.length, 21);
    check('  末位是低位代理项而不是半个字符',
      r.name.charCodeAt(20) >= 0xDC00 && r.name.charCodeAt(20) <= 0xDFFF, true);

    // 上限
    await withEnv({ MAX_ADMINS: 2 }, async function () {
      const d2 = makeDb({ data: baseData() });
      const r2 = await mod(mkCtx({ db: d2, args: { action: 'grant', userId: TID, password: PW } }));
      check('达到 MAX_ADMINS → TOO_MANY', r2.code, 'TOO_MANY');
      check('  且没写库', d2.of('BITZHAdministrator', 'insertOne').length, 0);
    });
  });

  // ============================================================
  console.log('[revoke]');
  await withEnv(ADMIN_ENV, async function () {
    let db = makeDb({ data: baseData() });
    let r = await mod(mkCtx({ db: db, args: { action: 'revoke', userId: BID, password: PW } }));
    check('移除成功', { ok: r.ok, already: r.already }, { ok: true, already: false });
    check('  删了一次', db.of('BITZHAdministrator', 'deleteOne').length, 1);
    check('  删除条件按 userId', db.of('BITZHAdministrator', 'deleteOne')[0].filter, { userId: BID });
    check('  没有多余的补偿回插', db.of('BITZHAdministrator', 'insertOne').length, 0);

    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'revoke', userId: AID, password: PW } }));
    check('移除自己 → SELF_REVOKE', r.code, 'SELF_REVOKE');
    check('  且没删', db.of('BITZHAdministrator', 'deleteOne').length, 0);

    db = makeDb({ data: baseData({ BITZHAdministrator: [ADMIN_A], Feeder: [{ _id: 'f0', userId: AID, nickName: '甲' }] }) });
    r = await mod(mkCtx({ db: db, args: { action: 'revoke', userId: BID, password: PW } }));
    check('只剩一位 → LAST_ADMIN', r.code, 'LAST_ADMIN');
    check('  文案点明只能去控制台恢复', /控制台/.test(r.msg), true);
    check('  且没删', db.of('BITZHAdministrator', 'deleteOne').length, 0);

    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'revoke', userId: 'nobody00', password: PW } }));
    check('移除一个本来就不是管理员的人 → already:true（幂等）',
      { ok: r.ok, already: r.already }, { ok: true, already: true });

    // 并发竞态：两人同时移除对方，删完发现表空了 → 把刚删的插回去
    const seq = [
      [ADMIN_A, ADMIN_B], // 第一次读：还有两个，last-admin 判定通过
      [],                 // 删完再读：空了（模拟另一个请求同时也删掉了）
    ];
    db = makeDb({ data: baseData(), findSeq: { BITZHAdministrator: seq } });
    r = await mod(mkCtx({ db: db, args: { action: 'revoke', userId: BID, password: PW } }));
    check('并发把管理员清零 → 返回 LAST_ADMIN 而不是 ok', r.code, 'LAST_ADMIN');
    const redo = db.of('BITZHAdministrator', 'insertOne');
    check('  并把刚删的那条插回去（尽力补偿）', redo.length, 1);
    check('  回插的是被删的那个人', redo[0].doc.userId, BID);
    check('  标注 restoredFromRace 便于事后在控制台认出来', redo[0].doc.restoredFromRace, true);
  });

  // ============================================================
  console.log('[whoami 身份诊断]');
  await withEnv(ADMIN_ENV, async function () {
    let db = makeDb({ data: baseData() });
    let r = await mod(mkCtx({ db: db, args: { action: 'whoami', password: 'wrong' } }));
    check('whoami 本身也要密码（否则就是个白拿身份的洞）', r.code, 'BAD_PASSWORD');

    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'whoami', password: PW } }));
    check('诊断结果标注可信', { ok: r.ok, mode: r.identityMode, present: r.trustedIdPresent },
      { ok: true, mode: 'trusted', present: true });

    check('ADMIN_DIAG 未开 → 不回显具体 ID', r.trustedId === undefined, true);
    check('  也不回显环境变量键名', r.envKeys === undefined, true);

    await withEnv({ ADMIN_DIAG: '1' }, async function () {
      const d2 = makeDb({ data: baseData() });
      const ctx = mkCtx({ db: d2, args: { action: 'whoami', password: PW }, ip: '9.9.9.9' });
      ctx.env.ADMIN_PASSWORD_LOOKALIKE = 'secret-value-should-not-leak';
      const r2 = await mod(ctx);
      check('ADMIN_DIAG=1 → 回显具体 ID 供比对', r2.trustedId, AID);
      check('  回显环境变量【键名】', Array.isArray(r2.envKeys) && r2.envKeys.indexOf('ADMIN_PASSWORD_LOOKALIKE') >= 0, true);
      check('  但绝不回显任何环境变量的【值】',
        JSON.stringify(r2).indexOf('secret-value-should-not-leak') >= 0, false);
      check('  客户端自报与可信 ID 不一致时能看出来',
        (await mod(mkCtx({ db: makeDb({ data: baseData() }), args: { action: 'whoami', password: PW, callerId: 'uZ' } }))).trustedIdMatchesClaim,
        false);
    });
  });

  // ============================================================
  console.log('[日志脱敏]');
  await withEnv(ADMIN_ENV, async function () {
    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = function () {
      logs.push(Array.prototype.slice.call(arguments).join(' '));
    };
    try {
      // 一次失败的 grant（会走 safeEvent 的 catch 分支）+ 一次成功的 grant
      await mod(mkCtx({ db: makeDb({ data: baseData(), failOn: ['BITZHAdministrator.insertOne'] }),
        args: { action: 'grant', userId: TID, password: PW } }));
      await mod(mkCtx({ db: makeDb({ data: baseData(), failOn: ['Feeder.find'] }),
        args: { action: 'grant', userId: TID, password: PW } }));
      await mod(mkCtx({ db: makeDb({ data: baseData(), failOn: ['BITZHAdministrator.find'] }),
        args: { action: 'list', password: PW } }));
    } finally {
      console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
    }
    const all = logs.join('\n');
    check('日志里出现了明文密码 → 必须为 false', all.indexOf(PW) >= 0, false);
    check('日志里出现了密码摘要 → 必须为 false', all.indexOf(mod.sha256Hex(PW)) >= 0, false);
    check('日志里出现了 "password" 字段名 → 必须为 false', /password/i.test(all), false);
    check('确实产生了日志（否则上面三条是空过）', logs.length > 0, true);
  });

  // ============================================================
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常', e);
  process.exit(1);
});
