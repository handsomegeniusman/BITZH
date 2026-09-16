/**
 * sensitiveWords.js —— 本地敏感词库（补 msgSecCheck 对新型赌博暗语等的识别延迟）
 * ============================================================
 * 【作用】msgSecCheck 对「新出现的赌博暗语、拆字、符号分隔变体」有识别延迟，
 *         本词库在调微信接口之前先做一轮本地预检，命中即拦截/标记。
 *
 * 【结构】每个类别两个词表：
 *   block  命中 → severity='block'（前端判 risky：拒绝发布）
 *   review 命中 → severity='review'（前端判 review：放行但推管理员人工复核）
 * 词条统一用「归一化后」的形式（半角、无空格无分隔符、简体、小写），
 * 因为 match() 会先把待检测文本做同样归一化再 indexOf 匹配。
 *
 * 【归一化防绕过】normalize() 依次做：
 *   1. 全角→半角
 *   2. 去空白/分隔符/标点/emoji（拦「下 注」「下·注」这类分隔变体）
 *   3. 繁体→简体（拦「賭博」「約炮」）
 *   4. 数字→中文数字（拦「6合彩」「1元购」）
 *   （拼音音节未做全局替换：'du'→'赌' 会误伤 education/during 等英文；
 *     如需拦「下zhu」类拼音变体，请直接往词表加混合变体词，如 "下zhu"）
 *
 * 【性能】当前 <150 词、单条 ≤2000 字，indexOf 遍历单次 <1ms。
 *         match() 会返回 matchCostMs，若词库膨胀到持续 >100ms 再换 AC 自动机。
 *
 * 【维护】人工复核中发现的新暗语，直接往对应 block/review 数组里加即可，不用改主逻辑。
 *        ⚠️ 改完本文件**不等于**线上生效：打 secCheck 部署包读的是
 *        `builds/secCheck/sensitiveWords.js`（见仓外打包脚本），必须同步过去再重建包。
 *
 * 【动态词库】管理员在小程序里追加的词存在 `SensitiveWord` 集合，由 secCheck 读出后经
 *        withExtraWords() 并进类别表 —— 这条路**不需要重新部署**，加词立刻生效。
 *        静态表仍然保留，因为它是随包发布的、不依赖数据库可用性（动态词读失败时
 *        会 fail-open 回落到静态表，见 secCheck/index.js）。
 */

// 繁体→简体映射表（仅覆盖词表中出现的繁体字，约 55 字，不引第三方依赖）
const TRADITIONAL_MAP = {
  '賭': '赌', '場': '场', '錢': '钱', '網': '网', '時': '时', '樂': '乐', '門': '门', '莊': '庄', '閒': '闲',
  '買': '买', '單': '单', '雙': '双', '盤': '盘', '賠': '赔', '圍': '围', '電': '电', '競': '竞', '獎': '奖', '購': '购', '碼': '码',
  '約': '约', '貸': '贷', '賣': '卖', '務': '务', '樓': '楼', '鳳': '凤', '黃': '黄', '優': '优', '頻': '频', '調': '调', '愛': '爱',
  '殺': '杀', '屍': '尸', '槍': '枪', '軍': '军', '彈': '弹', '輪': '轮', '會': '会', '獨': '独', '黨': '党', '顛': '颠', '國': '国',
  '藥': '药', '幣': '币', '販': '贩', '龐': '庞', '騙': '骗', '詐': '诈', '職': '职', '賺': '赚', '現': '现', '傳': '传', '銷': '销',
  '辦': '办', '發': '发', '證': '证', '價': '价', '貓': '猫', '償': '偿', '領': '领', '養': '养', '種': '种',
};

