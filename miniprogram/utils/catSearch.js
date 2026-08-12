/**
 * utils/catSearch.js —— 猫咪搜索（大名 / 绰号 / 关系词 / 地名 / 毛色分类 / 性别 / 状况）
 * ============================================================
 * 【背景】小猫书首页（index）的搜索只搜推文（话题/标题），搜猫绰号认不出；
 *        查猫页（catSearch）只搜 nickname 复合字段，搜「小白的妈妈」这类
 *        关系短语不命中。本模块统一解决三类问题：
 *        1. 大名 / 绰号 / 关键词：命中 name / nickname（昵称=各字段拼接的关键词）
 *        2. 关系短语：「X的妈妈/孩子/姐姐/朋友…」→ 从 relatedCats 关系图找对猫，
 *           且返回 X 的「所有关系」，指定关系排最前（如「肥仔的女儿」→ 女儿在前）
 *        3. 多关键词 / 组合描述：「39栋狸花」「明德楼的黄猫」→ 拆成多个搜索单元，
 *           按「命中越多越靠前 + 先输入的关键词权重更高」排序展示
 * 【数据驱动】一次拉取全量猫（小集合，60s 缓存）：
 *        - 用真实的地点/毛色分类/花色/外貌等值做关键词二次切分（明德楼三教 → 明德楼+三教）
 *        - 纯客户端打分，不再依赖数据库 $or + limit 截断（避免"狸花猫太多把目标猫挤掉"）
 * 【打分权重】结构化字段（毛色分类/花色/地点/性别/绝育/状态）完全相等 > 包含；
 *        name 完全相等最高；自由文本（外观/性格/名字来源/绰号）包含较弱。
 *        同一搜索单元内取最高分；跨单元累加（命中单元越多分越高），
 *        越靠前的单元权重加成越高（用户先输入的关键词优先）。
 * 【关系图存储约定】relatedCats 格式「名字。关系 名字。关系」；双向关系自动同步
 *        （relation.js applySyncTasks），所以：
 *        - 妈妈 A 的记录里有「小白。孩子」；小白（孩子）的记录里有「A。母亲」
 *        - 搜「小白的妈妈」→ 找 relatedCats 里写了「小白。孩子/儿子/女儿」的猫 = A
 *        - 反向未同步时，兜底读 X 自己的记录（同样从全量 rows 里找，不再查库）
 * 【性能】搜索核心 = 一次缓存的全量查询 + O(n·m) 客户端打分（n=猫数量级几十~几百）。
 * ============================================================
 */
const db = require('./db.js');
const guard = require('./guard.js');
const relation = require('./relation.js'); // parseRelatedCats（关系兜底解析）

// ---------- 关系口语 → 存储用关系词（relatedCats「名字。关系」里的关系文本） ----------
const REL_ALIASES = {
  '妈妈': ['妈妈', '母亲', '妈'],
  '老妈': ['妈妈', '母亲', '妈'],
  '母亲': ['母亲', '妈妈', '妈'],
  '妈': ['妈妈', '母亲'],
  '爸爸': ['爸爸', '父亲', '爹'],
  '老爸': ['爸爸', '父亲', '爹'],
  '父亲': ['父亲', '爸爸', '爹'],
  '爹': ['父亲', '爸爸'],
  '爸': ['爸爸', '父亲'],
  '孩子': ['孩子', '儿子', '女儿', '崽'],
  '崽': ['孩子', '儿子', '女儿'],
  '儿子': ['儿子', '孩子'],
  '女儿': ['女儿', '孩子'],
  '姐姐': ['姐姐'],
  '哥哥': ['哥哥'],
  '妹妹': ['妹妹'],
  '弟弟': ['弟弟'],
  '奶奶': ['奶奶', '外婆', '姥姥'],
  '爷爷': ['爷爷', '外公', '姥爷'],
  '外婆': ['外婆', '奶奶', '姥姥'],
  '姥姥': ['姥姥', '奶奶', '外婆'],
  '外公': ['外公', '爷爷', '姥爷'],
  '姥爷': ['姥爷', '爷爷', '外公'],
  '朋友': ['朋友'],
  '邻居': ['邻居'],
  '饭友': ['饭友'],
  '兄弟': ['兄弟', '哥哥', '弟弟'],
  '姐妹': ['姐妹', '姐姐', '妹妹'],
  '同胞': ['同胞', '兄弟', '姐妹'],
  '老婆': ['老婆', '妻子'],
  '老公': ['老公', '丈夫'],
  '妻子': ['妻子', '老婆'],
  '丈夫': ['丈夫', '老公'],
};

