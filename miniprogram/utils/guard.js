// ============================================================
// utils/guard.js —— 前端"保险"工具（纯 JS，不依赖云函数）
// ============================================================
// 【作用】开源教学项目在无法使用云函数的情况下，用前端手段
//        尽量降低"被瞎搞/被误操作"的风险。注意：前端校验只能
//        防住正常用户和普通误操作，无法对抗恶意逆向攻击，
//        这只是一个"保险"层，不是安全边界。
//        包含：
//        1. escapeRegExp    —— 正则转义（防止 $regex 注入/查询报错）
//        2. sanitizeFileName —— 文件名清洗（防止 COS 路径键注入）
//        3. 文本校验         —— 长度/必填/非法字符
//        4. throttle         —— 防连点（同一操作间隔限频）
//        5. rateLimit        —— 滑动窗口限频（内存级）
// ============================================================

// ---------- 1. 正则转义 ----------
// 把字符串中的正则元字符转义成字面量，防止拼接进 $regex 后：
//   - 输入非法正则导致查询抛错（被 catch 吞掉 → 功能失效）
//   - 输入超长/超复杂正则消耗数据库 CPU（前端保险，降低触发概率）
function escapeRegExp(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- 2. 文件名清洗 ----------
// 用于 COS 对象 Key 和图片 URL 中直接拼接的用户输入（猫名/标题/昵称）。
// 只保留安全字符，去掉：路径分隔符、URL 保留字符、控制字符、
// ".."（路径穿越）、【全部空白】（空格会导致图片 URL/文件名加载失败）、限长。
// 注意：该函数返回的值会同时用作【存储名】和【文件名】，所以
// 提交入库前必须先清洗，保证数据库里的名字 = 安全的文件名。
function sanitizeFileName(name, maxLen) {
  if (typeof name !== 'string') return '';
  const len = (typeof maxLen === 'number' && maxLen > 0) ? maxLen : 60;
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    // 跳过控制字符（0x00-0x1F、0x7F）与所有空白字符
    if (code <= 0x1f || code === 0x7f || /\s/.test(name.charAt(i))) continue;
    const ch = name.charAt(i);
    // 跳过路径分隔符与 URL 保留字符
    if ('\\/:*?"<>|#%&'.indexOf(ch) >= 0) continue;
    out += ch;
  }
  // 去掉 ".." 路径穿越、去首尾空白、限长
  return out.replace(/\.\.+/g, '').trim().slice(0, len);
}

// ---------- 3. 文本校验 ----------
function isEmpty(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

// ---------- 3.5 文本字段写库兜底 ----------
// 把任意值转成适合存"文本字段"的字符串，防止脏数据把对象/数组存进文本字段
// （典型表现：显示成 [object Object]，或存成 [{context,date}] 这种结构化笔记）：
//   1. 笔记式结构（数组/对象，每项含 context/text/content）→ 提取可读文本，多项换行连接
//   2. 其它对象/数组 → JSON.stringify 兜底（保留全部内容，不再 [object Object]）
//   3. 字符串 / 数字 / 布尔 → 转字符串原样
//   4. undefined / null → 原样返回（缺省字段不强行补值）
// 注意：只用于【文本用途】字段；数字/日期/布尔等有语义类型的字段不要传进来。
function toText(value) {
  if (value === undefined || value === null || typeof value === 'string') return value;
  // NaN 的 typeof 也是 'number'，但 String(NaN) → "NaN" 会写入脏数据，先拦截
  if (typeof value === 'number') return isNaN(value) ? '' : String(value);
  if (typeof value === 'boolean') return String(value);
  // 对象/数组：先尝试提取可读文本，失败再 JSON 兜底
  const items = Array.isArray(value) ? value : [value];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (typeof it === 'string') { out.push(it); continue; }
    // 跳过 null/undefined，但 0 / false / '' 都是合法值，不能短路
    if (it == null || typeof it !== 'object') return JSON.stringify(value);
    let text = null;
    ['context', 'text', 'content'].forEach(function (k) {
      // 空字符串也是合法文本，不能因为 falsy 跳过
      if (text === null && typeof it[k] === 'string') text = it[k];
    });
    if (text === null) return JSON.stringify(value);
    out.push(text);
  }
  return out.join('\n');
}