// 数字→中文数字（拦「6合彩」「1元购」等数字变体）
const DIGIT_MAP = { '0': '零', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六', '7': '七', '8': '八', '9': '九' };

const CATEGORIES = [
  {
    key: 'gambling',
    label: '赌博/诱导抽奖',
    block: ['赌博', '赌场', '赌钱', '下注', '押注', '赌注', '博彩', '网赌', '时时彩', '六合彩',
      '百家乐', '澳门赌', '葡京', '庄闲', '买大买小', '大小单双', '倍投', '回血', '洗白',
      '盘口', '赔率', '外围', '电竞盘', '梭哈', '抽奖返利', '一元购', '出码', '投注',
      // 拼音/拆字变体（不做全局替换，改为针对性补词）
      '下zhu', '下住', '下驻', '倍tou'],
    review: ['上分', '下分', '流水', '押一付一'],
  },
  {
    key: 'porn',
    label: '色情/低俗',
    block: ['约炮', '裸聊', '裸贷', '援交', '招嫖', '卖淫', '嫖娼', '性服务', '包夜', '楼凤',
      '外围女', '色情', '黄片', 'av女优', '成人视频', '裸照', '调教', '做爱', '口交'],
    review: ['陪聊'],
  },
  {
    key: 'violence',
    label: '暴力/血腥',
    block: ['杀人', '砍人', '分尸', '虐杀', '血腥', '枪支', '军火', '炸弹', '爆炸', '管制刀具'],
    review: [],
  },
  {
    key: 'religion',
    label: '民族宗教/迷信',
    block: ['法轮功', '邪教', '全能神', '门徒会'],
    review: ['算命', '风水', '转运', '开光', '符咒'],
  },
  {
    key: 'political',
    label: '涉政/国安/谣言',
    block: ['台独', '港独', '藏独', '疆独', '反党', '反共', '颠覆国家'],
    review: [],
  },
  {
    key: 'drugs',
    label: '违法犯罪/违禁品',
    block: ['毒品', '冰毒', '海洛因', '大麻', '迷药', '催情药', '假币', '枪支弹药', '买卖人口', '贩卖枪支'],
    review: [],
  },
  {
    key: 'fraud',
    label: '虚假/欺诈',
    block: ['庞氏骗局', '电信诈骗', '兼职刷单', '刷单', '日赚', '招代理', '微商', '引流', '私聊我',
      '套现', '洗钱', '传销', '代办信用卡', '贷款秒批', '代开发票', '办证刻章'],
    review: [],
  },
  {
    key: 'ad',
    label: '广告引流',
    block: ['办证', '贷款', '信用卡代办', '卖片', '低价代购', '刷单兼职'],
    review: [],
  },
  {
    // 宠物领域专属风险：交易/虐待/不当救助。
    // 注意：已剔除「送养/领养/找新家/加微信」等社团本职合法行为，避免误伤自己人。
    key: 'pet_risk',
    label: '宠物交易/虐待/不当救助',
    // 【为什么没有单独的「网络虐猫」】匹配是 indexOf 子串（见 hitWords），
    //   已有的「虐猫」已经把「网络虐猫」「虐猫视频」等一切含它的写法一并命中，
    //   再加一条是冗余 —— 将来若觉得"没拦网络虐猫"，先看这条注释。
    //
    // 【「虐猫」为什么在 review 而不在 block】（2026-09-16 管理员决定，选项 B）
    //   它原来在 block。但「虐猫」是**双用途词**：既是虐猫圈的行为词，也是社团自己的
    //   反虐待宣传用语 ——「请大家拒绝虐猫，看到虐猫视频请举报」整句会被子串命中。
    //   社团发反虐待内容是高行为，每次被拦都会有人来问"为什么发不出去"，所以改成
    //   放行 + 落一条 Review 推管理员复核（真虐猫贴和反宣传贴一起进复核队列，这是接受的代价）。
    //   ⚠️ 别再"顺手"把它挪回 block；要挪先把社团自己的文案口径想清楚。
    //
    // 【两个档位的取舍】block = 当场拒绝发布；review = 照常发布 + 落一条 Review 推管理员人工看。
    //   判断依据只有一条：**这个词有没有正当用法**。有正当用法的一律进 review ——
    //   宁可让管理员多看一眼，也不要拦掉社团自己的内容。
    block: [
      '卖猫', '有偿领养', '品种猫', '繁殖', '配种', '打猫', '摔猫', '毒猫', '扔猫', '活埋', '猫肉', '猫皮', '猫骨',
      // 2026-09-16 管理员提供：虐猫圈的称呼与手段黑话
      // 「贱猫/键猫」是同一个词的两种写法（键是刻意的谐音改写，用来绕过关键词），两条都要留
      '贱猫', '键猫',
      '复合弓',   // 圈内用作"从远处射猫"的手段名
      '开水烫',
      // 下面三条是魔兽争霸的技能名，被圈内借来当虐待手段的代称。
      // ⚠️ 已知代价：普通的游戏怀旧贴（「冰封王座」是资料片名）会一起被拦。
      //   若社团里有人发游戏内容、被误伤过，把这三条挪到 review 即可（一行改动）。
      '冰封王座', '水下逃生', '战争践踏',
    ],
    review: [
      '偏方治疗', '土法治病', '不就医', '弃养', '转让',
      // 「虐猫」从 block 挪到这里（2026-09-16，选项 B）—— 理由见上面 block 之前的注释。
      // 【挪到这里为什么不会"降级"别处的 hard block】match() 是"按类别顺序、第一个命中就返回"，
      //   而类别内部**先查 block 再查 review** —— 所以「摔猫 + 虐猫」同现时仍然判 block（摔猫赢），
      //   本类别内部不会因为这条降级。跨类别方向：pet_risk 之后的类别只有 impersonation，
      //   它 scene:1 才生效、推文/评论场景被跳过，所以也不存在"review 抢在 block 前面"。
      //   （动态词库那侧的位置约束是另一回事，见 withExtraWords 注释。）
      '虐猫',
      // 「耄耋」：文言词（耄耋之年），子串误伤面比上面那批明确的手段词大得多
      '耄耋',
      // 「火龙果」是圈内对"用火烧"的代称，**但它同时是极常见的宠物名**。
      //   放 review 而不是 block：宁可让管理员看一眼，也不要拦掉一条「我家火龙果今天很乖」。
      //   若确认社团里没人拿它当宠物名，挪到 block。
      '火龙果',
      // 【为什么不是单个「毒」字】单字在 indexOf 下会把「消毒」「中毒」「病毒」「有毒」
      //   连同「猫误食中毒了怎么办」这类**正当求助**一起拦掉；而且「毒猫」本来就在 block 里，
      //   常见的那个写法已经覆盖了。这里只收没有正当用法的双字组合。
      '下毒', '投毒',
    ],
  },
  {
    // 仿冒官方/误导性昵称：仅 scene=1（资料/昵称）生效。
    // 与前端 utils/guard.js 的 FORBIDDEN_NAME_WORDS 同步维护。
    // 不放进通用词库的原因：官方/管理员/客服/运营等词在推文/评论正文里是正常用词，
    // 只对"昵称"做拦截（scene=1），避免误伤正文。
    key: 'impersonation',
    label: '仿冒官方/误导性昵称',
    scene: 1,
    block: ['官方', '北理珠关爱部', '关爱部', '北理珠', '北理流浪猫', '管理员', '客服', '运营'],
    review: [],
  },
];

/** 繁体→简体（逐字符查表，未命中保留原字符） */
function toSimplified(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    out += TRADITIONAL_MAP[ch] || ch;
  }
  return out;
}

