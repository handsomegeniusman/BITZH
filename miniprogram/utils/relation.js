/**
 * utils/relation.js —— 猫猫关系公共逻辑
 * ============================================================
 * 【作用】关系编辑（components/relation-editor/）的纯逻辑 + 数据库封装，
 *        让 addCat / editCat 两个页面只做轻量集成：
 *    1. relatedCats 字符串 <-> 数组互转（格式「名字。关系」空格分隔，与 catDetail 一致）
 *    2. 反向关系自动配对（对称 / 性别敏感 / 未知 三类）
 *    3. 关系名称模糊搜索（名字/昵称，防抖由组件负责）
 *    4. 双向同步：把"对方猫页面的反向关系"写入数据库（含昵称刷新）
 *    5. 暂存关系补全：新猫创建时扫描旧猫 relatedCats 里指向新猫的条目，
 *       把反向关系自动加到新猫身上（历史"未找到"关系的兜底）
 * ============================================================
 */
const db = require('./db.js');
const guard = require('./guard.js');
const catForm = require('./catForm.js');

// ---------- 1. relatedCats 字符串 <-> 数组互转 ----------

/** 「名字。关系 名字。关系」-> [{name, relation}]（首个「。」前为名字） */
function parseRelatedCats(str) {
  if (!str) return [];
  return String(str)
    .split(' ')
    .filter(Boolean)
    .map(function (seg) {
      const idx = seg.indexOf('。');
      if (idx < 0) return { name: seg, relation: '' };
      return { name: seg.slice(0, idx), relation: seg.slice(idx + 1) };
    });
}

/** [{name, relation}] -> 「名字。关系 名字。关系」；relation 为空只写名字 */
function buildRelatedCats(arr) {
  const list = Array.isArray(arr) ? arr : [];
  return list
    .filter(function (x) { return x && x.name; })
    .map(function (x) { return x.relation ? x.name + '。' + x.relation : x.name; })
    .join(' ');
}

/** 关系文字清洗：去首尾空白、去尾部「。」 */
function normalizeRelation(text) {
  return String(text || '')
    .trim()
    .replace(/。+$/, '');
}

/** 把追加的 [{name, relation}] 合进已有 relatedCats 字符串（按名字去重，已有优先） */
function mergeRelations(existingStr, additions) {
  const entries = parseRelatedCats(existingStr);
  const seen = {};
  entries.forEach(function (e) { seen[e.name] = true; });
  (Array.isArray(additions) ? additions : []).forEach(function (a) {
    if (!a || !a.name || a.relation == null) return; // relation 可为空字符串（关系类型不明但有关联）
    if (seen[a.name]) return;
    seen[a.name] = true;
    entries.push({ name: a.name, relation: a.relation });
  });
  return buildRelatedCats(entries);
}

// ---------- 2. 反向关系自动配对 ----------

/** 常见关系快捷词条（填关系弹窗的候选 chips） */
const COMMON_RELATIONS = [
  '母亲', '父亲', '孩子', '儿子', '女儿',
  '姐姐', '哥哥', '妹妹', '弟弟', '同胞',
  '兄弟', '姐妹', '朋友', '邻居', '饭友',
  '奶奶', '干女儿', '追求者',
];

/** 对称关系：反向 = 自身 */
const SYMMETRIC = [
  '同胞', '兄弟', '姐妹', '朋友', '邻居', '饭友',
  '同伴', '伙伴', '伴侣', '爱人', '夫妻', '同伙',
  '曾经的伙伴',
];

/**
 * 性别敏感成对关系：键 = 用户填的关系（T 是 C 的 {关系}），
 * c[0] = 当前猫(C)性别为『公』时对方(T)对 C 的称呼，
 * c[1] = 当前猫(C)性别为『母』时对方(T)对 C 的称呼，
 * fb   = 性别未知时的回退词（父子/母子类统一用「孩子」；其余留空让用户手填）。
 */
