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
    block: ['卖猫', '有偿领养', '品种猫', '繁殖', '配种', '虐猫', '打猫', '摔猫', '毒猫', '扔猫', '活埋', '猫肉', '猫皮', '猫骨'],
    review: ['偏方治疗', '土法治病', '不就医', '弃养', '转让'],
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

/**
 * 匹配文本：返回命中的类别与严重度，并带调试信息（matchCostMs / normalizedText）。
 * @param {String} text 原始文本
 * @param {Object} [opts] { scene } 场景 1=资料/昵称 2=评论 3=推文；
 *        带 scene:1 标记的类别（如仿冒官方昵称）只在 scene=1 时生效。
 * @returns {{severity:('block'|'review'|null), category:(String|null), categoryLabel:String, keywords:String[], matchCostMs:Number, normalizedText:String}}
 */
function match(text, opts) {
  const start = Date.now();
  const scene = (opts && opts.scene) || 3;
  const norm = normalize(text);
  const cost = function () { return Date.now() - start; };
  const debug = { matchCostMs: cost(), normalizedText: norm.slice(0, 80) };
  if (!norm) return Object.assign({ severity: null, category: null, categoryLabel: '', keywords: [] }, debug);
  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
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
};