// ---------- 关系词 → 对方记录里「X。」后面可能出现的反向关系词 ----------
// 搜「X的妈妈」时，妈妈猫自己的记录写的是「小白。孩子/儿子/女儿」，
// 所以这里给出"对方视角称呼 X"的词集，用于一次性正则命中。
const INV_RELS = {
  '妈妈': ['儿子', '女儿', '孩子'],
  '老妈': ['儿子', '女儿', '孩子'],
  '母亲': ['儿子', '女儿', '孩子'],
  '妈': ['儿子', '女儿', '孩子'],
  '爸爸': ['儿子', '女儿', '孩子'],
  '老爸': ['儿子', '女儿', '孩子'],
  '父亲': ['儿子', '女儿', '孩子'],
  '爹': ['儿子', '女儿', '孩子'],
  '爸': ['儿子', '女儿', '孩子'],
  '孩子': ['母亲', '妈妈', '妈', '父亲', '爸爸', '爹'],
  '崽': ['母亲', '妈妈', '妈', '父亲', '爸爸', '爹'],
  '儿子': ['母亲', '妈妈', '妈', '父亲', '爸爸', '爹'],
  '女儿': ['母亲', '妈妈', '妈', '父亲', '爸爸', '爹'],
  '姐姐': ['弟弟', '妹妹'],
  '哥哥': ['弟弟', '妹妹'],
  '妹妹': ['哥哥', '姐姐'],
  '弟弟': ['哥哥', '姐姐'],
  '奶奶': ['孙子', '孙女'],
  '爷爷': ['孙子', '孙女'],
  '外婆': ['外孙', '外孙女'],
  '姥姥': ['外孙', '外孙女'],
  '外公': ['外孙', '外孙女'],
  '姥爷': ['外孙', '外孙女'],
  '朋友': ['朋友'],
  '邻居': ['邻居'],
  '饭友': ['饭友'],
  '兄弟': ['兄弟'],
  '姐妹': ['姐妹'],
  '同胞': ['同胞'],
  '老婆': ['丈夫', '老公', '老婆'],
  '老公': ['妻子', '老婆', '丈夫'],
  '妻子': ['丈夫', '老公', '妻子'],
  '丈夫': ['妻子', '老婆', '丈夫'],
};

// 关系短语正则：「X的Y」或「XY」（无"的"），X 限 1~20 字（中文名或绰号），Y 为口语关系词。
// 名字用懒惰匹配，保证「肥仔的女儿」的"的"被 的? 吃下、名字落在"肥仔"上。
const REL_PHRASE_RE = /^(.{1,20}?)的?(妈妈|老妈|母亲|妈|爸爸|老爸|父亲|爹|爸|孩子|崽|儿子|女儿|姐姐|哥哥|妹妹|弟弟|奶奶|爷爷|外婆|姥姥|外公|姥爷|朋友|邻居|饭友|兄弟|姐妹|同胞|老婆|老公|妻子|丈夫)$/;

/** 普通关键词搜索覆盖的字段：大名/绰号 + 地名/外貌/花色/状态/性别/性格等（防老猫 nickname 缺失或过期） */
const PLAIN_FIELDS = [
  'name', 'nickname', 'location', 'appearance', 'classification', 'furColor',
  'status', 'gender', 'isSterilization', 'character', 'firstSightingLocation', 'namereason',
];

/** 结构化受控字段：完全相等命中的权重要明显高于"自由文本包含" */
const EXACT_FIELDS = ['classification', 'furColor', 'location', 'gender', 'isSterilization', 'status', 'firstSightingLocation'];

// 已知类别词（毛色 / 花色 / 品种 / 常见外观），用于「黄毛明德楼」这类无分隔拼接的切分提示。
// 只用来"多切一个候选词"：整词仍保留为最高优先级单元，切错只是多查、不影响准确度。
// 按长度降序排列，切分时取「最长匹配前缀」。
const CATEGORY_WORDS = [
  '银渐层', '中华田园', '三花', '黑白', '奶牛', '狸花', '梨花', '橘白', '白橘', '黄白',
  '黄毛', '橘猫', '橘色', '黄色', '白色', '黑色', '灰色',
  '暹罗', '布偶', '英短', '美短', '加菲', '蓝猫', '虎斑', '豹猫',
  '黄', '橘', '白', '黑', '灰',
].sort(function (a, b) { return b.length - a.length; });