/**
 * 归一化文本：全角→半角、去所有空白、去常见分隔/标点/emoji、繁体→简体、数字→中文、转小写。
 * 让「下 注」「下·注」「賭博」「6合彩」这类变体都能命中词表。
 */
function normalize(text) {
  let s = String(text == null ? '' : text);
  // 1) 全角 ASCII → 半角（！→!、Ａ→A 等，U+FF01~U+FF5E 减 0xFEE0）
  s = s.replace(/[！-～]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  // 2) 去空白
  s = s.replace(/\s+/g, '');
  // 3) 去常见分隔符与中英文标点
  s = s.replace(/[·.\-_*~|,，。、:：;；!！?？()（）\[\]【】{}<>《》"'“”‘’…—\\/@#$%^&+=`]/g, '');
  // 4) 去 emoji（代理对 + 杂项符号区 + 变体选择符）
  s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[️☀-➿]/g, '');
  // 5) 繁体→简体
  s = toSimplified(s);
  // 6) 数字→中文数字
  s = s.replace(/[0-9]/g, function (ch) { return DIGIT_MAP[ch]; });
  return s.toLowerCase();
}

/** 在归一化文本里找出命中的词 */
function hitWords(norm, words) {
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w && norm.indexOf(w) >= 0) hits.push(w);
  }
  return hits;
}

