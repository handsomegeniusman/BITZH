/**
 * utils/catForm.js —— 猫咪表单公共方法（addCat / editCat 共用）
 * ============================================================
 * 【作用】两份几乎相同的猫咪表单逻辑收敛到这里：
 *    1. pickers         —— 下拉框选项（毛色/性别/绝育/状况/性格等）
 *    2. nickname(cat)   —— 自动生成搜索关键词
 *    3. buildDoc(cat)   —— 入库字段构建（addCat 用 insertOne，editCat 用 $set）
 *    4. initPickerSelected(cat, pickers) —— 编辑页回填下拉框选中下标
 *    5. normalizeTextFields(cat) —— 文本字段兜底归一化（防对象/数组脏数据）
 * ============================================================
 */
const guard = require('./guard.js'); // 文本字段写库兜底（toText）

// 下拉框选项（addCat / editCat 共用，字段名必须与 wxml 绑定一致）
const pickers = {
  classification: ['狸花', '橘猫及橘白', '奶牛', '玳瑁及三花', '纯色', '雀猫', '简州猫', '其他'],
  gender: ['未知', '公', '母'],
  addPhotoNumber: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18'],
  isSterilization: ['未知', '已绝育', '未绝育'],
  status: ['健康', '送养', '失踪', '离世', '待抓'],
  character: ['未知 数据缺失', '亲人可抱', '亲人不可抱 可摸', '薛定谔亲人', '吃东西时可以一直摸', '吃东西时可以摸一下', '怕人 安全距离 1m 以内', '怕人 安全距离 1m 以外'],
};

/** 自动生成搜索关键词（昵称，由各字段拼成）。
 *  别名 otherName / 曾用名 usedName 也拼进去：搜索"猫哥""黄条子"这类外号
 *  能命中真名猫（肥仔/发福），相关话题跳转、关系搜索同理。 */
function nickname(cat) {
  const parts = [
    cat.name, cat.relatedCats, cat.location, cat.classification,
    cat.isSterilization, cat.appearance, cat.gender, cat.status,
    cat.furColor, cat.character, cat.otherName, cat.usedName,
  ];
  return parts.filter(Boolean).join(' ');
}

/**
 * 构建写入 BITZH 集合的猫咪文档（addCat / editCat 共用的完整字段清单）
 * @param {Object} cat 页面上的 cat 对象
 * @param {Number} addPhotoNumber 照片数（= 图片张数 - 1，已在外层钳制 ≥0）
 */
function buildDoc(cat, addPhotoNumber) {
  const doc = {
    name: cat.name,
    otherName: cat.otherName,       // 别名 / 外号（多个用空格或逗号分隔）
    usedName: cat.usedName,         // 曾用名（多个用空格或逗号分隔）
    addPhotoNumber: addPhotoNumber,
    nickname: cat.nickname || nickname(cat), // 兜底：确保搜索关键词不为空
    furColor: cat.furColor,
    classification: cat.classification,
    gender: cat.gender,
    status: cat.status,
    isSterilization: cat.isSterilization,
    sterilizationTime: cat.sterilizationTime,
    character: cat.character,
    firstSightingTime: cat.firstSightingTime,
    firstSightingLocation: cat.firstSightingLocation,
    appearance: cat.appearance,
    namereason: cat.namereason,
    moreInformation: cat.moreInformation,
    missingTime: cat.missingTime,
    relationship: cat.relationship,
    deliveryTime: cat.deliveryTime,
    deathTime: cat.deathTime,
    deathReason: cat.deathReason,
    location: cat.location,
    birthTime: cat.birthTime,
    relatedCats: cat.relatedCats,
    lastEditTime: new Date(), // 用 Date 对象，保证按时间排序正确
    lastEditAdministrator: getApp().globalData.Administrator,
  };
  // 写库前兜底：历史脏数据/异常路径可能把文本字段带成对象
  // （典型：moreInformation 显示 [object Object]）。统一转成字符串，
  // 让应用路径再也写不进对象，避免再次污染数据库。
  return normalizeTextFields(doc);
}