const GENDER_PAIRS = {
  '母亲': { c: ['儿子', '女儿'], fb: '孩子' },
  '妈妈': { c: ['儿子', '女儿'], fb: '孩子' },
  '父亲': { c: ['儿子', '女儿'], fb: '孩子' },
  '爸爸': { c: ['儿子', '女儿'], fb: '孩子' },
  '孩子': { c: ['父亲', '母亲'], fb: '' },
  '儿子': { c: ['父亲', '母亲'], fb: '' },
  '女儿': { c: ['父亲', '母亲'], fb: '' },
  '姐姐': { c: ['弟弟', '妹妹'], fb: '' },
  '哥哥': { c: ['弟弟', '妹妹'], fb: '' },
  '妹妹': { c: ['哥哥', '姐姐'], fb: '' },
  '弟弟': { c: ['哥哥', '姐姐'], fb: '' },
  '奶奶': { c: ['孙子', '孙女'], fb: '' },
  '爷爷': { c: ['孙子', '孙女'], fb: '' },
  '孙女': { c: ['爷爷', '奶奶'], fb: '' },
  '孙子': { c: ['爷爷', '奶奶'], fb: '' },
  '外婆': { c: ['外孙', '外孙女'], fb: '' },
  '姥姥': { c: ['外孙', '外孙女'], fb: '' },
  '外公': { c: ['外孙', '外孙女'], fb: '' },
  '姥爷': { c: ['外孙', '外孙女'], fb: '' },
  '外孙女': { c: ['外公', '外婆'], fb: '' },
  '外孙': { c: ['外公', '外婆'], fb: '' },
  '祖奶奶': { c: ['曾孙', '曾孙女'], fb: '' },
  '曾祖母': { c: ['曾孙', '曾孙女'], fb: '' },
  '祖爷爷': { c: ['曾孙', '曾孙女'], fb: '' },
  '曾祖父': { c: ['曾孙', '曾孙女'], fb: '' },
  '曾孙女': { c: ['曾爷爷', '曾奶奶'], fb: '' },
  '曾孙': { c: ['曾爷爷', '曾奶奶'], fb: '' },
  '干妈': { c: ['干儿子', '干女儿'], fb: '' },
  '干爹': { c: ['干儿子', '干女儿'], fb: '' },
  '干女儿': { c: ['干爹', '干妈'], fb: '' },
  '干儿子': { c: ['干爹', '干妈'], fb: '' },
  '继父': { c: ['继子', '继女'], fb: '' },
  '后爸': { c: ['继子', '继女'], fb: '' },
  '继母': { c: ['继子', '继女'], fb: '' },
  '后妈': { c: ['继子', '继女'], fb: '' },
  '继子': { c: ['继父', '继母'], fb: '' },
  '继女': { c: ['继父', '继母'], fb: '' },
};

/** 反向关系固定（不依赖性别）：键 = 用户填的关系 -> 对方可能的称呼候选 */
const FIXED_PAIRS = {
  '丈夫': ['妻子', '老婆'],
  '老公': ['妻子', '老婆'],
  '妻子': ['丈夫', '老公'],
  '老婆': ['丈夫', '老公'],
  '受害猫': ['施暴猫'],
  '施暴猫': ['受害猫'],
  '施暴者': ['受害者'],
  '受害者': ['施暴者'],
  '大哥': ['小弟'],
  '大姐': ['小弟'],
  '小弟': ['大哥'],
};

/**
 * 计算反向关系：T 是 C 的 {relation}，则 C 是 T 的什么？
 * @param {String} relation   用户填的关系（T 与 C 的关系）
 * @param {String} selfGender 当前猫 C 的性别（'公' / '母' / 其他）
 * @returns {{known:Boolean, symmetric:Boolean, candidates:Array, prefill:String}}
 *   known     = 是否能自动配对（false 表示特殊关系需手动输入）
 *   symmetric = 是否对称关系（反向 = 原词）
 *   candidates= 可供点选的反向候选词条
 *   prefill   = 预填给用户的反向词（可能为空，空则留待手填）
 */
