// ============================================================
// utils/util.js —— 通用工具函数
// ============================================================
// 【作用】时间格式化、数字补齐等基础工具。
//         formatTime 兼容 Date 对象与时间字符串（iOS 需 T 分隔），
//         多处复用（trash.js / editCat / addCat / catTrash / logs）。
// ============================================================

/**
 * 格式化时间：YYYY-MM-DD HH:mm
 * 兼容 Date 对象、ISO 字符串、普通时间字符串（空格分隔）
 * @param {Date|String|*} t 日期；null/undefined/invalid 返回 ''
 * @returns {String} 'YYYY-MM-DD HH:mm' 或 ''
 */
const formatTime = (t) => {
  if (t == null) return ''; // null/undefined 返回空；0 / false / '' 继续走 Date 解析
  const d = t instanceof Date ? t : new Date(String(t).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};

/**
 * 数字补齐两位
 * @param {Number|String} n
 * @returns {String} '01' ~ '99'
 */
const formatNumber = (n) => {
  n = n.toString();
  return n[1] ? n : '0' + n;
};

module.exports = {
  formatTime: formatTime,
  formatNumber: formatNumber,
};