// 数据字典字段：从猫的数据里提取这些受控短词，用于拆解模糊关键词
// （地点 / 毛色分类 / 花色 / 外貌 / 首次发现地点）。名字、绰号由主查询直接命中，不进字典。
const DICT_FIELDS = ['location', 'classification', 'furColor', 'appearance', 'firstSightingLocation'];

/** 关系词 → 反向词集缓存（避免每条猫重复拼正则） */
const _relReCache = {};
function relInvPart(rel) {
  if (_relReCache[rel]) return _relReCache[rel];
  const relWords = REL_ALIASES[rel] || [rel];
  const inv = [];
  relWords.forEach(function (w) {
    (INV_RELS[w] || []).forEach(function (i) { if (inv.indexOf(i) < 0) inv.push(i); });
  });
  relWords.forEach(function (w) { if (inv.indexOf(w) < 0) inv.push(w); });
  _relReCache[rel] = '(' + inv.map(guard.escapeRegExp).join('|') + ')';
  return _relReCache[rel];
}

// ---------- 全量猫数据（小集合，60s 缓存） ----------
let _rows = null;
let _rowsAt = 0;
const ROWS_TTL = 60000;
const ROWS_LIMIT = 300;

/** 清空全量猫缓存（测试用；真实运行中 60s 自动过期） */
function _resetDictCache() {
  _rows = null;
  _rowsAt = 0;
}

/** 拉取全量猫记录（缓存 60s）。失败返回上次结果或 [] */
async function fetchAllCats() {
  const now = Date.now();
  if (_rows && now - _rowsAt < ROWS_TTL) return _rows;
  let rows = [];
  try {
    rows = (await db.find('BITZH', {}, { limit: ROWS_LIMIT })) || [];
  } catch (e) { console.error('获取猫数据失败', e); }
  _rows = rows;
  _rowsAt = Date.now();
  return rows;
}

/** 从全量猫记录提取"数据字典"：地点/毛色分类/花色/外貌等受控短词（去重） */
function buildDict(rows) {
  const vals = [];
  const seen = {};
  (rows || []).forEach(function (c) {
    DICT_FIELDS.forEach(function (f) {
      const v = c && c[f];
      if (v == null || String(v).trim() === '') return;
      const s = String(v).trim();
      if (s.length > 12) return; // 受控短词，过滤长句
      if (!seen[s]) { seen[s] = true; vals.push(s); }
    });
  });
  return vals;
}

/** 数据字典（供外部/测试使用） */
async function fetchDict() {
  return buildDict(await fetchAllCats());
}

/**
 * 解析关系短语 token：「小白的妈妈」→ { name:'小白', rel:'妈妈' }；「肥仔女儿」同样命中。
 * @param {String} token
 * @returns {{name:String, rel:String}|null}
 */
function parseRelToken(token) {
  const m = REL_PHRASE_RE.exec(String(token || '').trim());
  if (!m) return null;
  return { name: m[1], rel: m[2] };
}

/**
 * 排名（保留原语义，供兼容/测试）：完全同名 > 名前缀 > 名包含 > 昵称包含（按位置）。
 * 新版 searchCats 用更细的「多单元加权」，rankCats 作为次级排序依据保留。
 */
function rankCats(list, query) {
  const parts = String(query || '').trim().toLowerCase().split(/[\s　]+/).filter(Boolean);
  const k = (parts[0] || '').toLowerCase();
  if (!k) return list || [];
  return (list || []).map(function (c) {
    const name = String((c && c.name) || '').toLowerCase();
    const nick = String((c && c.nickname) || '').toLowerCase();
    let score;
    if (name === k) score = 0;
    else if (name.indexOf(k) === 0) score = 1;
    else if (name.indexOf(k) >= 0) score = 2;
    else if (nick.indexOf(k) >= 0) score = 3 + nick.indexOf(k);
    else score = 999;
    return { c: c, score: score };
  }).sort(function (a, b) { return a.score - b.score; }).map(function (x) { return x.c; });
}