function getInverse(relation, selfGender) {
  const r = normalizeRelation(relation);
  if (!r) {
    return { known: false, symmetric: false, candidates: [], prefill: '' };
  }
  if (SYMMETRIC.indexOf(r) >= 0) {
    return { known: true, symmetric: true, candidates: [r], prefill: r };
  }
  if (GENDER_PAIRS[r]) {
    const pair = GENDER_PAIRS[r];
    const idx = selfGender === '公' ? 0 : selfGender === '母' ? 1 : -1;
    return {
      known: true,
      symmetric: false,
      candidates: pair.c,
      prefill: idx >= 0 ? pair.c[idx] : pair.fb,
    };
  }
  if (FIXED_PAIRS[r]) {
    const cands = FIXED_PAIRS[r];
    return { known: true, symmetric: false, candidates: cands, prefill: cands[0] };
  }
  // 特殊 / 未知关系：交给用户手动判断
  return { known: false, symmetric: false, candidates: [], prefill: '' };
}

// ---------- 3. 关系名称模糊搜索 ----------

/**
 * 模糊搜索猫咪（按名字匹配；名字没搜到再按昵称搜，两边都排除不想要的猫）
 * @param {String} keyword 搜索关键词
 * @param {Array}  exclude 需要排除的名字（当前猫 + 已在列表中的猫）
 * @returns {Promise<Array>} 猫咪记录数组（最多 10 条）
 */
async function searchCats(keyword, exclude) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const excluded = new Set((exclude || []).filter(Boolean));
  const r = guard.escapeRegExp(kw);

  const hit = {};
  const results = [];
  function push(list) {
    (list || []).forEach(function (c) {
      if (!c || !c.name || hit[c.name] || excluded.has(c.name)) return;
      hit[c.name] = true;
      results.push(c);
    });
  }
  try {
    const byName = await db.find('BITZH', { name: { $regex: r, $options: 'i' } }, { limit: 10 });
    push(byName);
    if (results.length < 10) {
      const byNick = await db.find('BITZH', { nickname: { $regex: r, $options: 'i' } }, { limit: 10 });
      push(byNick);
    }
  } catch (err) {
    console.error('搜索猫咪失败', err);
  }
  return results.slice(0, 10);
}

// ---------- 4. 双向同步（把对方猫页面的反向关系写入数据库） ----------

/**
 * 应用同步任务：把"当前猫"写到对方猫的 relatedCats 里（或删除）。
 * 同步延迟到页面"确定提交"时调用，保证用户中途取消时数据库不被污染。
 * @param {Array}  syncTasks [{name: 对方猫名, relation: 反向关系} | {name, remove:true}]
 * @param {String} catName   当前猫名（也是写进对方 relatedCats 的名字 key）
 * @returns {Promise<Number>} 实际更新的猫数
 */
async function applySyncTasks(syncTasks, catName) {
  const tasks = Array.isArray(syncTasks) ? syncTasks : [];
  if (!tasks.length || !catName) return 0;

  // 同一个对方猫多个任务时，取最后一条（按用户操作顺序，后操作覆盖先操作）
  const merged = {};
  tasks.forEach(function (t) {
    if (!t || !t.name) return;
    merged[t.name] = t.remove ? { remove: true } : { relation: t.relation };
  });

  const names = Object.keys(merged);
  let applied = 0;
  try {
    const cats = await db.find('BITZH', { name: { $in: names } });
    for (const other of cats) {
      const task = merged[other.name];
      const entries = parseRelatedCats(other.relatedCats);
      let next;
      if (task.remove) {
        next = entries.filter(function (e) { return e.name !== catName; });
        if (next.length === entries.length) continue; // 对方本来就没有，无需写
      } else {
        let found = false;
        next = entries.map(function (e) {
          if (e.name === catName) {
            found = true;
            return { name: catName, relation: task.relation };
          }
          return e;
        });
        if (!found) next.push({ name: catName, relation: task.relation });
      }
      await updateCatRelations(other, next);
      applied++;
    }
  } catch (err) {
    console.error('同步关系失败', err);
  }
  return applied;
}

/** 更新某只猫的 relatedCats（连带刷新 nickname，因为 nickname 由各字段拼成） */
async function updateCatRelations(cat, entries) {
  const relatedCats = buildRelatedCats(entries);
  if (relatedCats === (cat.relatedCats || '')) return;
  const update = { relatedCats: relatedCats };
  const nickname = catForm.nickname(Object.assign({}, cat, { relatedCats: relatedCats }));
  if (nickname !== cat.nickname) update.nickname = nickname;
  await db.updateOne('BITZH', { _id: cat._id }, { $set: update });
}