// 长度上限校验（中文按字符数算）
function tooLong(value, max) {
  return typeof value === 'string' && value.length > max;
}

// 是否包含控制字符（0x00-0x1F、0x7F）
function hasControlChar(value) {
  if (typeof value !== 'string') return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// ---------- 4. 防连点（间隔限频） ----------
// 同一标签的两次调用至少间隔 intervalMs 毫秒，防止快速双击重复提交。
// 被拦截时自动弹出提示（含等待秒数）；传 silent=true 可跳过提示。
const _lastCall = {};
function throttle(label, intervalMs, silent) {
  const now = Date.now();
  const interval = (typeof intervalMs === 'number' && intervalMs > 0) ? intervalMs : 2000;
  const last = _lastCall[label] || 0;
  if (now - last < interval) {
    if (!silent) wx.showToast({ icon: 'none', title: '操作太频繁，请' + Math.ceil(interval / 1000) + '秒后重试' });
    return false;
  }
  _lastCall[label] = now;
  return true;
}

// 清除某标签的限频时间戳。
// 用于"校验失败/提交失败后允许立即重试"：这些失败路径本身没有真正提交，
// 不该消耗限频窗口，调用方 resetThrottle(label) 后用户改完即可立即重提。
function resetThrottle(label) {
  delete _lastCall[label];
}

// ---------- 5. 滑动窗口限频（内存级） ----------
// 同一标签在 windowMs 内最多执行 max 次。内存级、小程序重开后清零，
// 属于"保险"性质，无法对抗清缓存/重启绕过。
// 被拦截时自动弹出提示；传 silent=true 可跳过提示。
const _hits = {};
function rateLimit(label, windowMs, max, silent) {
  const now = Date.now();
  const win = (typeof windowMs === 'number' && windowMs > 0) ? windowMs : 60000;
  const cap = (typeof max === 'number' && max > 0) ? max : 20;
  const arr = (_hits[label] = _hits[label] || []).filter(function (t) {
    return now - t < win;
  });
  _hits[label] = arr;
  if (arr.length >= cap) {
    if (!silent) wx.showToast({ icon: 'none', title: '操作太频繁，请稍后重试' });
    return false;
  }
  arr.push(now);
  return true;
}

// ---------- 6. 权限守卫（管理员） ----------
// 调用前先 await db.initUserState()，再调用本函数；
// 无权限时自动提示并返回上一页，返回 false 供调用方提前 return。
function requireAdmin() {
  if (getApp().globalData.isAdministrator) return true;
  wx.showToast({ title: '无权访问', icon: 'none' });
  setTimeout(() => wx.navigateBack(), 800);
  return false;
}

// ---------- 7. 今天的日期（YYYY-MM-DD） ----------
// 用于推文"拍摄时间"等字段为空时补默认值，保证排序字段不缺值。
function todayString() {
  const d = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + pad(m) + '-' + pad(day);
}

// ---------- 7.5 日期钳制（拍摄时间等） ----------
// 把日期字符串钳制到合法范围：空值 / 非法格式 / 未来日期 → 今天。
// 依赖 YYYY-MM-DD 的 ISO 格式做字符串比较（与 todayString() 同格式）。
// 用于防止"拍摄时间设置为明年"这类未来日期污染数据（pick 控件已限制，
// 这里是写库前的兜底）。
function clampDate(value) {
  const s = String(value == null ? '' : value).trim();
  const today = todayString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return today;
  return s <= today ? s : today;
}

module.exports = {
  escapeRegExp: escapeRegExp,
  sanitizeFileName: sanitizeFileName,
  isEmpty: isEmpty,
  toText: toText,
  tooLong: tooLong,
  hasControlChar: hasControlChar,
  throttle: throttle,
  resetThrottle: resetThrottle,
  rateLimit: rateLimit,
  requireAdmin: requireAdmin,
  todayString: todayString,
  clampDate: clampDate,
};