/** 根据猫咪当前值计算出每个下拉框应该显示的下标（编辑页回填用） */
function initPickerSelected(cat, pickerOptions) {
  const picker_selected = {};
  Object.keys(pickerOptions).forEach((key) => {
    const idx = pickerOptions[key].findIndex((v) => v === cat[key]);
    picker_selected[key] = idx;
  });
  return picker_selected;
}

/**
 * 文本字段兜底归一化：历史脏数据里个别字段可能被存成对象/数组
 * （典型表现：编辑页"更多"输入框显示 [object Object]，或存成
 * [{context,date}] 这种结构化笔记）。加载/写库时统一转成字符串：
 *   1. 笔记式结构（每项含 context/text/content）→ 提取纯文本（丢掉 date 等元数据）
 *   2. 其它对象/数组 → JSON 字符串兜底
 * 用户保存时即可把脏数据修正回纯字符串。缺省（undefined/null）字段保持原样。
 * 具体转换逻辑见 guard.toText（文本字段写库兜底）。
 * @param {Object} cat 猫咪记录（读库时是原始记录，写库时是 buildDoc 结果）
 * @returns {Object} 归一化后的副本（不影响原对象）
 */
function normalizeTextFields(cat) {
  const fields = [
    'name', 'otherName', 'usedName', 'appearance', 'furColor', 'classification', 'gender', 'status',
    'isSterilization', 'sterilizationTime', 'location', 'birthTime', 'character',
    'firstSightingTime', 'firstSightingLocation', 'missingTime', 'deliveryTime',
    'deathTime', 'deathReason', 'namereason', 'moreInformation', 'relationship',
  ];
  const out = Object.assign({}, cat || {});
  fields.forEach(function (f) {
    out[f] = guard.toText(out[f]);
  });
  return out;
}

// ============ 话题 → 猫 匹配（catDetail / bookletDetail 共用） ============
// 别名/曾用名可能是"空格、逗号、斜杠、顿号、竖线、括号…"任意分隔的多段值
// （如 "肥猪/饭桶"、"猫哥 小奶猫"），而老猫的 nickname 是改版前生成的、不含别名。
// 所以匹配不能依赖 $in 精确值或 nickname 里的独立词，而要直接对
// 真实名/别名/曾用名/昵称四个字段做"独立词"正则匹配（不管分隔符是什么）。
// 边界集：空白（含全角空格）、斜杠/反斜杠、井号/全角井号、逗号分号顿号竖线、
// 各类括号、波浪线、中圆点、连字符、下划线。保证 "肥猪" 命中 "肥猪/饭桶"、
// "猫哥 小奶猫"，但不误匹配 "肥猪头"。
const ALIAS_BOUNDARY = '[\\s/\\\\#＃，,；;、|()\\[\\]{}<>~·\\-_.]';
function aliasTokenRegex(name) {
  return '(^|' + ALIAS_BOUNDARY + ')' + guard.escapeRegExp(String(name == null ? '' : name)) + '(' + ALIAS_BOUNDARY + '|$)';
}

/** 一串"可被叫的名字"（真实名+别名+曾用名+昵称拼串）里是否包含该话题作为独立词 */
function aliasContains(stack, name) {
  try {
    return new RegExp(aliasTokenRegex(name), 'i').test(String(stack == null ? '' : stack));
  } catch (e) {
    return false;
  }
}

/** 话题数组 → 查询条件：真实名/别名/曾用名/昵称 任一字段含该话题独立词。
 *  返回 null 表示无条件（调用方按无过滤处理）。 */
function topicCatFilter(topics) {
  const list = (topics || []).filter(Boolean);
  if (!list.length) return null;
  const ors = [];
  list.forEach(function (t) {
    const re = aliasTokenRegex(t);
    ors.push(
      { name: { $regex: re, $options: 'i' } },
      { otherName: { $regex: re, $options: 'i' } },
      { usedName: { $regex: re, $options: 'i' } },
      { nickname: { $regex: re, $options: 'i' } }
    );
  });
  return { $or: ors };
}

module.exports = {
  pickers: pickers,
  nickname: nickname,
  buildDoc: buildDoc,
  initPickerSelected: initPickerSelected,
  normalizeTextFields: normalizeTextFields,
  aliasTokenRegex: aliasTokenRegex,
  aliasContains: aliasContains,
  topicCatFilter: topicCatFilter,
};
