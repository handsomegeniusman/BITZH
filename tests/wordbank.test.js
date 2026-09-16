'use strict';
/**
 * sensitiveWords.js 测试：静态词表的关键口径 + 动态词库（管理员运行时追加）的合并逻辑。
 *
 * 【为什么值得单独测】动态词库是唯一一条"不重新部署也能让线上行为改变"的路径 ——
 * 它同时影响所有人的发布，写错的代价（加个单字词 = 全站发不出帖）比一般 bug 大。
 * 纯模块、无 wx / 无 db 依赖，所以能直接 node 跑。
 */
const w = require('../cloudfunctions/secCheck/sensitiveWords.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w2 = JSON.stringify(want);
  if (g === w2) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n      got : ' + g + '\n      want: ' + w2); }
}
/** 取命中结果里我们关心的三要素 */
function hit(text, words) {
  const opts = words ? { scene: 3, categories: w.withExtraWords(w.CATEGORIES, words) } : { scene: 3 };
  const r = w.match(text, opts);
  return [r.severity, r.category, r.keywords];
}
function groupBy(key) {
  for (let i = 0; i < w.CATEGORIES.length; i++) if (w.CATEGORIES[i].key === key) return w.CATEGORIES[i];
  return null;
}

(async function () {
  console.log('[静态词表：钉住既有口径]');

  // 「网络虐猫」不需要单独加词 —— 子串匹配下「虐猫」已经覆盖它。
  // 这条测试的存在意义：防止将来有人以为"没拦网络虐猫"而把冗余词塞进表里。
  // 注意严重度是 review：2026-09-16 管理员选了选项 B，「虐猫」从 block 挪到了 review。
  check('网络虐猫 已被「虐猫」子串命中', hit('网络虐猫'), ['review', 'pet_risk', ['虐猫']]);

  // 【2026-09-16 管理员决定：选项 B】「虐猫」从 block 挪进 review。
  //    原因：它是双用途词 —— 既是虐猫圈的行为词，也是社团自己的反虐待宣传用语。
  //    原先在 block 时，社团发的「请大家拒绝虐猫，看到虐猫视频请举报」会被**直接拒绝发布**。
  //    现在：内容放行，但落一条 Review 推管理员复核（真虐猫贴和反宣传贴一起进复核队列 ——
  //    这是选 B 时明确接受的代价）。⚠️ 要改回 block 先跟管理员确认，别顺手改。
  check('反虐待宣传文案现在能发出去（落 review 待复核）',
    hit('请大家拒绝虐猫，看到虐猫视频请举报'), ['review', 'pet_risk', ['虐猫']]);
  check('虐猫 在 review 数组里而非 block 里',
    [groupBy('pet_risk').block.indexOf('虐猫') >= 0, groupBy('pet_risk').review.indexOf('虐猫') >= 0], [false, true]);
  // 挪档不能把本类别内部的硬拦一起降级：block 先于 review 检查，所以「摔猫」仍然赢
  check('同现时 block 词仍然压过 review 的「虐猫」',
    hit('摔猫 虐猫'), ['block', 'pet_risk', ['摔猫']]);

  // 「耄耋」刻意放 review（放行但落 Review 待人工复核），不是 block。
  // 文言词子串误伤面大；若要一律拦死，改 pet_risk.block 并同步改这条测试。
  check('耄耋 落在 review 档', hit('耄耋'), ['review', 'pet_risk', ['耄耋']]);
  check('耄耋 在 review 数组里而非 block 里',
    [groupBy('pet_risk').block.indexOf('耄耋') >= 0, groupBy('pet_risk').review.indexOf('耄耋') >= 0], [false, true]);

  check('正常内容不误伤', hit('这猫真可爱'), [null, null, []]);

  console.log('\n[静态词表：管理员提供的虐猫黑话（2026-09-16）]');

  // 明确的手段词 / 称呼词 → block
  ['贱猫', '键猫', '复合弓', '开水烫', '冰封王座', '水下逃生', '战争践踏'].forEach(function (w2) {
    check('block 档：' + w2, hit(w2)[0], 'block');
  });
  // 「键猫」是「贱猫」的谐音改写，两条都要能独立命中（挡绕过）
  check('谐音改写与本体都能命中',
    [hit('贱猫')[2], hit('键猫')[2]], [['贱猫'], ['键猫']]);

  // 有正当用法的词 → review，不当场拦死
  ['火龙果', '下毒', '投毒'].forEach(function (w2) {
    check('review 档：' + w2, hit(w2)[0], 'review');
  });

  // ⚠️ 回归：单个「毒」字**不许**进 block。
  //    否则「消毒」「中毒」「病毒」「猫误食中毒了怎么办」这类正当内容全被拦，
  //    而社团恰恰要处理"猫中毒求助"这种帖子。
  check('单个「毒」不进 block：消毒不被拦', hit('记得给猫碗消毒'), [null, null, []]);
  check('单个「毒」不进 block：中毒求助不被拦', hit('猫误食中毒了怎么办'), [null, null, []]);
  check('双字组合「下毒」仍被标记', hit('怀疑有人在小区下毒'), ['review', 'pet_risk', ['下毒']]);
  // 而「毒猫」本来就在 block 里，常见写法没漏
  check('毒猫 仍在 block 里', hit('毒猫')[0], 'block');

  console.log('\n[withExtraWords：合并与过滤]');

  const C = w.CATEGORIES;
  check('无词时原样返回同一个引用（不复制、不加空类别）', w.withExtraWords(C, []) === C, true);
  check('非数组入参不炸', w.withExtraWords(C, null) === C, true);

  const merged = w.withExtraWords(C, ['猫贩子']);
  check('合并后比原表多一个类别', merged.length, C.length + 1);
  check('新类别排在最前（优先级最高）', merged[0].key, 'wordbank');
  check('原表未被改动（纯函数）', C[0].key !== 'wordbank', true);

  // 动态词生效
  check('动态词命中 → block', hit('这里有猫贩子', ['猫贩子']), ['block', 'wordbank', ['猫贩子']]);
  check('动态词未命中 → 不影响其他判定', hit('这猫真可爱', ['猫贩子']), [null, null, []]);

  // 优先于静态表：管理员是"见到这条内容踩了词"才加进来的，应当压过后面的 review 命中
  check('动态词优先于静态 review 命中',
    hit('转让猫咪', ['转让猫咪']), ['block', 'wordbank', ['转让猫咪']]);

  console.log('\n[withExtraWords：归一化防绕过]');

  // 繁体写法：入库存的是繁体，也要能命中简体正文（normalize 里做繁体→简体）
  check('繁体词命中简体正文', hit('这里有猫贩子', ['貓販子']), ['block', 'wordbank', ['猫贩子']]);
  // 分隔符变体：正文里插了间隔号/空格也要拦得住
  check('正文插分隔符仍命中', hit('猫贩·子', ['猫贩子']), ['block', 'wordbank', ['猫贩子']]);
  check('正文插空格仍命中', hit('猫 贩 子', ['猫贩子']), ['block', 'wordbank', ['猫贩子']]);

  console.log('\n[withExtraWords：丢弃不安全的词]');

  check('单字词被丢弃（否则等于全站打死）', w.withExtraWords(C, ['猫']) === C, true);
  check('空串被丢弃', w.withExtraWords(C, ['']) === C, true);
  check('纯空白被丢弃', w.withExtraWords(C, ['   ']) === C, true);
  check('纯标点被丢弃（归一化后为空）', w.withExtraWords(C, ['。。。']) === C, true);
  check('全是不可用词时原样返回', w.withExtraWords(C, ['猫', '', ' ']) === C, true);

  // 与静态词重复的：留着也是白占位置（静态表已经拦了）
  check('与静态 block 词重复 → 丢弃', w.withExtraWords(C, ['摔猫']) === C, true);
  check('与静态 review 词重复 → 丢弃', w.withExtraWords(C, ['弃养']) === C, true);
  check('归一化后才与静态重复 → 也丢弃', w.withExtraWords(C, ['摔貓']) === C, true);

  // 动态词之间自己重复
  check('动态词内部去重', w.withExtraWords(C, ['猫贩子', '猫贩子', '猫贩子'])[0].block, ['猫贩子']);
  // 三个输入分别踩三种情况：单字（丢）、可用（留）、与静态词重复（丢）。
  // 「虐猫」现在是**静态 review 档**，所以这条顺带钉住"静态 review 词不会漏进动态 block 档"。
  check('混杂可用与不可用时只留可用的', w.withExtraWords(C, ['猫', '猫贩子', '虐猫'])[0].block, ['猫贩子']);

  console.log('\n[withExtraWords：两档位与优先级]');

  // block 档在前、review 档在后 —— 位置就是优先级，见 withExtraWords 注释
  const two = w.withExtraWords(C, [
    { word: '猫贩子', tier: 'block' },
    { word: '火钳子', tier: 'review' },
  ]);
  check('block 档排在最前', two[0].key, 'wordbank');
  check('review 档排在最后', two[two.length - 1].key, 'wordbank_review');
  check('两档各自命中', [hit('猫贩子', [{ word: '猫贩子', tier: 'block' }])[0],
    hit('火钳子', [{ word: '火钳子', tier: 'review' }])[0]], ['block', 'review']);
  check('review 档的 category 可与 block 档区分',
    hit('火钳子', [{ word: '火钳子', tier: 'review' }])[1], 'wordbank_review');

  // 【最重要的一条】动态 review 档**不得**覆盖别处的 block：
  // 若把 review 档也放在最前，一条同时含「火钳子」和「摔猫」的内容会被报成 review，
  // 严重度不升反降 —— 那是把硬拦悄悄降级成"标记"。
  // ⚠️ 这里举例必须用**仍在静态 block 档**的词（摔猫）。原先用的是「虐猫」，
  //    它 2026-09-16 挪进了静态 review 档 —— 拿它举例，两边都是 review，
  //    这条测试就会永远通过而失去意义。
  check('动态 review 不覆盖静态 block（严重度不得降级）',
    hit('火钳子 摔猫', [{ word: '火钳子', tier: 'review' }]),
    ['block', 'pet_risk', ['摔猫']]);
  // 反过来：动态 block 覆盖静态 review（管理员显式判定优先）
  check('动态 block 覆盖静态 review',
    hit('转让猫咪', [{ word: '转让猫咪', tier: 'block' }]),
    ['block', 'wordbank', ['转让猫咪']]);

  // 档位字段的兜底
  check('tier 非法值按 block 处理',
    hit('猫贩子', [{ word: '猫贩子', tier: 'wat' }])[1], 'wordbank');
  check('tier 缺失按 block 处理',
    hit('猫贩子', [{ word: '猫贩子' }])[1], 'wordbank');
  check('字符串元素等价于 block 档', hit('猫贩子', ['猫贩子'])[1], 'wordbank');

  // 同一个词同时给两档：block 无条件赢，且与输入顺序无关
  check('两档都给了同一个词 → block 赢（block 在前）',
    hit('猫贩子', [{ word: '猫贩子', tier: 'review' }, { word: '猫贩子', tier: 'block' }])[1], 'wordbank');
  check('两档都给了同一个词 → block 赢（review 在前，顺序无关）',
    hit('猫贩子', [{ word: '猫贩子', tier: 'block' }, { word: '猫贩子', tier: 'review' }])[1], 'wordbank');

  // 某一档为空时不该产生空类别（空类别会白占一次遍历，还会打乱上面那些位置断言）
  function hasKey(arr, key) {
    for (let i = 0; i < arr.length; i++) if (arr[i].key === key) return true;
    return false;
  }
  const onlyReview = w.withExtraWords(C, [{ word: '火钳子', tier: 'review' }]);
  check('只有 review 词时不产生空的 block 类别', hasKey(onlyReview, 'wordbank'), false);
  check('只有 review 词时 review 类别仍在', hasKey(onlyReview, 'wordbank_review'), true);
  const onlyBlock = w.withExtraWords(C, ['猫贩子']);
  check('只有 block 词时不产生空的 review 类别', hasKey(onlyBlock, 'wordbank_review'), false);

  console.log('\n[withExtraWords：容量上限]');

  // 造 400 个彼此不同的 4 字符词（纯字母，避开数字→中文数字的归一化干扰）
  const many = [];
  for (let i = 0; i < 400; i++) {
    many.push('x' + String.fromCharCode(97 + Math.floor(i / 26) % 26) + String.fromCharCode(97 + i % 26) + 'y');
  }
  check('超出上限时截断到 MAX_EXTRA_WORDS',
    w.withExtraWords(C, many)[0].block.length, w.MAX_EXTRA_WORDS);
  check('上限值是 300', w.MAX_EXTRA_WORDS, 300);

  console.log('\n[类别表自检]');

  // 同一个词同时出现在 block 和 review 里 = 归类矛盾（block 会赢，review 那条是死代码）
  let dupCross = [];
  let dupSame = [];
  for (let i = 0; i < C.length; i++) {
    const b = C[i].block || [], r = C[i].review || [];
    for (let j = 0; j < b.length; j++) if (r.indexOf(b[j]) >= 0) dupCross.push(C[i].key + ':' + b[j]);
    [['block', b], ['review', r]].forEach(function (pair) {
      for (let j = 0; j < pair[1].length; j++) {
        if (pair[1].indexOf(pair[1][j]) !== j) dupSame.push(C[i].key + ':' + pair[0] + ':' + pair[1][j]);
      }
    });
  }
  check('无同类内重复词', dupSame, []);
  check('无跨 block/review 重复词', dupCross, []);

  // 昵称专属类别必须带 scene:1，否则「官方」「客服」会拦掉正文里的正常用词
  let badScene = [];
  for (let i = 0; i < C.length; i++) {
    if (C[i].key === 'impersonation' && C[i].scene !== 1) badScene.push(C[i].key);
  }
  check('impersonation 仍带 scene:1', badScene, []);
  check('正文场景下不拦「客服」', w.match('请联系客服', { scene: 3 }).severity, null);
  check('昵称场景下拦「客服」', w.match('客服小助手', { scene: 1 }).severity, 'block');

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