/** 已知类别词的最长前缀匹配（如"黄毛明德楼"→"黄毛"） */
function longestKnownPrefix(raw) {
  for (let i = 0; i < CATEGORY_WORDS.length; i++) {
    if (raw.indexOf(CATEGORY_WORDS[i]) === 0) return CATEGORY_WORDS[i];
  }
  return '';
}

/** 两串从开头起相同的字符数（公共前缀长度） */
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * 把单个普通词展开成若干候选词（按"先输入的关键词优先"排序返回）：
 *   1. 整词（最高优先级）
 *   2. 「的」切分：明德楼的黄猫 → 明德楼 / 黄猫
 *   3. 已知类别词前缀切分（无"的"拼接）：黄毛明德楼 → 黄毛 / 明德楼
 *   4. 数据驱动切分：从猫数据字典里取「词内出现的受控值」：明德楼三教 → 明德楼 / 三教
 *   5. 去尾「猫/咪」变体：黄猫 → 黄（可命中毛色"黄色"；仅短词，避免噪声）
 * 排序规则：整词恒第一；其余按在词中的位置升序（越靠前 = 用户越先输入 = 权重越高），
 * 同位置越长越优先。
 * @param {String} raw 单个普通词
 * @param {Array<String>} dict 猫数据字典（可省略）
 * @returns {Array<String>} 候选词数组（最多 6 个）
 */
function expandPlainTerms(raw, dict) {
  const items = [];
  const add = function (t, pos) {
    if (!t || t.length < 1 || pos < 0) return;
    if (items.some(function (it) { return it.t === t; })) return;
    items.push({ t: t, pos: pos });
  };
  add(raw, 0);
  // 「的」切分（1 字短词不参与，避免"图书馆的猫"拆出"猫"这种噪声）
  if (raw.indexOf('的') >= 0) {
    raw.split('的').forEach(function (p) {
      if (p && p.length >= 2) add(p, raw.indexOf(p));
    });
  } else {
    // 已知类别词前缀切分（无"的"拼接）
    const cw = longestKnownPrefix(raw);
    if (cw && raw.length > cw.length) {
      const rest = raw.slice(cw.length);
      if (rest.length >= 2) { add(cw, 0); add(rest, cw.length); }
    }
  }
  // 数据驱动的候选词（从猫的数据里提取的地点/颜色/花色/外貌等受控词）
  (dict || []).forEach(function (v) {
    if (!v || v === raw || v.length < 1) return;
    const idx = raw.indexOf(v);
    if (idx < 0) return;
    // 单字只允许颜色/花色类受控词（地点/名字类 ≥2 字，避免误切）
    if (v.length === 1 && CATEGORY_WORDS.indexOf(v) < 0) return;
    add(v, idx);
  });
  // 数据驱动的"公共前缀扩展"：受控词不是 raw 的子串、但与 raw 共享较长前缀时
  // （如「27保镖」vs 地点「27栋」：公共前缀「27」，用户缩写掉了"栋"），
  // 把该受控词和 raw 剩余部分都作为候选，让"数字楼栋+猫名"这类缩写也能命中。
  // 仅对"受控词比前缀长、raw 有 ≥2 字尾巴"的情况做扩展；多个词共享前缀时
  // 只取最短（最贴近楼栋/地点的那个），避免候选词膨胀挤掉猫名单元。
  let prefixV = null;
  let prefixLen = 0;
  (dict || []).forEach(function (v) {
    if (!v || v === raw || v.length < 2) return;
    const plen = commonPrefixLen(raw, v);
    if (plen < 2 || plen >= v.length || plen >= raw.length) return;
    const rest = raw.slice(plen);
    if (rest.length < 2) return;
    if (!prefixV || v.length < prefixV.length) { prefixV = v; prefixLen = plen; }
  });
  if (prefixV) {
    add(prefixV, 0);
    add(raw.slice(prefixLen), prefixLen);
  }
  // 去尾「猫/咪」变体（仅短词）
  items.slice().forEach(function (it) {
    if (it.t.length > 1 && it.t.length <= 4 && /[猫咪]$/.test(it.t)) {
      add(it.t.slice(0, -1), it.pos + it.t.length - 1);
    }
  });
  items.sort(function (a, b) {
    if (a.t === raw) return -1;
    if (b.t === raw) return 1;
    if (a.pos !== b.pos) return a.pos - b.pos;
    return b.t.length - a.t.length;
  });
  return items.map(function (it) { return it.t; }).slice(0, 6);
}

