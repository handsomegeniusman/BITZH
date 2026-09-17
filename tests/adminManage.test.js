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
        // options（sort / limit）只记录不执行：本文件要断言的正是"查询有没有被限制住"
        //   （如 historyLimit 有没有真的传到 find 上），而不是模拟排序本身。
        find: async function (f, o) {
          calls.push({ name: name, m: 'find', filter: f, options: o });
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
        // 与 updateOne 同理，updateMany 也必须真的落盘：审批的幂等性靠"再批一次时读到的
        // canPost 已经是 true"来分支，桩不写库的话第二次调用读到的还是旧值，
        // 断言就变成了自说自话（本条由 [审批] 那组用例实测发现）。
        updateMany: async function (f, u) {
          calls.push({ name: name, m: 'updateMany', filter: f, update: u });
          maybeFail(name + '.updateMany');
          (data[name] || []).forEach(function (d) {
            if (!match(d, f || {})) return;
            if (u && u.$set) Object.assign(d, u.$set);
            if (u && u.$inc) {
              Object.keys(u.$inc).forEach(function (k) { d[k] = (Number(d[k]) || 0) + u.$inc[k]; });
            }
          });
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
    check('身份不可信 + 没带密码 → NEED_PASSWORD（不是 BAD_PASSWORD）', r.code, 'NEED_PASSWORD');
    // 【为什么区分这两个码】客户端要据此决定弹什么：NEED_PASSWORD → 弹密码输入框；
    //   BAD_PASSWORD → 报"密码错误"。混成一个码，用户第一次进页面看到的会是"密码错误"。
    check('  且提示文案指向"去填密码"而不是"密码错"',
      /密码/.test(r.msg) && !/错误/.test(r.msg), true);
    // 【更承重的一条】"没带密码"绝不能消耗失败额度 —— 否则每进一次页面算一次错，
    //   连点几次就把管理员自己锁在门外了（锁是共用的 AdminAuthFail 计数）。
    check('  且没有增加 AdminAuthFail 计数（空密码不算一次失败）',
      db.of('AdminAuthFail', 'updateOne').length, 0);
    check('  也没有写 lockUntil', db.of('AdminAuthFail', 'find').length, 0);

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
    check('身份不可信 + 无密码 → NEED_PASSWORD', r.code, 'NEED_PASSWORD');
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
  // 发布权限审批（applyDecision / decidePostApply / listApplies）
  // 本组是整个 adminManage 里最难人工验证的一段：审批会**永久**改变一个用户的权限，
  // 而且有两条入口（小程序 / 飞书）。所以每条入口的正例、反例、以及"到底写了几次库"都断言到。
  // ============================================================
  const SECRET = 'feishu-shared-secret';
  const SECRET_ENV = Object.assign({}, ADMIN_ENV, { FEISHU_INTERNAL_SECRET: SECRET });
  const APPLY_ID = TID + '_2026-09-16';

  /** baseData + 一条待审批申请 + 空黑名单 */
  function applyData(extra) {
    return baseData(Object.assign({
      PostApply: [{
        _id: APPLY_ID, userId: TID, nickName: '小明', avatarUrl: 'http://a/1.png',
        status: 'pending', appliedAt: new Date('2026-09-16T01:00:00Z'), dayKey: '2026-09-16',
        handledAt: null, handledBy: '', handledByTrusted: false, source: 'miniapp',
      }],
      BlackNum: [],
    }, extra || {}));
  }
  /** 走小程序入口审批一次 */
  function approveOnce(db, args) {
    return mod(mkCtx({
      db: db,
      args: Object.assign({ action: 'approvePost', userId: TID, applyId: APPLY_ID, password: PW }, args || {}),
    }));
  }

  await withEnv(SECRET_ENV, async function () {
    console.log('[审批 · 小程序入口]');

    // ---- 通过 ----
    let db = makeDb({ data: applyData() });
    let r = await approveOnce(db);
    check('通过 → ok', { ok: r.ok, decision: r.decision, noApply: r.noApply },
      { ok: true, decision: 'approve', noApply: false });
    check('  回显昵称（弹窗文案要用）', r.nickName, '小明');
    let up = db.of('Feeder', 'updateMany');
    check('Feeder.updateMany 恰好 1 次', up.length, 1);
    // 过滤条件必须是 userId：canPost 的读者是 initUserState 的 find('Feeder',{userId})
    check('  按 userId 过滤（不是 _id）', up[0].filter, { userId: TID });
    check('  $set.canPost 是布尔 true（不是 1 / 字符串）', up[0].update.$set.canPost, true);
    check('  canPostBy = 审批人 id', up[0].update.$set.canPostBy, AID);
    check('  canPostTime 是 Date', up[0].update.$set.canPostTime instanceof Date, true);
    // 审批通过同时发两样东西：发帖权（canPost）+ 审核模式豁免（enable）。
    // 【为什么这两条必须钉住】客户端的豁免判断读的正是 Feeder.enable（utils/auditGate.js）——
    // 若哪天有人"顺手"把 enable 从 $set 里删掉，审批通过的人就看不见内容了，
    // 而且**管理员自己测不出来**（他另有名册豁免兜着）。
    check('  $set.enable 同时写成布尔 true（审核模式豁免，与 canPost 一起发）',
      up[0].update.$set.enable, true);
    check('PostApply 标记 approved', db.data.PostApply[0].status, 'approved');
    check('  并记下处理人/来源/身份是否可信',
      { by: db.data.PostApply[0].handledBy, src: db.data.PostApply[0].source, t: db.data.PostApply[0].handledByTrusted },
      { by: AID, src: 'miniapp', t: true });
    check('  处理时间是一个 Date', db.data.PostApply[0].handledAt instanceof Date, true);

    // ---- 幂等：重复点「通过」不覆盖第一次的授予出处 ----
    // 【为什么这条重要】canPostTime/canPostBy 是"这个人是怎么拿到权限的"的审计记录。
    // 被后一次操作改写，回填进来的用户（canPostBy='backfill'）就会看起来像某个管理员批的。
    const grantedAt = db.data.Feeder[1].canPostTime;
    await approveOnce(db); // 第二次
    up = db.of('Feeder', 'updateMany');
    check('再点一次 → 仍然只按 userId 更新一次', up.length, 2);
    check('  但 $set 里不再含 canPostTime（不覆盖首次）', 'canPostTime' in up[1].update.$set, false);
    check('  也不含 canPostBy', 'canPostBy' in up[1].update.$set, false);
    check('  canPost 仍然写（幂等值不变，重复文档照样补齐）', up[1].update.$set.canPost, true);
    check('  用户文档上的授予时间没被改写', db.data.Feeder[1].canPostTime, grantedAt);

    // ---- 拒绝：绝不碰 Feeder ----
    // 【这是"不做撤销"的唯一执行点】「拒绝」在飞书群里是个很短很泛的词，一次误发
    // 若去写 canPost:false，就会抹掉一个已获批用户的权限。
    db = makeDb({ data: applyData() });
    r = await approveOnce(db, { action: 'rejectPost' });
    check('拒绝 → ok', { ok: r.ok, decision: r.decision }, { ok: true, decision: 'reject' });
    check('  Feeder 写入次数 === 0（"不做撤销"的执行点）', db.of('Feeder', 'updateMany').length, 0);
    check('  Feeder 上的 canPost 未被写', 'canPost' in (db.data.Feeder[1] || {}), false);
    // 同上：拒绝也绝不写 enable。写 enable:false 会把一个已开通豁免的人从内容里踢出去，
    // 而"拒绝"在飞书群里是个又短又泛的词，误发的代价太大。
    check('  Feeder 上的 enable 也未被写', 'enable' in (db.data.Feeder[1] || {}), false);
    check('  申请行标为 rejected', db.data.PostApply[0].status, 'rejected');
    check('  申请行记下 source=miniapp', db.data.PostApply[0].source, 'miniapp');

    // ---- 黑名单一票否决 ----
    db = makeDb({ data: applyData({ BlackNum: [{ _id: 'b1', id: TID, reason: '内容违规' }] }) });
    r = await approveOnce(db);
    check('黑名单用户即便点「通过」也是 BLACKLISTED', { ok: r.ok, code: r.code },
      { ok: false, code: 'BLACKLISTED' });
    check('  零写入（Feeder）', db.of('Feeder', 'updateMany').length, 0);
    check('  申请行保持 pending（未处理）', db.data.PostApply[0].status, 'pending');

    // ---- 非注册用户 ----
    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A, ADMIN_B], Feeder: [], AdminAuthFail: [], PostApply: [], BlackNum: [] } });
    r = await approveOnce(db);
    check('未注册用户 → NOT_FEEDER', { ok: r.ok, code: r.code }, { ok: false, code: 'NOT_FEEDER' });
    check('  零写入', db.of('Feeder', 'updateMany').length, 0);

    // ---- 畸形 userId：必须在任何 DB 调用之前返回 ----
    db = makeDb({ data: applyData() });
    r = await approveOnce(db, { userId: '../etc/passwd' });
    check('畸形 userId → BAD_USER_ID', { ok: r.ok, code: r.code }, { ok: false, code: 'BAD_USER_ID' });
    check('  连 Feeder 都没查（校验在过滤条件进库之前）', db.of('Feeder', 'find').length, 0);

    // ---- 没有申请行（管理员主动授予 / 回填用户）：照批，不因为"没申请过"就拒绝 ----
    db = makeDb({ data: applyData({ PostApply: [] }) });
    r = await approveOnce(db);
    check('没有 PostApply 行 → 仍然授予，但如实标 noApply', { ok: r.ok, noApply: r.noApply }, { ok: true, noApply: true });
    check('  且确实写了 Feeder', db.of('Feeder', 'updateMany').length, 1);

    // ---- 写动作永远要密码（即便身份可信）----
    db = makeDb({ data: applyData() });
    r = await approveOnce(db, { password: 'wrong-password' });
    check('密码错 → BAD_PASSWORD（trusted 也不能免）', { ok: r.ok, code: r.code },
      { ok: false, code: 'BAD_PASSWORD' });
    check('  零写入', db.of('Feeder', 'updateMany').length, 0);

    console.log('[审批 · 飞书入口 decidePostApply]');

    // ---- 正例：密钥对 → 与小程序走同一个 applyDecision ----
    db = makeDb({ data: applyData() });
    r = await mod(mkCtx({ db: db, args: { action: 'decidePostApply', internalSecret: SECRET, decision: 'approve', userId: TID, applyId: APPLY_ID } }));
    check('密钥正确 → ok', { ok: r.ok, decision: r.decision }, { ok: true, decision: 'approve' });
    check('  同样写了 canPost', db.of('Feeder', 'updateMany')[0].update.$set.canPost, true);
    check('  申请行 source 记为 feishu', db.data.PostApply[0].source, 'feishu');
    check('  handledBy 记为 feishu（这条路上没有管理员身份）', db.data.PostApply[0].handledBy, 'feishu');
    check('  handledByTrusted = true', db.data.PostApply[0].handledByTrusted, true);

    // ---- 安全反例：调用者**确实是管理员**，但密钥错 → 必须走密钥分支，绝不落进管理员分支 ----
    // 【这是本设计最关键的一条】decidePostApply 被刻意放在管理员校验之外，
    // 如果密钥校验被绕过/写错，它会直接落到"我是不是管理员"上 —— 那么任何一个管理员
    // 都能不输密码批准发布权。用"真管理员 + 错密钥"来钉住它。
    db = makeDb({ data: applyData() });
    r = await mod(mkCtx({ db: db, args: { action: 'decidePostApply', internalSecret: 'guess', decision: 'approve', userId: TID, callerId: AID } }));
    check('真管理员 + 错密钥 → 仍是 BAD_INTERNAL_SECRET', { ok: r.ok, code: r.code },
      { ok: false, code: 'BAD_INTERNAL_SECRET' });
    check('  零写入', db.of('Feeder', 'updateMany').length, 0);

    // ---- fail-closed：没配密钥 = 哑掉，而不是"随便传个值就能批" ----
    await withEnv({ FEISHU_INTERNAL_SECRET: undefined }, async function () {
      db = makeDb({ data: applyData() });
      r = await mod(mkCtx({ db: db, args: { action: 'decidePostApply', internalSecret: SECRET, decision: 'approve', userId: TID } }));
      check('密钥未配置 → NO_INTERNAL_SECRET（传对值也不放行）', { ok: r.ok, code: r.code },
        { ok: false, code: 'NO_INTERNAL_SECRET' });
      check('  零写入', db.of('Feeder', 'updateMany').length, 0);
    });

    // ---- decision 取值 ----
    db = makeDb({ data: applyData() });
    r = await mod(mkCtx({ db: db, args: { action: 'decidePostApply', internalSecret: SECRET, decision: 'yolo', userId: TID } }));
    check('decision 非法 → BAD_DECISION', { ok: r.ok, code: r.code }, { ok: false, code: 'BAD_DECISION' });
    check('  零写入', db.of('Feeder', 'updateMany').length, 0);

    // ============================================================
    // 撤销「审核模式豁免」（revokeEnable）
    // ============================================================
    // 本组有三条是承重的，各自对应一种"看起来能跑但其实是坏的"实现：
    //   ① 撤销只写 enable 不写 enableRevoked → 本人连点五次就复原，撤销等于没撤；
    //   ② 撤销顺手把 canPost 也写成 false → 「撤销豁免」变成了"发布权撤销"，
    //      而用户明确只要前者（enable 与 canPost 是两回事，见 revokeEnable 注释）；
    //   ③ 密钥校验被绕过 → 任何人都能锁掉别人。
    // 【2026-09-17 删掉了"恢复"那一半】原 restoreEnable 逆操作的断言换成两条：
    //   一条钉住"这个 action 已经不存在了"（下面的 restoreEnable 反例），
    //   一条钉住"误撤销的退路还在"（审批通过清锁，见本文件后面的 applyDecision 组）。
    console.log('[豁免 · 撤销 revokeEnable]');
    const revokedSet = {};
    {
      db = makeDb({ data: baseData({ BlackNum: [] }) });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: SECRET, userId: TID, actorId: 'ou_feishu_user' } }));
      check('撤销 → ok', { ok: r.ok, action: r.action, enabled: r.enabled },
        { ok: true, action: 'revokeEnable', enabled: false });
      check('  回显昵称（飞书回执要靠它确认没撤错人）', r.nickName, '小明');
      up = db.of('Feeder', 'updateMany');
      check('Feeder.updateMany 恰好 1 次', up.length, 1);
      check('  按 userId 过滤（不是 _id，重复文档要一起打上）', up[0].filter, { userId: TID });
      Object.assign(revokedSet, up[0].update.$set);
      // ① 两个字段必须**一起**写：光 enable:false 不持久、光 enableRevoked 不生效
      check('  $set.enable 写成布尔 false（auditGate 读的就是它）', up[0].update.$set.enable, false);
      check('  $set.enableRevoked 写成布尔 true（锁：postApply.selfEnable 读它）',
        up[0].update.$set.enableRevoked, true);
      // ② 【本组最重要的一条】撤销豁免**不是**发布权撤销
      check('  ⚠️ $set 里绝不含 canPost（撤销豁免 ≠ 撤销发帖权）', 'canPost' in up[0].update.$set, false);
      check('  ⚠️ 也不含 mutePost / canPostBy / canPostTime',
        ['mutePost', 'canPostBy', 'canPostTime'].filter(function (k) { return k in up[0].update.$set; }), []);
      check('  $set 的字段集合就是这四个（多一个都是越权）',
        Object.keys(up[0].update.$set).sort(),
        ['enable', 'enableRevoked', 'enableRevokedBy', 'enableRevokedTime']);
      check('  enableRevokedTime 是 Date', up[0].update.$set.enableRevokedTime instanceof Date, true);
      // 审计：这是剥夺类操作，要能回答"是谁撤的" —— 与 applyDecision 写死 'feishu' 刻意不同
      check('  enableRevokedBy 记的是飞书发送者（不是常量 feishu）',
        up[0].update.$set.enableRevokedBy, 'ou_feishu_user');
      check('  库上真的落了盘', db.data.Feeder[1].enableRevoked, true);
      check('  且没把发帖权弄丢', 'canPost' in db.data.Feeder[1], false);
    }
    {
      // 【幂等】重复撤销只是把同样的值再写一遍。不需要 moderate 那套 opId 去重表。
      db = makeDb({ data: baseData({ BlackNum: [] }) });
      await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: SECRET, userId: TID } }));
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: SECRET, userId: TID } }));
      check('重复撤销 → 仍然 ok（幂等，不报"已经撤过了"）', r.ok, true);
      check('  写了两次同样的值', db.of('Feeder', 'updateMany').length, 2);
      check('  最终状态没变', { e: db.data.Feeder[1].enable, k: db.data.Feeder[1].enableRevoked },
        { e: false, k: true });
    }
    {
      // 【多余的 on 参数不再有任何作用】原先它由 action 名派生（调用方塞 on:true 翻不过来）；
      //   现在 revokeEnable() 根本不读 on —— 断言它照样只做"收回"，把这条口径钉住，
      //   免得将来有人为了"顺手支持恢复"又把这个参数接回去。
      db = makeDb({ data: baseData({ BlackNum: [] }) });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: SECRET, userId: TID, on: true } }));
      check('多传一个 on:true 毫无作用（revokeEnable 不读它）',
        { ok: r.ok, enabled: r.enabled, rev: db.data.Feeder[1].enableRevoked },
        { ok: true, enabled: false, rev: true });
    }
    {
      // 【已删除的动作名必须彻底死掉】restoreEnable 这条命令 2026-09-17 按需求方口径删除。
      //   留着这条反例是因为"删干净"最容易做一半：feishuCallback 那边删了命令、adminManage
      //   这边的分支却还在，于是**任何能 invoke 到这个云函数的人**仍然可以把豁免给回去 ——
      //   一个谁都用不到、却真实存在的提权口子。断言：未知 action + 零写入。
      db = makeDb({
        data: baseData({
          BlackNum: [],
          Feeder: [
            { _id: 'f0', userId: AID, nickName: '甲' },
            { _id: 'f1', userId: TID, nickName: '小明', enable: false, enableRevoked: true },
          ],
        }),
      });
      r = await mod(mkCtx({ db: db, args: { action: 'restoreEnable', internalSecret: SECRET, userId: TID } }));
      check('  ⚠️ restoreEnable 已不存在 → 未知 action（不是"偷偷还能用"）',
        { ok: r.ok, msg: r.msg }, { ok: false, msg: '未知 action: restoreEnable' });
      check('     零写入（锁没被解开）',
        [db.of('Feeder', 'updateMany').length, db.data.Feeder[1].enableRevoked], [0, true]);
    }

    console.log('[豁免 · 鉴权（与 decidePostApply 同款，且 fail-closed）]');
    {
      db = makeDb({ data: baseData({ BlackNum: [] }) });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: 'guess', userId: TID } }));
      check('密钥错 → BAD_INTERNAL_SECRET', { ok: r.ok, code: r.code }, { ok: false, code: 'BAD_INTERNAL_SECRET' });
      check('  零写入', db.of('Feeder', 'updateMany').length, 0);
    }
    {
      // 【本组最关键的一条】这个 action 被刻意放在管理员校验**之外**（同 decidePostApply）。
      //   若密钥校验被绕过/写错，它会落到"我是不是管理员"上 —— 那么任何管理员都能不输密码
      //   锁掉别人的豁免。用"真管理员 + 错密钥"钉住它。
      db = makeDb({ data: baseData({ BlackNum: [] }) });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: 'guess', userId: TID, password: PW, callerId: AID } }));
      check('真管理员 + 正确密码 + 错密钥 → 仍是 BAD_INTERNAL_SECRET', { ok: r.ok, code: r.code },
        { ok: false, code: 'BAD_INTERNAL_SECRET' });
      check('  零写入（没有落到管理员那条路上）', db.of('Feeder', 'updateMany').length, 0);
    }
    {
      // 【反向】不给密钥 = 不给走。这个 action 目前**只有**飞书一个入口，
      //   没有"我是管理员所以我带密码就行"的第二条路（真要做小程序按钮时把它加进
      //   ADMIN_ACTIONS 即可，见 handle() 里那条注释）——在那之前，这条必须是关的。
      db = makeDb({ data: baseData({ BlackNum: [] }) });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', userId: TID, password: PW, callerId: AID } }));
      // 这里是 BAD_INTERNAL_SECRET 而**不是** NO_INTERNAL_SECRET：本组 withEnv 里密钥是配着的，
      // 只是这次调用没带而已。两者都是拒绝，但区分开才能证明"确实走了密钥那条路"。
      check('管理员 + 正确密码但没带密钥 → 走密钥分支被拒（当前没有小程序入口）',
        { ok: r.ok, code: r.code }, { ok: false, code: 'BAD_INTERNAL_SECRET' });
      check('  零写入', db.of('Feeder', 'updateMany').length, 0);
    }
    await withEnv({ FEISHU_INTERNAL_SECRET: undefined }, async function () {
      db = makeDb({ data: baseData({ BlackNum: [] }) });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: SECRET, userId: TID } }));
      check('密钥未配置 → NO_INTERNAL_SECRET（fail-closed，传对值也不放行）',
        { ok: r.ok, code: r.code }, { ok: false, code: 'NO_INTERNAL_SECRET' });
      check('  零写入', db.of('Feeder', 'updateMany').length, 0);
    });

    console.log('[豁免 · 入参与失败路径]');
    {
      db = makeDb({ data: baseData({ BlackNum: [] }) });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: SECRET, userId: '../etc/passwd' } }));
      check('畸形 userId → BAD_USER_ID', { ok: r.ok, code: r.code }, { ok: false, code: 'BAD_USER_ID' });
      check('  连 Feeder 都没查（校验在过滤条件进库之前）', db.of('Feeder', 'find').length, 0);
    }
    {
      db = makeDb({ data: baseData({ BlackNum: [] }) });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: SECRET, userId: BID } }));
      check('未注册用户（没有 Feeder 文档）→ NOT_FEEDER', { ok: r.ok, code: r.code },
        { ok: false, code: 'NOT_FEEDER' });
      check('  零写入', db.of('Feeder', 'updateMany').length, 0);
    }
    {
      db = makeDb({ data: baseData({ BlackNum: [] }), failOn: ['Feeder.find'] });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: SECRET, userId: TID } }));
      check('资料查询抛错 → LOOKUP_FAILED（不当成"没注册"）', { ok: r.ok, code: r.code },
        { ok: false, code: 'LOOKUP_FAILED' });
      check('  零写入', db.of('Feeder', 'updateMany').length, 0);
    }
    {
      db = makeDb({ data: baseData({ BlackNum: [] }), failOn: ['Feeder.updateMany'] });
      r = await mod(mkCtx({ db: db, args: { action: 'revokeEnable', internalSecret: SECRET, userId: TID } }));
      check('写库失败 → WRITE_FAILED（不谎报成功）', { ok: r.ok, code: r.code },
        { ok: false, code: 'WRITE_FAILED' });
    }

    console.log('[豁免 · 审批通过要解掉这个锁（误撤销的常规恢复路径）]');
    {
      // 【为什么必须有这条】撤销会上锁，而锁只有管理员能解。如果审批通过不清它，
      //   被误撤销的人就只剩"去控制台改库"一条路 —— 那正是这个需求想避免的误操作反过来咬人。
      db = makeDb({
        data: applyData({
          Feeder: [
            { _id: 'f0', userId: AID, nickName: '甲' },
            { _id: 'f1', userId: TID, nickName: '小明', enable: false, enableRevoked: true },
          ],
        }),
      });
      r = await approveOnce(db);
      check('撤过豁免的人照样能被批准发布权（锁不阻止审批）',
        { ok: r.ok, decision: r.decision }, { ok: true, decision: 'approve' });
      up = db.of('Feeder', 'updateMany');
      check('  审批的 $set 里带着 enableRevoked: false（把锁清掉）',
        up[0].update.$set.enableRevoked, false);
      check('  同时照旧给 enable: true', up[0].update.$set.enable, true);
      check('  库上锁已解开', db.data.Feeder[1].enableRevoked, false);
    }

    console.log('[豁免 · 跨函数契约：writer(adminManage) ↔ reader(postApply)]');
    {
      // 【为什么值得单独跑一遍】"锁"这个概念只有两个端点：上面写 enableRevoked，
      //   postApply.selfEnable 读它。两个文件各钉一个同名字面量只能证明"都写了这个词"，
      //   证不了它们**互相认识**（一边写成 enableRevoked、另一边 enableRevoke 就哑了，
      //   而表现只是"撤销后本人还能自己开回来"，没有任何报错）。所以把这次真正写进库的
      //   文档原样喂给 postApply。
      const postApply = require('../cloudfunctions/postApply/index.js');
      // 【必须自己现撤一次，不能复用上面任何一个 db】上一个用例刚跑完审批，
      //   而审批会把锁清掉 —— 复用的话拿到的文档是 enable:true/enableRevoked:false，
      //   于是整组断言在测一个"根本没被撤销"的人，而且会以 ALREADY_ENABLED 假通过。
      //   （这条是被本文件实测逼出来的：初版就是这么写的，三条断言全红。）
      const rdb = makeDb({ data: baseData({ BlackNum: [] }) });
      await mod(mkCtx({ db: rdb, args: { action: 'revokeEnable', internalSecret: SECRET, userId: TID } }));
      const revokedDoc = Object.assign({}, rdb.data.Feeder[1]);
      check('前置：刚才那次撤销真的把文档写成了"已撤销"状态',
        { e: revokedDoc.enable, k: revokedDoc.enableRevoked }, { e: false, k: true });
      const pWritten = [];
      const pdb = {
        collection: function () {
          return {
            find: async function () { return { result: [Object.assign({}, revokedDoc)] }; },
            updateMany: async function (f, u) { pWritten.push(u); return {}; },
          };
        },
      };
      const pr = await postApply({
        args: { action: 'selfEnable' },
        mpserverless: {
          db: pdb,
          user: { getInfo: async function () { return { result: { user: { userId: TID } } }; } },
          function: { invoke: async function () { return {}; } },
        },
      });
      check('  ⚠️ postApply 认得出这把锁并拒绝自助开通',
        { ok: pr.ok, code: pr.code }, { ok: false, code: 'ENABLE_REVOKED' });
      check('    且它一个字段都没写（锁的唯一作用点就在这里）', pWritten.length, 0);
    }

    console.log('[审批 · 待办队列 listApplies]');

    db = makeDb({
      data: baseData({
        PostApply: [
          { _id: 'x1', userId: TID, nickName: '旧昵称', status: 'pending', appliedAt: new Date('2026-09-15T01:00:00Z') },
          { _id: 'x2', userId: BID, nickName: '乙', status: 'approved', appliedAt: new Date('2026-09-14T01:00:00Z') },
        ],
      }),
    });
    // listApplies 是只读动作：身份可信时可免密码（与 list 同一张表）
    r = await mod(mkCtx({ db: db, args: { action: 'listApplies' } }));
    check('待办队列只列 pending（已处理的不出现）', { ok: r.ok, total: r.total, ids: (r.applies || []).map((a) => a.applyId) },
      { ok: true, total: 1, ids: ['x1'] });
    check('  昵称用**实时**资料覆盖申请快照（用户改过昵称）', r.applies[0].nickName, '小明');
    check('  applyId 就是 PostApply 的 _id（审批时要原样回传）', r.applies[0].applyId, 'x1');
    check('  过滤条件为 status:pending', db.of('PostApply', 'find')[0].filter, { status: 'pending' });
    check('  identityMode 如实回传', r.identityMode, 'trusted');
  });

  // ============================================================
  console.log('\n[authCheck：只验密码，不读业务数据]');
  // 存在的意义：让「管理员」页在"填的时候就告诉用户密码对不对"。
  // 不能用 list 代替 —— list 是免密动作，身份可信时根本不校验密码，拿它验等于永远通过。
  // ============================================================
  await withEnv(ADMIN_ENV, async function () {
    let db = makeDb({ data: baseData() });
    let r = await mod(mkCtx({ db: db, args: { action: 'authCheck', callerId: AID, password: PW } }));
    check('对的密码 → ok', { ok: r.ok, action: r.action }, { ok: true, action: 'authCheck' });
    check('  不回传任何业务数据（免得变成新的信息泄露口）',
      Object.keys(r).sort(), ['action', 'identityMode', 'ok']);

    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'authCheck', callerId: AID, password: 'wrong' } }));
    check('错的密码 → BAD_PASSWORD', r.code, 'BAD_PASSWORD');

    // 【承重】authCheck 永远不能免密。若有人"顺手"把它加进 PASSWORD_OPTIONAL，
    //   它就会变成永远返回 ok —— 于是错密码被存进客户端缓存，等到真审批时才炸。
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({ db: db, args: { action: 'authCheck', callerId: AID } }));
    check('没带密码 → NEED_PASSWORD（authCheck 不得进入免密名单）', r.code, 'NEED_PASSWORD');

    // 身份可信也一样要密码 —— 这正是它跟 list 的区别
    db = makeDb({ data: baseData(), trustId: AID });
    r = await mod(mkCtx({ db: db, args: { action: 'authCheck', callerId: AID } }));
    check('身份可信 + 没带密码 → 仍要密码（它跟 list 的区别就在这）', r.code, 'NEED_PASSWORD');

    // 非管理员连验密码的资格都没有（省得外人拿它当密码探测器刷）
    // 【必须让 getInfo 抛错】否则默认桩会返回可信身份 AID，自报的 TID 根本不会被采信
    //   （老用例同样这么写，见上面"自报一个非管理员 ID → NOT_ADMIN"）。
    db = makeDb({ data: baseData() });
    r = await mod(mkCtx({
      db: db, args: { action: 'authCheck', callerId: TID, password: PW },
      getInfo: async function () { throw new Error('x'); },
    }));
    check('非管理员 → NOT_ADMIN（不给外人当密码探测器用）', r.code, 'NOT_ADMIN');
  });

  // ============================================================
  console.log('\n[listApplies：待办 + 最近处理历史]');
  // ============================================================
  await withEnv(ADMIN_ENV, async function () {
    const applied = new Date('2026-09-16T02:00:00Z');
    const handled = new Date('2026-09-16T03:00:00Z');
    const rows = [
      { _id: 'U1_2026-09-16', userId: 'U1', nickName: '快照甲', status: 'pending', appliedAt: applied },
      { _id: 'U2_2026-09-15', userId: 'U2', nickName: '快照乙', status: 'approved', appliedAt: applied,
        handledAt: handled, handledByName: '管理员丙', handledBy: BID, source: 'miniapp' },
      { _id: 'U3_2026-09-14', userId: 'U3', nickName: '快照丙', status: 'rejected', appliedAt: applied,
        handledAt: handled, handledBy: '', source: 'feishu' },
    ];
    const db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], Feeder: [{ userId: 'U1', nickName: '实时甲' }], PostApply: rows, BlackNum: [], AdminAuthFail: [] } });
    const r = await mod(mkCtx({ db: db, args: { action: 'listApplies', callerId: AID, password: PW } }));

    check('待办只收 pending', r.applies.map(function (x) { return x.userId; }), ['U1']);
    check('  昵称用实时资料覆盖快照', r.applies[0].nickName, '实时甲');
    check('历史收两种终态、倒序由服务端 sort 决定', r.historyTotal, 2);
    check('  已通过的那条 approved=true', r.history[0].approved, true);
    check('  处理人姓名快照被带出来', r.history[0].handledByName, '管理员丙');
    check('  快照缺失时回落到 id 掩码', r.history[1].handledByMasked, '');
    check('  历史行也补了头像/昵称字段（页面直接渲染）',
      r.history[0].userId, 'U2');

    // 待办永远是 pending；历史查询必须显式限定终态，
    // 用 $ne:'pending' 会把"没有 status 的畸形行"也捞进历史里。
    const findCalls = db.of('PostApply', 'find');
    check('历史查询限定为两种终态',
      findCalls.some(function (c) { return JSON.stringify(c.filter) === JSON.stringify({ status: { $in: ['approved', 'rejected'] } }); }), true);

    // historyLimit 要真的传到 find 上（默认 20、封顶 50）
    const db2 = makeDb({ data: { BITZHAdministrator: [ADMIN_A], Feeder: [], PostApply: rows, BlackNum: [], AdminAuthFail: [] } });
    await mod(mkCtx({ db: db2, args: { action: 'listApplies', callerId: AID, password: PW, historyLimit: 5 } }));
    const hist = db2.of('PostApply', 'find').filter(function (c) { return c.options && c.options.limit === 5; });
    check('historyLimit 透传到 find.limit', hist.length, 1);
    check('  且带了 handledAt 倒序', hist[0].options.sort, { handledAt: -1 });

    const db3 = makeDb({ data: { BITZHAdministrator: [ADMIN_A], Feeder: [], PostApply: rows, BlackNum: [], AdminAuthFail: [] } });
    await mod(mkCtx({ db: db3, args: { action: 'listApplies', callerId: AID, password: PW, historyLimit: 9999 } }));
    check('historyLimit 封顶 50（客户端不能把函数拖垮）',
      db3.of('PostApply', 'find').filter(function (c) { return c.options && c.options.limit === 50; }).length, 1);

    const db4 = makeDb({ data: { BITZHAdministrator: [ADMIN_A], Feeder: [], PostApply: rows, BlackNum: [], AdminAuthFail: [] } });
    await mod(mkCtx({ db: db4, args: { action: 'listApplies', callerId: AID, password: PW } }));
    check('不传 historyLimit → 默认 20',
      db4.of('PostApply', 'find').filter(function (c) { return c.options && c.options.limit === 20; }).length, 1);
  });

  // ============================================================
  console.log('\n[审批写入处理人姓名快照]');
  // 「最近处理」历史里要显示"谁批的"，而这条历史必须在处理人后来被移出管理员名单后
  // 仍然读得出来 —— 所以要在审批当时把名字抄下来，不能靠事后 join。
  // ============================================================
  await withEnv(ADMIN_ENV, async function () {
    // 申请人必须是**形态合法**的 24 位 id —— applyDecision 第一步就是 badUserId 校验，
    // 用 'U1' 这种短串会直接被 BAD_USER_ID 挡在门口（不会走到写申请行那一步）。
    const APPLICANT = '64fa07d6a09a9bd68b13a8a9';
    const APPLY_ID = APPLICANT + '_2026-09-16';
    const db = makeDb({ data: {
      BITZHAdministrator: [ADMIN_A], AdminAuthFail: [],
      Feeder: [{ userId: APPLICANT, nickName: '申请人' }, { userId: AID, nickName: '批的人' }],
      BlackNum: [], PostApply: [{ _id: APPLY_ID, userId: APPLICANT, status: 'pending' }],
    } });
    await mod(mkCtx({ db: db, args: { action: 'approvePost', userId: APPLICANT, applyId: APPLY_ID, callerId: AID, password: PW } }));
    const set = db.of('PostApply', 'updateOne')[0].update.$set;
    check('handledByName 写入的是处理人昵称', set.handledByName, '批的人');
    check('handledBy 仍然存 id（审计用）', set.handledBy, AID);

    // 处理人没有 Feeder 资料（手工在控制台加的管理员）→ 空串，不报错
    const db2 = makeDb({ data: {
      BITZHAdministrator: [ADMIN_A], AdminAuthFail: [],
      Feeder: [{ userId: APPLICANT, nickName: '申请人' }],
      BlackNum: [], PostApply: [{ _id: APPLY_ID, userId: APPLICANT, status: 'pending' }],
    } });
    const r2 = await mod(mkCtx({ db: db2, args: { action: 'approvePost', userId: APPLICANT, applyId: APPLY_ID, callerId: AID, password: PW } }));
    check('处理人查不到资料时审批照样成功', r2.ok, true);
    check('  姓名落空串而不是 undefined', db2.of('PostApply', 'updateOne')[0].update.$set.handledByName, '');
  });

  // ============================================================
  console.log('\n[动态词库：增 / 删 / 查]');
  // 词库是全局生效的（一个「的」字就能把所有人的发布打死），所以写入必须过密码。
  // ============================================================
  await withEnv(ADMIN_ENV, async function () {
    // ---- 查 ----
    let db = makeDb({ data: {
      BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [],
      SensitiveWord: [
        { _id: '猫贩子', word: '猫贩子', raw: '猫贩子', tier: 'block', by: AID, time: new Date('2026-09-16T01:00:00Z') },
        { _id: '火钳子', word: '火钳子', raw: '火钳子', tier: 'review', by: AID, time: new Date('2026-09-16T02:00:00Z') },
      ],
    } });
    let r = await mod(mkCtx({ db: db, args: { action: 'listWords', callerId: AID, password: PW } }));
    check('列出词条', r.total, 2);
    // 用 map 而不是数组顺序断言 —— mock 的 find 刻意不实现 sort（真实排序由数据库做），
    // 按顺序断言会变成在测 mock。排序意图单独断言在下面。
    check('  tier 如实带出', r.words.map(function (x) { return x.word + '=' + x.tier; }),
      ['猫贩子=block', '火钳子=review']);
    check('  查词库时按加入时间倒序（新的在前）',
      db.of('SensitiveWord', 'find')[0].options, { sort: { time: -1 }, limit: 300 });
    check('  统计拦截档条数（页面要显示）', r.blocked, 1);
    check('  上限值带回给页面', r.max, 300);
    check('  作者 id 打掩码，不原样吐 openid', /^.{4}\*+.{0,4}$/.test(r.words[0].by) || r.words[0].by === '', true);

    // ---- 增 ----
    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'addWord', word: '  猫 贩子  ', callerId: AID, password: PW } }));
    check('新增成功', { ok: r.ok, added: r.added, tier: r.tier }, { ok: true, added: true, tier: 'block' });
    check('  默认档位是 block', r.tier, 'block');
    check('  入库前去掉空白（去重键）', db.of('SensitiveWord', 'insertOne')[0].doc._id, '猫贩子');
    check('  原文另存一份备查', db.of('SensitiveWord', 'insertOne')[0].doc.raw, '猫 贩子');
    check('  记下是谁加的', db.of('SensitiveWord', 'insertOne')[0].doc.by, AID);

    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'addWord', word: '火钳子', tier: 'review', callerId: AID, password: PW } }));
    check('可以指定 review 档（放行但标记）', { tier: r.tier, added: r.added }, { tier: 'review', added: true });

    // ---- 边界：单字 / 空 / 超长 ----
    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'addWord', word: '毒', callerId: AID, password: PW } }));
    check('单字词被拒（会把所有人的发布打死）', r.code, 'WORD_TOO_SHORT');
    check('  且没写库', db.of('SensitiveWord', 'insertOne').length, 0);

    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'addWord', word: '   ', callerId: AID, password: PW } }));
    check('纯空白被拒', r.code, 'WORD_EMPTY');

    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'addWord', word: new Array(30).join('词'), callerId: AID, password: PW } }));
    check('超长被拒（要填词组不是整句话）', r.code, 'WORD_TOO_LONG');

    // ---- 已存在 → 改档位，而不是报错 ----
    db = makeDb({ data: {
      BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [],
      SensitiveWord: [{ _id: '猫贩子', word: '猫贩子', tier: 'review' }],
    } });
    r = await mod(mkCtx({ db: db, args: { action: 'addWord', word: '猫贩子', tier: 'block', callerId: AID, password: PW } }));
    check('已存在且档位不同 → 改档而不是报错', { ok: r.ok, added: r.added, updated: r.updated }, { ok: true, added: false, updated: true });
    check('  真的写了库', db.of('SensitiveWord', 'updateOne')[0].update.$set.tier, 'block');

    db = makeDb({ data: {
      BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [],
      SensitiveWord: [{ _id: '猫贩子', word: '猫贩子', tier: 'block' }],
    } });
    r = await mod(mkCtx({ db: db, args: { action: 'addWord', word: '猫贩子', callerId: AID, password: PW } }));
    check('已存在且档位相同 → 幂等成功，不重复写', { ok: r.ok, added: r.added }, { ok: true, added: false });
    check('  没有多余的写', db.of('SensitiveWord', 'updateOne').length, 0);

    // ---- 容量上界 ----
    const full = [];
    for (let i = 0; i < 300; i++) full.push({ _id: 'x' + i, word: 'x' + i, tier: 'block' });
    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: full } });
    r = await mod(mkCtx({ db: db, args: { action: 'addWord', word: '新词条', callerId: AID, password: PW } }));
    check('词库满 → 拒绝并提示去删', r.code, 'WORD_BANK_FULL');
    check('  且没写库', db.of('SensitiveWord', 'insertOne').length, 0);

    // ---- 删除 ----
    db = makeDb({ data: {
      BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [],
      SensitiveWord: [{ _id: '猫贩子', word: '猫贩子', tier: 'block' }],
    } });
    r = await mod(mkCtx({ db: db, args: { action: 'delWord', word: '猫贩子', callerId: AID, password: PW } }));
    check('删除成功', { ok: r.ok, word: r.word }, { ok: true, word: '猫贩子' });
    check('  按 _id 删', db.of('SensitiveWord', 'deleteOne')[0].filter, { _id: '猫贩子' });

    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'delWord', word: '  ', callerId: AID, password: PW } }));
    check('删空词被拒', r.code, 'WORD_EMPTY');

    // ---- 写动作必须过密码 + 必须是管理员 ----
    // 词库全局生效 → 写入是本文件里"影响面最大"的动作，这两条是它的全部门槛。
    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'addWord', word: '猫贩子', callerId: AID } }));
    check('addWord 不带密码 → NEED_PASSWORD', r.code, 'NEED_PASSWORD');
    check('  且没写库', db.of('SensitiveWord', 'insertOne').length, 0);

    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'delWord', word: '猫贩子', callerId: AID } }));
    check('delWord 不带密码 → NEED_PASSWORD', r.code, 'NEED_PASSWORD');
    check('  且没删', db.of('SensitiveWord', 'deleteOne').length, 0);

    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({
      db: db, args: { action: 'addWord', word: '猫贩子', callerId: TID, password: PW },
      getInfo: async function () { throw new Error('x'); },
    }));
    check('非管理员即使带对密码也写不了', r.code, 'NOT_ADMIN');
    check('  且没写库', db.of('SensitiveWord', 'insertOne').length, 0);

    // ---- 一键导入推荐词表（seedWords）----
    // 词表在服务端常量里，客户端只发空请求。这里先查清单本身，再查导入行为。
    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'seedWords', callerId: AID, password: PW } }));
    const seed = mod.SEED_WORDS;
    check('导入成功且总数对得上', { ok: r.ok, listTotal: r.listTotal }, { ok: true, listTotal: seed.length });
    check('  全部是新增（空词库）', { added: r.added, updated: r.updated, kept: r.kept, failed: r.failed.length },
      { added: seed.length, updated: 0, kept: 0, failed: 0 });
    check('  真的逐条写了库', db.of('SensitiveWord', 'insertOne').length, seed.length);
    check('  写进去的档位和清单一致（抽查 block/review 各一条）',
      db.of('SensitiveWord', 'insertOne').filter(function (x) {
        return x.doc._id === '踢猫' ? x.doc.tier === 'block' : (x.doc._id === '猫奴' ? x.doc.tier === 'review' : false);
      }).length, 2);

    // 幂等：再点一次不该产生重复行、也不该报错
    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    await mod(mkCtx({ db: db, args: { action: 'seedWords', callerId: AID, password: PW } }));
    const firstPass = db.of('SensitiveWord', 'insertOne').length;
    await mod(mkCtx({ db: db, args: { action: 'seedWords', callerId: AID, password: PW } }));
    check('重复导入不产生重复行（第二次全部 kept）', db.of('SensitiveWord', 'insertOne').length, firstPass);
    check('  第二次没有多余的 update', db.of('SensitiveWord', 'updateOne').length, 0);

    // 已存在但档位不同 → 第二次导入负责改回来（复用 addWord 的改档语义）
    db = makeDb({ data: {
      BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [],
      SensitiveWord: [{ _id: '踢猫', word: '踢猫', tier: 'review' }],
    } });
    r = await mod(mkCtx({ db: db, args: { action: 'seedWords', callerId: AID, password: PW } }));
    check('已存在但档位被改过 → 导入时改回清单的档位', r.updated, 1);
    check('  改档写的是清单里的档位', db.of('SensitiveWord', 'updateOne')[0].update.$set.tier, 'block');

    // 词库快满 → 部分失败要如实报，而不是整体失败（已经是"导入了大部分"）
    const nearlyFull = [];
    for (let i = 0; i < 299; i++) nearlyFull.push({ _id: 'y' + i, word: 'y' + i, tier: 'block' });
    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: nearlyFull } });
    r = await mod(mkCtx({ db: db, args: { action: 'seedWords', callerId: AID, password: PW } }));
    check('词库将满 → ok 仍为 true（不是整体失败）', r.ok, true);
    check('  只进了凑满上限的那几条', r.added, 1);
    check('  其余进 failed 且带原因', r.failed.length, seed.length - 1);
    check('  failed 里的 code 是词库满', r.failed[0].code, 'WORD_BANK_FULL');

    // 门槛与 addWord 完全一致（seedWords 也不在 PASSWORD_OPTIONAL 里）
    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({ db: db, args: { action: 'seedWords', callerId: AID } }));
    check('seedWords 不带密码 → NEED_PASSWORD', r.code, 'NEED_PASSWORD');
    check('  且没写库', db.of('SensitiveWord', 'insertOne').length, 0);

    db = makeDb({ data: { BITZHAdministrator: [ADMIN_A], AdminAuthFail: [], BlackNum: [], Feeder: [], PostApply: [], SensitiveWord: [] } });
    r = await mod(mkCtx({
      db: db, args: { action: 'seedWords', callerId: TID, password: PW },
      getInfo: async function () { throw new Error('x'); },
    }));
    check('非管理员导入被拒', r.code, 'NOT_ADMIN');
    check('  且没写库', db.of('SensitiveWord', 'insertOne').length, 0);
  });

  // ============================================================
  console.log('\n[推荐词表清单自检]');
  // 这份清单是手写常量，而匹配是 indexOf 子串 —— 写错一个字等于"这条没加"，
  // 线上完全看不出来（词库列表里显示得好好的）。所以清单本身必须被测。
  // ============================================================
  (function () {
    const seed = mod.SEED_WORDS;
    const sw = require('../cloudfunctions/secCheck/sensitiveWords.js');
    const C = sw.CATEGORIES;

    // 这一组刻意**不**用 sw.match(词) 直接测 —— 清单里的词是**动态词库**的内容，
    // 裸静态表当然一条都命中不了（那样测出来的"没命中"是假警报）。
    // 唯一正确的问题是：把它丢进 withExtraWords 之后，线上会不会真的拦得住。
    function served(word, tier) {
      const cats = sw.withExtraWords(C, [tier ? { word: word, tier: tier } : word]);
      const r = sw.match(word, { scene: 3, categories: cats });
      return [r.severity, r.keywords.length];
    }

    check('清单条数（改词表时要一起改这个数，免得无声增删）', seed.length, 43);
    check('档位只有 block / review',
      seed.filter(function (x) { return x.tier !== 'block' && x.tier !== 'review'; }), []);

    // 去重键与 adminManage.wordKey 同一算法（去空白 + 控制字符）。
    // 这里重写一份而不是 require：wordKey 没导出，而它短到不值得为测试开个口子。
    function key(s) {
      let out = '';
      s = String(s == null ? '' : s);
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c <= 32 || c === 127) continue; out += s.charAt(i); }
      return out;
    }
    const keys = seed.map(function (x) { return key(x.word); });

    // 单字词会把所有人的发布打死；超长词由服务端 WORD_MAX_LEN 拒绝。
    // ⚠️ 这两个阈值是**抄来的常量**（服务端没导出），改服务端要一起改这里。
    const badLen = seed.filter(function (x) {
      const n = key(x.word).length;
      return n < sw.MIN_WORD_LEN || n > 20;
    }).map(function (x) { return x.word; });
    check('长度都在 min(2) ~ max(20) 之间', badLen, []);

    // 清单内部撞键 → 后一条会覆盖前一条的档位（同 _id），等于有一条白写了
    const dupes = keys.filter(function (k, i) { return keys.indexOf(k) !== i; });
    check('清单内部无重复（按 wordKey 去空白后比）', dupes, []);

    // 【最重要的一条】与静态词表重复的词会被 withExtraWords **静默丢弃** ——
    // 导入时显示成功（doAddWord 也不查静态表），实际不生效。
    // 下一条 served() 的断言会连"因重复被丢弃"一起抓住，这条只负责把原因说出来。
    const staticAll = [];
    C.forEach(function (c) { staticAll.push.apply(staticAll, (c.block || []).concat(c.review || [])); });
    check('清单与静态词表无重复（重复的会被静默丢弃）',
      keys.filter(function (k) { return staticAll.indexOf(k) >= 0; }), []);

    // 每条词都必须真的进得了动态词库并命中自己 —— 一条断言同时覆盖三种坏情况：
    // 被静态表重复丢掉、归一化后变成空/变了样、以及拼错字（拼错=换了个词，照样命中，
    // 所以这条挡不住错别字，只挡"加了等于没加"）。
    const dead = seed.filter(function (x) { return served(x.word, x.tier)[1] === 0; })
      .map(function (x) { return x.word; });
    check('每条词都真的进得了词库且能命中自己', dead, []);

    // 档位要如实传到线上：写错档位不会报错，只会让该拦的变"标记"
    const wrongTier = seed.filter(function (x) { return served(x.word, x.tier)[0] !== x.tier; })
      .map(function (x) { return x.word + ':' + served(x.word, x.tier)[0]; });
    check('每条词的生效档位与清单一致', wrongTier, []);

    // 整批一起灌（真实路径是 43 条同时进库，不是一条一条来）：
    // 词库超上限时 withExtraWords 会截断，被截掉的词静默失效。
    const all = sw.withExtraWords(C, seed);
    const missedTogether = seed.filter(function (x) { return served(x.word, x.tier)[1] === 0; });
    check('整批灌入后仍不超上限（超了会静默截断）', seed.length <= sw.MAX_EXTRA_WORDS, true);
    check('整批一起灌时 block/review 两档都没被截断',
      [all[0].block.length, all[all.length - 1].review.length],
      [seed.filter(function (x) { return x.tier === 'block'; }).length,
        seed.filter(function (x) { return x.tier === 'review'; }).length]);
    check('  且每条都还在（双重确认）', missedTogether.length, 0);
  })();

  // ============================================================
  // 北京时间当天键：一天只能申请一次 / "今天被拒" 的边界全靠它
  // 云函数容器是 UTC，所以 UTC 16:00 = 北京次日 0 点。
  // ============================================================
  console.log('[beijingDayKey 边界]');
  check('UTC 15:59 → 仍是当天', mod.beijingDayKey(new Date('2026-09-16T15:59:00Z')), '2026-09-16');
  check('UTC 16:00 → 北京已跨日', mod.beijingDayKey(new Date('2026-09-16T16:00:00Z')), '2026-09-17');
  check('UTC 23:59 → 北京次日', mod.beijingDayKey(new Date('2026-09-16T23:59:00Z')), '2026-09-17');
  check('UTC 00:00 → 北京当天上午', mod.beijingDayKey(new Date('2026-09-16T00:00:00Z')), '2026-09-16');

  // ============================================================
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常', e);
  process.exit(1);
});