// ---------- 5. 暂存关系补全（新猫创建时自动关联旧"未找到"关系） ----------

/**
 * 扫描全部猫，找出 relatedCats 里指向 newName 的条目，返回新猫应该反向补充的关系。
 * 例如：猫A 暂存过「小猫X。女儿」，创建 X 后，X 应获得「猫A。母亲/父亲」。
 * 反向不可计算（特殊关系）的条目自动跳过，留给管理员手动处理。
 * @param {String} newName     新猫名字
 * @returns {Promise<Array>} [{name: 旧猫名, relation: 反向关系}]
 */
async function collectInheritedRelations(newName, newGender) {
  if (!newName) return [];
  const out = [];
  const seen = {};
  try {
    const cats = await db.find('BITZH', {});
    cats.forEach(function (c) {
      if (c.name === newName) return;
      parseRelatedCats(c.relatedCats).forEach(function (e) {
        if (e.name !== newName) return;
        if (seen[c.name]) return;
        const inv = getInverse(e.relation, c.gender);
        if (!inv.known || !inv.prefill) return; // 无法自动配对，跳过
        seen[c.name] = true;
        out.push({ name: c.name, relation: inv.prefill });
      });
    });
  } catch (err) {
    console.error('扫描暂存关系失败', err);
  }
  return out;
}

/**
 * 把全库猫的 relatedCats 里指向 oldName 的条目替换成 newName（改名前调用），
 * 保持关系图一致，避免改名后其他猫残留"指向不存在猫"的陈旧引用。
 * 关系词原样保留（A。兄弟 改名为 B 后 → B。兄弟）。昵称同步刷新。
 * @returns {Promise<Number>} 实际改动到的猫数量
 */
async function renameCat(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return 0;
  let applied = 0;
  try {
    const cats = await db.find('BITZH', {});
    for (const c of cats) {
      if (c.name === newName) continue; // 不处理被改名后的猫自己
      const entries = parseRelatedCats(c.relatedCats).map(function (e) {
        if (e.name === oldName) return { name: newName, relation: e.relation };
        return e;
      });
      if (JSON.stringify(entries) !== JSON.stringify(parseRelatedCats(c.relatedCats))) {
        await updateCatRelations(c, entries);
        applied++;
      }
    }
  } catch (err) {
    console.error('批量改名相关引用失败', err);
  }
  return applied;
}

/**
 * 删除猫时清理全库其他猫的 relatedCats 里指向该猫的引用（删除后调用），
 * 避免详情页残留指向已删除猫的关系条目。昵称同步刷新。
 * @returns {Promise<Number>} 实际改动到的猫数量
 */
async function removeCatRefs(catName) {
  if (!catName) return 0;
  let applied = 0;
  try {
    const cats = await db.find('BITZH', {});
    for (const c of cats) {
      if (c.name === catName) continue; // 不处理被删的猫自己
      const entries = parseRelatedCats(c.relatedCats).filter(function (e) {
        return e.name !== catName;
      });
      if (entries.length !== parseRelatedCats(c.relatedCats).length) {
        await updateCatRelations(c, entries);
        applied++;
      }
    }
  } catch (err) {
    console.error('清理删除猫的引用失败', err);
  }
  return applied;
}

module.exports = {
  // 字符串 <-> 数组
  parseRelatedCats: parseRelatedCats,
  buildRelatedCats: buildRelatedCats,
  normalizeRelation: normalizeRelation,
  mergeRelations: mergeRelations,
  // 反向配对
  COMMON_RELATIONS: COMMON_RELATIONS,
  getInverse: getInverse,
  // 搜索 / 同步 / 继承
  searchCats: searchCats,
  applySyncTasks: applySyncTasks,
  collectInheritedRelations: collectInheritedRelations,
  // 改名 / 删除时的关系引用清理
  renameCat: renameCat,
  removeCatRefs: removeCatRefs,
};
