'use strict';
/**
 * secCheck 动态词库缓存测试（cloudfunctions/secCheck/index.js 的 loadExtraWords）。
 *
 * 【为什么单独测这一层】它是唯一一个"错法很安静"的地方：
 *   - 缓存永不过期 → 管理员加了词却永远不生效，而且没有任何报错；
 *   - 读失败时把空结果永久缓存 → 动态词库在第一次抖动后就彻底哑掉；
 *   - 忘了把 DB 的 tier 映射出来 → 所有词都变成硬拦（或全变成放行）。
 * 这三种都不会让任何界面报错，只会让人觉得"这功能没用"。所以逐条钉住。
 *
 * 【为什么能 node 跑】secCheck/index.js 只依赖 Node 内置模块 + sensitiveWords.js，
 *   所以可以直接 require；内部函数通过 module.exports.__test 暴露（见该文件末尾）。
 */
const sec = require('../cloudfunctions/secCheck/index.js');
const w = require('../cloudfunctions/secCheck/sensitiveWords.js');
const T = sec.__test;

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w2 = JSON.stringify(want);
  if (g === w2) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      got : ' + g + '\n      want: ' + w2); }
}

// ---- 假时钟：TTL 判断用的是 Date.now()，这里接管它，免得测试真去 sleep 60 秒 ----
let now = 1700000000000;
const realNow = Date.now;
Date.now = function () { return now; };
/** 推进到肯定超过 TTL 的位置，再读一次（保证这次一定走查库） */
async function reread(db) {
  now += T.BANK_TTL_MS * 2;
  return T.loadExtraWords(db);
}

/** 假 db：记录查了几次、查的哪个集合、带了什么 option；fail 打开时一律 reject */
function makeDb(rows) {
  const db = { rows: rows, finds: 0, colls: [], lastOpt: null, fail: false };
  db.collection = function (name) {
    db.colls.push(name);
    return {
      find: function (q, opt) {
        db.finds++;
        db.lastOpt = opt;
        if (db.fail) return Promise.reject(new Error('mock db down'));
        return Promise.resolve(db.rows);
      },
    };
  };
  return db;
}

