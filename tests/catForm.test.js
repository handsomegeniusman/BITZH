'use strict';
/**
 * tests/catForm.test.js —— 话题 → 猫 匹配（含「相关猫咪」列表的去重与排序）
 * ============================================================
 * 零框架，与 tests/adminManage.test.js 同一套写法（check + 退出码）。
 *
 * 【为什么单测这一块】这是全仓唯一一个"名字匹配"的地方，而且它同时喂给四处在页面上
 *   表现不同的东西：话题胶囊前的 🐱、点话题跳猫、长按话题进猫编辑页、以及推文详情
 *   下方的「相关猫咪」列表。四者必须给出一致的答案 —— 单测钉的是这个一致性。
 *   另外两件事**只在肉眼上很难发现写错**：
 *     ① 去重：一只猫被两个话题命中（真实名 + 别名）时不能出现两次；
 *     ② 排序：列表顺序要跟话题走，不能跟数据库返回顺序走（后者换个索引就会变）。
 *
 * 【为什么这个文件测的是 miniprogram/utils/ 而不是 cloudfunctions/】catForm.js 是
 *   纯函数、不碰 wx、也不依赖本机 config.js（require 链只有 guard.js，而 guard 对
 *   db.js 是函数内惰性 require），所以能直接在裸 node 下跑。这一点有断言钉住（见最后一组），
 *   免得日后有人往它顶上塞一句 require('../../config.js') 把整个文件变成"只在本机能跑"。
 * ============================================================
 */
const catForm = require('../miniprogram/utils/catForm.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      got : ' + g + '\n      want: ' + w); }
}

/** 造猫：只给匹配用得上的四个字段 */
function cat(id, name, otherName, usedName, nickname) {
  return { _id: id, name: name, otherName: otherName, usedName: usedName, nickname: nickname };
}

// 猫A：真实名「希特勒」，别名「小希/黑子」（斜杠分隔），曾用名「小胡子」
const A = cat('cA', '希特勒', '小希/黑子', '小胡子', '');
// 猫B：真实名就叫「小希」—— 于是话题「小希」会同时命中 A（别名）和 B（真实名）
const B = cat('cB', '小希', '', '', '');
// 猫C：真实名「肥仔」，别名「肥猪/饭桶」，昵称「猫哥 小奶猫」（空格分隔）
const C = cat('cC', '肥仔', '肥猪/饭桶', '', '猫哥 小奶猫');
// 猫D：名字里有边界词的陷阱 —— 话题「肥猪」不该命中它
const D = cat('cD', '肥猪头', '', '', '');
const ALL = [A, B, C, D];

const names = (r) => r.cats.map((c) => c.name);
const ids = (r) => r.cats.map((c) => c._id);

console.log('[基本命中]');
{
  const r = catForm.matchCatsByTopics(['希特勒'], ALL);
  check('真实名命中', ids(r), ['cA']);
  check('  catTopicMap 指向那只猫', r.catTopicMap, { 希特勒: 'cA' });
}
{
  const r = catForm.matchCatsByTopics(['小希'], ALL);
  check('别名也能命中（斜杠分隔的 otherName）', ids(r), ['cA', 'cB']);
  check('  点话题跳猫取数据库顺序里第一只（行为与改动前一致）', r.catTopicMap, { 小希: 'cA' });
}
{
  const r = catForm.matchCatsByTopics(['小胡子'], ALL);
  check('曾用名命中', ids(r), ['cA']);
}
{
  const r = catForm.matchCatsByTopics(['饭桶', '猫哥'], ALL);
  check('别名 / 昵称里的独立词都命中同一只猫', ids(r), ['cC']);
}
{
  const r = catForm.matchCatsByTopics(['不存在的猫'], ALL);
  check('没命中 → 两个产出都空', { ids: ids(r), map: r.catTopicMap }, { ids: [], map: {} });
}

console.log('\n[独立词边界：不许把「肥猪」当成「肥猪头」]');
// 这是 aliasContains 存在的全部理由 —— 话题比猫名短一截时不能算命中，
// 否则「肥猪」这个话题会把名字里带"肥猪"的所有猫都拉进来
check('话题「肥猪」不命中 name="肥猪头"', ids(catForm.matchCatsByTopics(['肥猪'], [D])), []);
check('话题「肥猪头」不命中 name="肥猪"', ids(catForm.matchCatsByTopics(['肥猪头'], [C])), []);
check('但话题「肥猪头」命中 name="肥猪头"（放宽不等于不匹配）', ids(catForm.matchCatsByTopics(['肥猪头'], [D])), ['cD']);
check('话题「肥猪」命中 otherName="肥猪/饭桶"（分隔符处是词边界）', ids(catForm.matchCatsByTopics(['肥猪'], ALL)), ['cC']);
check('全角井号分隔也算边界（脏数据 #＃）', ids(catForm.matchCatsByTopics(['黑子'], [cat('x', '希特勒', '#＃小希＃＃黑子', '', '')])), ['x']);
check('话题是空串 → 不参与匹配（否则 aliasContains 会命中一切）',
  ids(catForm.matchCatsByTopics(['', null, undefined, '希特勒'], ALL)), ['cA']);