/**
 * 拆解 query 成搜索单元列表。单元 kind：
 *   - {kind:'plain', term, order}  普通词（命中 name/nickname/地名/毛色分类/性别/状况等）
 *   - {kind:'rel', name, rel, order}  关系短语（X 的 Y：找与 X 有 Y 关系的猫）
 * order 越小权重越高（用户先输入的关键词优先）。
 * @param {String} query
 * @param {Array<String>} [dict] 猫数据字典（可选，用于数据驱动二次切分）
 * @returns {Array}
 */
function buildUnits(query, dict) {
  const rawTokens = String(query || '').trim().split(/[\s　]+/).filter(Boolean);
  const units = [];
  let order = 0;
  rawTokens.forEach(function (raw) {
    const rel = parseRelToken(raw);
    if (rel) {
      units.push({ kind: 'rel', name: rel.name, rel: rel.rel, order: order++ });
      // 兜底：整词也按普通关键词再搜一遍，覆盖"猫名恰好是 / 以关系词结尾"的情况
      //（如搜「大橘妈」「妈妈」时，用户可能找的是一只叫这个名字的猫，而不是关系查询）。
      // 普通单元只做弱命中（名字/绰号/自由文本包含），不会抢走"关系最前"的排序。
      units.push({ kind: 'plain', term: raw, order: order++ });
      return;
    }
    expandPlainTerms(raw, dict).forEach(function (t) {
      units.push({ kind: 'plain', term: t, order: order++ });
    });
  });
  return units;
}

/** 关系单元打分：具体关系命中 3 > 该猫的其它任意关系 1 > 无关 0 */
function relScore(c, name, rel) {
  const rc = String((c && c.relatedCats) || '');
  if (!rc) return 0;
  const escX = guard.escapeRegExp(name);
  if (new RegExp(escX + '。').test(rc)) {
    if (new RegExp(escX + '[^\\s]{0,6}?' + relInvPart(rel), 'i').test(rc)) return 3;
    return 1;
  }
  return 0;
}

/**
 * 普通词命中强度（单单元内取最高分）：
 *   5  name 完全相等（大名优先）
 *   4  结构化字段（毛色分类/花色/地点/性别/绝育/状态）完全相等
 *   2  结构化字段包含
 *   1  自由文本字段（外观/性格/名字来源/绰号 等）包含
 * @param {Object} c 猫记录
 * @param {String} term 搜索词
 * @returns {Number} 0=未命中
 */
function plainStrength(c, term) {
  const t = String(term);
  const lower = t.toLowerCase();
  const re = new RegExp(guard.escapeRegExp(term), 'i');
  let best = 0;
  // 结构化字段：完全相等 4 分 > 包含 2 分
  for (let i = 0; i < EXACT_FIELDS.length; i++) {
    const v = c[EXACT_FIELDS[i]];
    if (v == null) continue;
    const s = String(v);
    if (s.toLowerCase() === lower) best = Math.max(best, 4);
    else if (re.test(s)) best = Math.max(best, 2);
  }
  // 名字完全相等：最高优先级
  if (c.name != null && String(c.name).toLowerCase() === lower) best = Math.max(best, 5);
  // 自由文本字段：包含 1 分
  for (let i = 0; i < PLAIN_FIELDS.length; i++) {
    const v = c[PLAIN_FIELDS[i]];
    if (v == null) continue;
    if (re.test(String(v))) { best = Math.max(best, 1); break; }
  }
  return best;
}

/** 加权打分：命中单元越多越高；同命中下先输入的关键词（order 小）权重越高 */
function scoreCat(c, units) {
  const N = units.length;
  let score = 0;
  units.forEach(function (u, idx) {
    const bonus = N - idx; // 越靠前的单元权重越高
    if (u.kind === 'plain') {
      const s = plainStrength(c, u.term);
      if (s > 0) score += s + bonus;
    } else {
      const s = relScore(c, u.name, u.rel);
      if (s > 0) score += s + bonus;
    }
  });
  return score;
}