(async function () {
  console.log('[动态词库：读取与字段映射]');

  const db = makeDb([{ _id: '猫贩子', word: '猫贩子', tier: 'block' }]);
  check('首次读取返回 [{word,tier}]', await T.loadExtraWords(db), [{ word: '猫贩子', tier: 'block' }]);
  check('查的是 SensitiveWord 集合', db.colls[0], 'SensitiveWord');
  check('带 limit（不许全表拉取）', db.lastOpt && db.lastOpt.limit, 300);
  // 【为什么必须只取这些字段】secCheck 在发布热路径上，文档里还有 by/time/raw 等审计字段，
  // 全量带回只是白传。这里钉的是"别顺手改成带审计字段"的反向依赖。
  check('只回 word/tier 两个字段，不带审计字段', Object.keys((await T.loadExtraWords(db))[0]), ['word', 'tier']);

  console.log('\n[动态词库：60 秒缓存]');

  db.finds = 0;
  check('TTL 内直接命中缓存（值不变）', (await T.loadExtraWords(db)).length, 1);
  check('TTL 内不重复查库', db.finds, 0);

  now += T.BANK_TTL_MS - 1;
  await T.loadExtraWords(db);
  check('差 1 毫秒到期时仍走缓存', db.finds, 0);

  now += 2;
  await T.loadExtraWords(db);
  check('越过 TTL 后重新查库', db.finds, 1);
  check('TTL 常量是 60000 毫秒', T.BANK_TTL_MS, 60000);

  // 库里的改动要能在 TTL 之后生效 —— 这是"加了词不用重新部署"的实质
  db.rows.length = 0;
  db.rows.push({ word: '火钳子', tier: 'review' });
  check('库里改过之后，TTL 到期即读到新值', await reread(db), [{ word: '火钳子', tier: 'review' }]);

  console.log('\n[动态词库：tier 字段的兜底]');

  const mixed = makeDb([
    { word: '甲甲', tier: 'review' },
    { word: '乙乙', tier: 'wat' },
    { _id: '丙丙' },            // 只有 _id（写入端用 _id 存归一化后的词）
    { word: '   ' },            // 纯空白：映射阶段保留，合并阶段会被丢掉
    {},                          // 空文档
  ]);
  check('tier 只认 review，其余一律 block',
    await reread(mixed),
    [{ word: '甲甲', tier: 'review' }, { word: '乙乙', tier: 'block' },
      { word: '丙丙', tier: 'block' }, { word: '   ', tier: 'block' }, { word: '', tier: 'block' }]);

  // 空结果也必须进缓存，否则每次发布都去查一次空库
  T.dropExtraWordsCache();
  const empty = makeDb([]);
  check('空词库返回 []', await T.loadExtraWords(empty), []);
  empty.finds = 0;
  await T.loadExtraWords(empty);
  check('空词库也走缓存（不重复查库）', empty.finds, 0);

  console.log('\n[动态词库：读失败一律 fail-open]');

  T.dropExtraWordsCache();
  const dead = makeDb([]);
  dead.fail = true;
  const errs = [];
  const realErr = console.error;
  console.error = function () { errs.push(Array.prototype.join.call(arguments, ' ')); };
  check('查库失败时不抛异常，返回空数组', await T.loadExtraWords(dead), []);
  console.error = realErr;
  check('失败有 console.error 留痕（否则线上静默）', errs.length > 0, true);
  check('日志带 [secCheck] 前缀（便于按函数过滤）', String(errs[0] || '').indexOf('[secCheck]') === 0, true);

  check('失败后短时间内不重复撞库（故障期不打查询风暴）', await T.loadExtraWords(dead), []);
  check('失败时也刷新时间戳 → 查库次数仍为 1', dead.finds, 1);

  // 已经有过好数据时读失败 → 沿用旧的，而不是把词库清空（陈旧好过没有）
  T.dropExtraWordsCache();
  const flaky = makeDb([{ word: '猫贩子', tier: 'block' }]);
  await T.loadExtraWords(flaky);
  flaky.fail = true;
  console.error = function () { };
  check('读失败时沿用上一次的词（不清空）',
    await reread(flaky), [{ word: '猫贩子', tier: 'block' }]);
  console.error = realErr;

  console.log('\n[动态词库：没有 db 的路径]');

  T.dropExtraWordsCache();
  check('db 为 null 时返回空数组而不是崩', await T.loadExtraWords(null), []);
  check('db 没有 collection 方法时同样安全', await T.loadExtraWords({}), []);
  // 关键：上面两次都不该写缓存，否则"先调了一次没 db 的"会把词库永久锁死在空
  const later = makeDb([{ word: '猫贩子', tier: 'block' }]);
  check('之前没 db 不影响之后有 db 时读取', (await T.loadExtraWords(later)).length, 1);
  check('确实真去查了库', later.finds, 1);

  // ============================================================
  console.log('\n[动态词库：bankState —— 让 extraWords:0 能自证原因]');
  // 【这一组为什么存在】运维口子 action:'reloadWords' 只回一个 extraWords 数字，
  //   而"集合没建 / 拿不到 db / 查库报错"三种情况都会得到 0，**控制台又看不到
  //   console.log**，于是在线上就是完全没线索。bankState 把结局编码回给调用方。
  //   这几条钉住的是"三种 0 必须被区分开"这件事本身。
  // ============================================================

  T.dropExtraWordsCache();
  check('还没读过 → never', T.bankState(), 'never');

  const okDb = makeDb([{ word: '猫贩子', tier: 'block' }]);
  await T.loadExtraWords(okDb);
  check('读通了 → ok', T.bankState(), 'ok');

  T.dropExtraWordsCache();
  const emptyDb = makeDb([]);
  await T.loadExtraWords(emptyDb);
  check('读通但库是空的 → 仍是 ok（不是错误）', T.bankState(), 'ok');
  check('  空库的 hint 要指向"还没导入过"而不是报错',
    T.bankHint(0, 'ok').indexOf('导入') > 0, true);

  T.dropExtraWordsCache();
  await T.loadExtraWords(null);
  check('拿不到 db → no_db', T.bankState(), 'no_db');

  T.dropExtraWordsCache();
  const brokenDb = makeDb([]);
  brokenDb.fail = true;
  console.error = function () { };
  await T.loadExtraWords(brokenDb);
  console.error = realErr;
  check('查库报错 → read_failed', T.bankState(), 'read_failed');

  // 三种 0 缺一不可区分：把它们各自的 hint 收集起来看是否互不相同
  const hints = ['no_db', 'read_failed', 'ok'].map(function (s) { return T.bankHint(0, s); });
  check('三种原因的 hint 互不相同（否则等于没解释）',
    hints.length === new Set(hints).size, true);
  check('三种原因一个都不能是空串',
    hints.filter(function (h) { return !h || typeof h !== 'string'; }), []);

  // 有词时的 hint 要报出条数，方便和"我导入了 43 条"对照
  check('读到词时 hint 里带条数', T.bankHint(43, 'ok').indexOf('43') > 0, true);

  // 探针不能回显词条本身（它是无鉴权 action，回显就等于公开词库）
  const anyHint = ['no_db', 'read_failed', 'ok'].map(function (s) { return T.bankHint(3, s); }).join('|');
  check('hint 里不含具体词条（无鉴权 action 不得回显词库）',
    anyHint.indexOf('猫贩子') >= 0, false);

  console.log('\n[缓存 → match 端到端]');

  // 这一段把"库里存的词"和"最终拦不拦得住"连起来。前面测的是搬运，这里测的是效果。
  const liveRows = [{ word: '猫贩子', tier: 'block' }, { word: '火钳子', tier: 'review' }];
  const words = await reread(makeDb(liveRows));
  const cats = w.withExtraWords(w.CATEGORIES, words);

  const hb = w.match('这里有猫贩子', { scene: 3, categories: cats });
  check('动态 block 词命中 → 拒绝发布', [hb.severity, hb.category, hb.keywords], ['block', 'wordbank', ['猫贩子']]);
  const hr = w.match('看到一把火钳子', { scene: 3, categories: cats });
  check('动态 review 词命中 → 放行但标记复核', [hr.severity, hr.category], ['review', 'wordbank_review']);
  check('不含动态词的内容不受影响',
    [w.match('这猫真可爱', { scene: 3, categories: cats }).severity], [null]);

  // 库里存繁体、正文写简体：归一化必须在**读出来之后**仍然生效
  const tw = await reread(makeDb([{ word: '貓販子', tier: 'block' }]));
  const ht = w.match('这里有猫贩子', { scene: 3, categories: w.withExtraWords(w.CATEGORIES, tw) });
  check('库里存繁体、正文简体 → 命中', [ht.severity, ht.keywords], ['block', ['猫贩子']]);

  // 正文插分隔符绕过的写法（normalize 去分隔符）
  const hs = w.match('猫 贩 子', { scene: 3, categories: cats });
  check('正文插空格仍命中', hs.severity, 'block');

  // 危险词（单字）即使进了库也不该生效 —— 双重保险：写入端拦一次，读取端合并时再拦一次
  const dangerous = await reread(makeDb([{ word: '猫', tier: 'block' }]));
  check('库里的单字词被合并阶段丢弃（不产生 wordbank 类别）',
    w.withExtraWords(w.CATEGORIES, dangerous), w.CATEGORIES);
  check('单字词实际不生效', w.withExtraWords(w.CATEGORIES, dangerous)[0].key !== 'wordbank', true);

  Date.now = realNow;
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