console.log('\n[去重：一只猫被两个话题命中只出现一次]');
{
  // 真实名话题 + 别名话题同时出现 —— 这是"扁平去重"这个决定的核心场景
  const r = catForm.matchCatsByTopics(['希特勒', '小希'], ALL);
  check('猫A 只出现一次（不是两次）', ids(r), ['cA', 'cB']);
  check('  但两个话题的 catTopicMap 都指向它（胶囊照旧各画各的 🐱）', r.catTopicMap, { 希特勒: 'cA', 小希: 'cA' });
}
{
  // 三个话题全命中同一只猫
  const r = catForm.matchCatsByTopics(['希特勒', '小希', '黑子'], ALL);
  check('三个话题命中同一只 → 仍只列一次', ids(r), ['cA', 'cB']);
}
{
  // 同一话题重复出现（脏数据里 relative 串可能重复写）
  const r = catForm.matchCatsByTopics(['肥仔', '肥仔'], ALL);
  check('话题自身重复 → 列表里也只出现一次', ids(r), ['cC']);
}

console.log('\n[排序：跟话题走，不跟数据库返回顺序走]');
{
  // 数据库返回顺序固定为 ALL（A,B,C,D），只改话题顺序，看列表顺序是否跟着变
  const r1 = catForm.matchCatsByTopics(['希特勒', '肥仔'], ALL);
  check('话题 [希特勒, 肥仔] → 列表同序', names(r1), ['希特勒', '肥仔']);

  const r2 = catForm.matchCatsByTopics(['肥仔', '希特勒'], ALL);
  check('话题 [肥仔, 希特勒] → 列表反过来（证明跟着话题走）', names(r2), ['肥仔', '希特勒']);

  // 同一话题命中多只时，那几只之间保持数据库顺序（否则同一篇推文每次打开可能不一样）
  const r3 = catForm.matchCatsByTopics(['小希'], ALL);
  check('同一话题内的多只猫按数据库顺序（确定性）', ids(r3), ['cA', 'cB']);
  const r4 = catForm.matchCatsByTopics(['小希'], ALL.slice().reverse());
  check('  数据库倒序返回时组内顺序也倒（说明确实用了返回顺序，而非某种巧合）', ids(r4), ['cB', 'cA']);
}

console.log('\n[脏数据兜底]');
check('候选猫里缺 _id / 缺 name 的整条跳过', (function () {
  const r = catForm.matchCatsByTopics(['希特勒'], [null, { name: '希特勒' }, { _id: 'z' }, A]);
  return ids(r);
})(), ['cA']);
check('topics 为空 / 非数组 → 空结果', [
  catForm.matchCatsByTopics([], ALL).cats.length,
  catForm.matchCatsByTopics(null, ALL).cats.length,
  catForm.matchCatsByTopics(undefined, ALL).cats.length,
], [0, 0, 0]);
check('cats 为空 / 非数组 → 空结果（且不抛）', [
  catForm.matchCatsByTopics(['希特勒'], []).cats.length,
  catForm.matchCatsByTopics(['希特勒'], null).cats.length,
  catForm.matchCatsByTopics(['希特勒'], undefined).cats.length,
], [0, 0, 0]);
check('名字不是字符串（数字 / undefined）不抛', ids(catForm.matchCatsByTopics(['123'], [cat('n', 123, undefined, null, '')])), ['n']);

console.log('\n[不改变输入]');
{
  const topicList = ['希特勒'];
  const catList = ALL.slice();
  const before = JSON.stringify([topicList, catList]);
  catForm.matchCatsByTopics(topicList, catList);
  check('不改动传入的 topics / cats（纯函数）', JSON.stringify([topicList, catList]) === before, true);
}

console.log('\n[可测试性：不依赖本机 config.js]');
{
  // catForm 的 require 链上不能有 config.js —— 否则单测会变成"只在配好了的本机能跑"
  // （这个坑仓库里踩过：云函数 config.js 兜底会让测试依赖本机文件）。
  const mod = require('module');
  const seenPaths = [];
  const origResolve = mod._resolveFilename;
  mod._resolveFilename = function (request) {
    if (/config(\.js)?$/.test(request)) seenPaths.push(request);
    return origResolve.apply(this, arguments);
  };
  delete require.cache[require.resolve('../miniprogram/utils/catForm.js')];
  let threw = '';
  try { require('../miniprogram/utils/catForm.js'); } catch (e) { threw = e.message.split('\n')[0]; }
  mod._resolveFilename = origResolve;
  check('重新加载 catForm 不抛错', threw, '');
  check('  且整条 require 链里没有 config.js', seenPaths, []);
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