// ============ 动态词库（管理员运行时追加） ============

/** 动态词库对应的合成类别 key / label。前端只认 severity，不认 key，故可自由取名。 */
const EXTRA_KEY = 'wordbank';
const EXTRA_LABEL = '管理员追加词库';
/** 动态词里的 review 档单独成一个类别，且**排在最后** —— 理由见 withExtraWords。 */
const EXTRA_REVIEW_KEY = 'wordbank_review';
const EXTRA_REVIEW_LABEL = '管理员追加词库（待复核）';
/** 动态词上限：兜住"词库无限膨胀拖慢每次发布预检"，也兜住误操作批量写入 */
const MAX_EXTRA_WORDS = 300;
/** 动态词最短长度。单字词（如「猫」「的」）在 indexOf 下等于把所有人的发布打死，一律不收 */
const MIN_WORD_LEN = 2;

/**
 * 把「管理员追加的词」并进类别表，返回**新的**数组（不改动入参）。
 *
 * 【为什么不直接用 CATEGORIES】词表是随包发布的静态文件，改一次要重新部署；
 *   而「封禁时问到的关键词」是运行期产生的，必须能立刻生效。所以动态词单独存库，
 *   每次匹配前并进来。
 *
 * 【block 档放最前、review 档放最后 —— 这个位置是承重的】
 *   match() 是"按类别顺序、第一个命中就返回"，所以类别的位置就是优先级：
 *   · block 档排第 0 位：管理员是**因为见到这条内容踩了这个词**才把它加进来的，
 *     它的命中应当压过后面类别的 review 命中。
 *   · review 档排在**最后**：它是"放行但标记"，那就不能让它的标记去覆盖别处
 *     已经判定的 block。若把它也放前面，一条同时含「火钳子」和「摔猫」的内容
 *     会被报成 review 而不是 block —— 严重度不升反降。
 *     （这条举例原来用的是「虐猫」，但它 2026-09-16 已挪进静态 review 档，
 *      拿它举例就测不出这个约束了，故换成仍在 block 档的「摔猫」。）
 *
 * 【为什么在这里剔重】adminManage 是独立部署包，require 不到本文件（跨云函数 require
 *   在本项目不可用），它看不到静态词表。所以"和静态词重复就不必再加"这件事只能在
 *   这里做 —— 反正重复的加进来也只是白占位置。
 *
 * @param {Array} groups 类别表（通常是 CATEGORIES）
 * @param {Array} words 原始词。元素可以是字符串（默认 block 档），
 *        也可以是 { word, tier } —— tier 取 'block' | 'review'，非法值按 block 处理。
 * @returns {Array} 新类别表；没有可用词时原样返回 groups
 */
