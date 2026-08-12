/**
 * utils/sort.js —— 排序健壮化 + 卡片时间
 * ============================================================
 * 【背景】历史推文 photoTime 字段很脏：可能缺失、空串、非补零 "2026-8-1"、
 *        ISO 时间戳、甚至 Date 对象；直接把字符串透传给数据库 sort，
 *        脏值的字典序排序不可靠（"2026-1" > "2026-10"、空串/缺字段排最前）。
 *        本模块统一在客户端做"归一化 + 稳定排序 + 时间文案"：
 *        1. 脏日期也能归入正确时间位置（解析不了 → 视为最旧）
 *        2. 分页翻页时顺序稳定不抖（主键并列时按 pageTime 降序 + _id 兜底）
 *        3. 卡片显示"拍摄于/发布于"的时间依据（拍摄时间缺则回退发布时间）
 * 【接入】新首页 index / catDetail / someBooklet 的 getPage 在
 *        db.paginate(...).then 后先 applySort 再 decorateTime。
 *        纯前端计算，不写库、无网络开销。
 * ============================================================
 */

function _pad(n) { return n < 10 ? '0' + n : '' + n; }

/** Date 实例 → { key, text }；非法返回 null */
function _fromDate(d) {
  if (!d || isNaN(d.getTime())) return null;
  return {
    key: d.getTime(),
    text: d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()),
  };
}

/**
 * 归一化任意日期值 → { key:Number(ms), text:'YYYY-MM-DD' }；解析不了返回 null。
 * 兼容：Date 实例 / 毫秒时间戳 / "YYYY-M-D"（非补零）/ "2026/8/1" / ISO / "2026-08-01 12:30"。
 * @param {*} v 脏日期值
 * @returns {{key:Number, text:String}|null}
 */
function normDate(v) {
  if (v instanceof Date) return _fromDate(v);
  if (typeof v === 'number') {
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    if (y < 2000 || y > 2100) return null; // 超出合理范围视为脏值
    return _fromDate(d);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    // 纯日期（允许非补零、/ . 分隔）：2026-8-1 / 2026/8/1 / 2026.8.1
    const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      const dt = new Date(y, mo - 1, d); // 本地时区，避免纯日期被当 UTC 而错一天
      if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) {
        return { key: dt.getTime(), text: _fmtDate(dt) };
      }
      return null; // 2026-13-99 这种假日期
    }
    // 其它可解析格式：ISO / "2026-08-01 12:30" / 时间戳字符串
    const d2 = new Date(s.replace(' ', 'T'));
    return _fromDate(d2);
  }
  return null;
}

/** 本地时间 Date → 'YYYY-MM-DD'（供 normDate 内部使用，避免重复 _fmtDate 引用顺序） */
function _fmtDate(d) { return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()); }

/**
 * 取排序主键：good 按数值（NaN → -Infinity 沉底）；日期字段按 normDate key（无效 → -Infinity）。
 * 说明：-Infinity 在升序时排最前（=最旧）、降序时沉底（=未知），符合直觉。
 */
function _fieldKey(item, field) {
  const v = item && item[field];
  if (field === 'good') {
    const n = parseFloat(v);
    return isNaN(n) ? -Infinity : n;
  }
  const nd = normDate(v);
  return nd ? nd.key : -Infinity;
}

/**
 * 客户端稳定排序（返回新数组，不污染分页合并前的列表）。
 * @param {Array} list  已合并去重的推文列表
 * @param {String} field 排序字段：good / photoTime / pageTime
 * @param {Boolean} desc 是否降序（true=降序，新在前）
 * @returns {Array} 排序后的新列表
 */
function applySort(list, field, desc) {
  const arr = (list || []).slice();
  arr.sort(function (a, b) {
    const ka = _fieldKey(a, field);
    const kb = _fieldKey(b, field);
    if (ka !== kb) return desc ? kb - ka : ka - kb;
    // 主键并列：发布时间降序（新的在前）兜底，保证翻页顺序稳定不抖
    const kpa = normDate(a && a.pageTime);
    const kpb = normDate(b && b.pageTime);
    const pa = kpa ? kpa.key : -Infinity;
    const pb = kpb ? kpb.key : -Infinity;
    if (pa !== pb) return pb - pa;
    // 最后 _id 兜底（String 比较），确保完全稳定
    const ida = String((a && a._id) || '');
    const idb = String((b && b._id) || '');
    if (ida < idb) return -1;
    if (ida > idb) return 1;
    return 0;
  });
  return arr;
}

/**
 * 给列表每项补上展示用时间文案 _timeText：
 *   拍摄时间有效 → "拍摄于 YYYY-MM-DD"；否则回退发布时间 → "发布于 YYYY-MM-DD"；都没有 → ''。
 * @param {Array} list 推文列表（原地补字段）
 * @returns {Array} 原列表
 */
function decorateTime(list) {
  (list || []).forEach(function (item) {
    const pt = item && normDate(item.photoTime);
    if (pt) { item._timeText = '拍摄于 ' + pt.text; return; }
    const pg = item && normDate(item.pageTime);
    if (pg) { item._timeText = '发布于 ' + pg.text; return; }
    item._timeText = '';
  });
  return list;
}

module.exports = {
  normDate: normDate,
  applySort: applySort,
  decorateTime: decorateTime,
};
