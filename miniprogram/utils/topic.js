/**
 * utils/topic.js —— 话题（推文标签）公共方法
 * ============================================================
 * 【背景】Page 集合的 relative 字段历史数据非常脏，混存多种格式：
 *   "#肥仔#水晶"（连续# 无空格）、"＃小梅"（全角#）、"笨鸭"（无#）、
 *   "笨笨，小鸭"（逗号分隔）、"#小白 #宝宝辅食"（标准格式）……
 *   本模块统一负责"解析 / 构建 / 正则匹配"，让所有页面（bookletDetail、
 *   catDetail、someBooklet、index、topic-editor 组件）共享一套逻辑：
 *   1. parse(relative)  —— 把任意脏串解析成去重后的话题数组
 *   2. build(topics)    —— 把话题数组拼成规范存储串 "#话题 #话题"（新数据统一此格式）
 *   3. tokenRegex(name) —— 生成"作为独立话题出现"的匹配正则片段（防"海参"误伤"小海参"）
 *   4. tagRegex(tokens) —— 多个关键词模糊匹配（搜索框用，match 尽可能多）
 * ============================================================
 */
const guard = require('./guard.js');

/**
 * 解析话题串 → 去重后的话题数组。
 * 分隔符：半角/全角井号 #＃、各种空白（含全角空格）、半角/全角逗号分号顿号竖线。
 * 连续多个分隔符、首尾分隔符都安全；空串/纯分隔符返回 []。
 * @param {String} relative 推文的 relative 原始值（可能为 undefined/null/脏格式）
 * @returns {String[]} 去重后的话题列表
 */
function parse(relative) {
  if (relative === undefined || relative === null) return [];
  const str = String(relative);
  if (!str.trim()) return [];
  const seen = {};
  const out = [];
  str.split(/[#＃\s　，,；;、|]+/).forEach(function (part) {
    const t = String(part).trim();
    if (!t) return;                     // 跳过空片段
    if (seen[t]) return;                // 去重（保留首次出现顺序）
    seen[t] = true;
    out.push(t);
  });
  return out;
}

/**
 * 把话题数组构建成规范存储串："#话题 #话题"（每个话题带 #、空格分隔）。
 * 新发布的推文统一用这个格式写库，保证 catDetail / someBooklet 的
 * 词边界正则能稳定命中；旧脏数据不用迁移，解析时天然兼容。
 * @param {Array} topics 话题数组（元素会被 trim；空串/重复会被过滤）
 * @returns {String} 规范串；无话题返回 ''
 */
function build(topics) {
  if (!Array.isArray(topics)) return '';
  const seen = {};
  const out = [];
  topics.forEach(function (t) {
    const s = String(t == null ? '' : t).trim();
    if (!s) return;
    if (seen[s]) return;
    seen[s] = true;
    out.push('#' + s);
  });
  return out.join(' ');
}

/**
 * 生成"话题作为独立标签出现"的匹配正则片段。
 * 用在 DB $regex：`{ relative: { $regex: tokenRegex(name), $options: 'i' } }`。
 * 前后必须是"字符串边界 / 空白 / 井号 / 全角井号 / 逗号分号顿号竖线"，
 * 避免 "海参" 误匹配 "小海参" 的推文；同时兼容老数据里 `#肥仔#水晶`（无空格）
 * 和 `笨笨，小鸭`（逗号分隔）这类脏格式。
 * @param {String} name 话题名（会先转义正则元字符）
 * @returns {String} 正则片段（可直接拼进 $regex）
 */
function tokenRegex(name) {
  return '(^|[\\s#＃，,；;、|])' + guard.escapeRegExp(String(name == null ? '' : name)) + '([\\s#＃，,；;、|]|$)';
}

/**
 * 生成多个关键词的模糊匹配过滤条件（搜索框用）。
 * 每个词按"包含"匹配（match 尽量多），词间 $and；匹配对象是 relative 或 tittle。
 * 注意：这是**搜索**语义（允许子串误命中），与 catDetail 关联用的
 * tokenRegex（独立话题精确匹配）不同，两者不要混用。
 * @param {Array} tokens 关键词数组
 * @returns {Object} DB filter；tokens 为空返回 null（调用方按无过滤处理）
 */
function tagFilter(tokens) {
  const list = (tokens || []).map(function (t) { return String(t).trim(); }).filter(Boolean);
  if (!list.length) return null;
  const conds = list.map(function (t) {
    const re = guard.escapeRegExp(t);
    return { $or: [
      { relative: { $regex: re, $options: 'i' } },
      { tittle: { $regex: re, $options: 'i' } },
    ] };
  });
  return { $and: conds };
}

module.exports = {
  parse: parse,
  build: build,
  tokenRegex: tokenRegex,
  tagFilter: tagFilter,
};