function withExtraWords(groups, words) {
  const list = Array.isArray(words) ? words : [];
  if (!list.length) return groups;

  // 静态词全量集合，用来剔重（含 block 与 review 两侧 —— 静态已经拦了的，
  // 动态再加一遍没有意义，档位高低也不该由动态表去改写）
  const statics = new Set();
  for (let i = 0; i < groups.length; i++) {
    const cat = groups[i] || {};
    const push = function (arr) {
      for (let j = 0; j < (arr || []).length; j++) statics.add(arr[j]);
    };
    push(cat.block);
    push(cat.review);
  }

  // 【为什么分两趟】seen 是共享的，若混在一趟里遍历，同一个词属于哪一档就取决于
  //   输入顺序（先出现的那档赢）。分两趟 = block 无条件优先，结果与输入顺序无关。
  const seen = new Set();
  function pick(wantTier) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const isObj = it && typeof it === 'object';
      const tier = (isObj && it.tier === 'review') ? 'review' : 'block';
      if (tier !== wantTier) continue;
      const norm = normalize(isObj ? it.word : it);
      if (!norm || norm.length < MIN_WORD_LEN) continue; // 空/单字：丢弃
      if (statics.has(norm) || seen.has(norm)) continue; // 与静态词重复 / 与已收的重复
      if (seen.size >= MAX_EXTRA_WORDS) break;           // 容量上界
      seen.add(norm);
      out.push(norm);
    }
    return out;
  }
  const dynBlock = pick('block');
  const dynReview = pick('review');
  if (!dynBlock.length && !dynReview.length) return groups;

  // 刻意都不带 scene —— 全场景生效（含昵称）
  const out = [];
  if (dynBlock.length) {
    out.push({ key: EXTRA_KEY, label: EXTRA_LABEL, block: dynBlock, review: [] });
  }
  const tail = [];
  if (dynReview.length) {
    tail.push({ key: EXTRA_REVIEW_KEY, label: EXTRA_REVIEW_LABEL, block: [], review: dynReview });
  }
  return out.concat(groups).concat(tail);
}

/**
 * 匹配文本：返回命中的类别与严重度，并带调试信息（matchCostMs / normalizedText）。
 * @param {String} text 原始文本
 * @param {Object} [opts] { scene, categories } 场景 1=资料/昵称 2=评论 3=推文；
 *        带 scene:1 标记的类别（如仿冒官方昵称）只在 scene=1 时生效。
 *        categories —— 类别表覆盖项，默认 CATEGORIES。调用方（secCheck）把
 *        动态词库并进来之后传这里，**不要在每次调用时现并**：合并是 O(词数)，
 *        而 match 在发布热路径上，应当由调用方缓存合并结果。
 * @returns {{severity:('block'|'review'|null), category:(String|null), categoryLabel:String, keywords:String[], matchCostMs:Number, normalizedText:String}}
 */
function match(text, opts) {
  const start = Date.now();
  const scene = (opts && opts.scene) || 3;
  const cats = (opts && Array.isArray(opts.categories) && opts.categories.length)
    ? opts.categories : CATEGORIES;
  const norm = normalize(text);
  const cost = function () { return Date.now() - start; };
  const debug = { matchCostMs: cost(), normalizedText: norm.slice(0, 80) };
  if (!norm) return Object.assign({ severity: null, category: null, categoryLabel: '', keywords: [] }, debug);
  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    // 昵称专属类别（scene:1）：只在昵称场景生效，不拦截推文/评论正文里的正常用词
    if (cat.scene === 1 && scene !== 1) continue;
    const blockHits = hitWords(norm, cat.block);
    if (blockHits.length) {
      return Object.assign({ severity: 'block', category: cat.key, categoryLabel: cat.label, keywords: blockHits.slice(0, 5) }, debug);
    }
    const reviewHits = hitWords(norm, cat.review);
    if (reviewHits.length) {
      return Object.assign({ severity: 'review', category: cat.key, categoryLabel: cat.label, keywords: reviewHits.slice(0, 5) }, debug);
    }
  }
  return Object.assign({ severity: null, category: null, categoryLabel: '', keywords: [] }, debug);
}

module.exports = {
  match: match,
  normalize: normalize,
  CATEGORIES: CATEGORIES,
  withExtraWords: withExtraWords,
  EXTRA_KEY: EXTRA_KEY,
  EXTRA_LABEL: EXTRA_LABEL,
  EXTRA_REVIEW_KEY: EXTRA_REVIEW_KEY,
  EXTRA_REVIEW_LABEL: EXTRA_REVIEW_LABEL,
  MAX_EXTRA_WORDS: MAX_EXTRA_WORDS,
  MIN_WORD_LEN: MIN_WORD_LEN,
};