/** 次级排序：首个关键词的名优先级（大名 > 名前缀 > 名包含 > 其它） */
function namePriority(c, firstRaw) {
  const k = String(firstRaw || '').toLowerCase();
  const name = String((c && c.name) || '').toLowerCase();
  if (!k) return 3;
  if (name === k) return 0;
  if (name.indexOf(k) === 0) return 1;
  if (name.indexOf(k) >= 0) return 2;
  return 3;
}

/** 兜底：读 X 自己记录里的「Y。{关系词}」→ 找对猫（反向未同步时兜住；从全量 rows 里找，不查库） */
function relFallbackFromRows(rows, name, rel) {
  const relWords = REL_ALIASES[rel] || [rel];
  const names = [];
  (rows || []).forEach(function (x) {
    const xName = String(x && x.name || '');
    const xNick = String(x && x.nickname || '');
    // 命中 X 自己：名字相等 或 昵称包含
    if (xName !== name && xNick.indexOf(name) < 0) return;
    relation.parseRelatedCats(x.relatedCats).forEach(function (en) {
      if (en.name && relWords.indexOf(en.relation) >= 0 && names.indexOf(en.name) < 0) names.push(en.name);
    });
  });
  if (!names.length) return [];
  return (rows || []).filter(function (c) {
    return c && c.name && names.indexOf(String(c.name)) >= 0;
  });
}

/**
 * 猫咪搜索统一入口：大名 / 绰号 / 关键词 / 关系短语 / 多关键词组合。
 * 一次拉取全量猫（缓存）→ 拆词 → 客户端打分排序，杜绝数据库 $or+limit 截断。
 * @param {String} query 搜索词
 * @param {Object} opts  可选 { limit }（默认 20）
 * @returns {Promise<Array>} 加权排序后的猫咪记录数组（空搜索返回 []）
 */
async function searchCats(query, opts) {
  const q = String(query || '').trim();
  if (!q) return [];
  const limit = (opts && opts.limit) || 20;
  const rawTokens = q.split(/[\s　]+/).filter(Boolean);
  const rows = await fetchAllCats();
  const dict = buildDict(rows);
  const units = buildUnits(q, dict);
  if (!units.length) return [];

  // 1) 客户端打分：得分放进本地 map（按 _id 记），**不写回缓存对象**。
  //    之前直接把 _score 写在 rows 缓存上，60s 缓存窗口内两次搜索会串味：
  //    先搜「雪球」给雪球留下 _score，再搜「老黑的孩子」时兜底路径用
  //    `c._score === undefined` 判断，把本该兜底的雪球漏掉 → 返回空结果。
  const scores = {};
  rows.forEach(function (c) {
    const s = scoreCat(c, units);
    if (s > 0) scores[String(c._id)] = s;
  });

  // 2) 关系单元：具体关系无命中时，兜底读 X 自己的记录（反向未同步场景）
  units.forEach(function (u, i) {
    if (u.kind !== 'rel') return;
    const hasSpecific = rows.some(function (c) { return relScore(c, u.name, u.rel) === 3; });
    if (hasSpecific) return;
    const fb = relFallbackFromRows(rows, u.name, u.rel);
    const bonus = units.length - i;
    fb.forEach(function (c) {
      const id = String(c._id);
      if (scores[id] === undefined) scores[id] = 3 + bonus;
    });
  });

  // 3) 排序：命中权重 > 首词名优先级 > _id
  const firstRaw = rawTokens[0];
  const scored = rows.filter(function (c) { return scores[String(c._id)] !== undefined; });
  scored.sort(function (a, b) {
    const sa = scores[String(a._id)];
    const sb = scores[String(b._id)];
    if (sb !== sa) return sb - sa;
    const na = namePriority(a, firstRaw);
    const nb = namePriority(b, firstRaw);
    if (na !== nb) return na - nb;
    return String(a._id) < String(b._id) ? -1 : 1;
  });
  return scored.slice(0, limit);
}

module.exports = {
  parseRelToken: parseRelToken,
  searchCats: searchCats,
  rankCats: rankCats,
  buildUnits: buildUnits,
  expandPlainTerms: expandPlainTerms,
  fetchDict: fetchDict,
  fetchAllCats: fetchAllCats,
  _resetDictCache: _resetDictCache,
  REL_ALIASES: REL_ALIASES,
  INV_RELS: INV_RELS,
};
