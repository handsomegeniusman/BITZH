/**
 * utils/photoTime.js —— 上传图片自动识别「拍摄时间」三层兜底 + 多图多数聚合
 * ============================================================
 * 【作用】给 addBooklet / editBooklet / addOfficial 的 photoTime 字段自动识别：
 *        第1层 EXIF（读 JPEG 字节，仅本地临时文件）→
 *        第2层 文件名时间戳（仅「从聊天选择」入口有原始文件名）→
 *        第2.5层 聊天发送时间（wx.chooseMessageFile 的 time 字段）→
 *        第3层 文件修改时间（低置信度：临时文件 mtime≈选图时刻，非拍摄时刻）。
 *        多图：加权聚合——封面（列表第一张）日期权重 1.5、其余照片权重 1.0，
 *              按加权总分取最高日期，总分并列优先封面；新增/删除/切换封面都会实时重算。
 *        相册强制原图（sizeType:['original']）→ EXIF 必有；识别出日期后立即用
 *        wx.compressImage 压成小图换回列表（recognizeAndCompress）→ 上传体积仍小。
 * 【可测性】顶层只依赖 ./exif.js（纯函数），wx / imgEditor / draft 均在
 *        识别函数体内懒 require —— Node 里可直接 require 本模块测纯函数。
 * ============================================================
 */
const exif = require('./exif.js');

const MIN_DATE = '2015-01-01';        // 与拍摄时间 picker 的 start 下限一致，越界不写
const EXIF_MAX_SIZE = 20 * 1024 * 1024; // 超 20MB 不读 EXIF（防内存峰值）
const PARTIAL_LEN = 512 * 1024;       // 局部读取前 512KB（EXIF APP1 在文件头）
const POOL_LIMIT = 3;                 // 并发识别上限（防一次多张低端机 OOM）

/** 补零 */
function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** Date → 'YYYY-MM-DD' */
function fmtDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 今天（YYYY-MM-DD） */
function todayStr() {
  return fmtDate(new Date());
}

/** 日期合法性：年 2010-2100，月 1-12，日按当月天数（含闰年） */
function isValidYMD(y, m, d) {
  if (!(y >= 2010 && y <= 2100)) return false;
  if (!(m >= 1 && m <= 12)) return false;
  if (!(d >= 1 && d <= 31)) return false;
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let max = days[m - 1];
  if (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) max = 29;
  return d <= max;
}

/** 是否为合法 'YYYY-MM-DD' 日期串 */
function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  return isValidYMD(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10));
}

/**
 * 第 2 层：从原始文件名解析日期（仅聊天入口有 name；按优先级匹配）。
 * @param {String} name 原始文件名（如 mmexport1712345678.jpg / IMG_20230901_110711.jpg）
 * @returns {String|null} 'YYYY-MM-DD' 或 null
 */
// 正则按优先级排列：mmexport epoch → 相机/微信相机/截图 → 通用 YYYYMMDD / YYYY-MM-DD
// 通用格式用 (?![0-9]) + 合法性校验防误吞 8 位以上的数字串（如 epoch）。
var NAME_PATTERNS = [
  { re: /(?:^|[\\/_])mmexport(\d{10}|\d{13})/, type: 'epoch' },       // 微信聊天保存图
  { re: /(?:^|[\\/_])(?:IMG|PXL|VID)_(\d{4})(\d{2})(\d{2})_(\d{6})/, type: 'ymd' }, // iPhone/安卓相机/Pixel
  { re: /(?:^|[\\/_])wx_camera_(\d{4})(\d{2})(\d{2})/, type: 'ymd' }, // 微信相机（安卓）
  { re: /(?:^|[\\/_])Screenshot_(\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})/, type: 'ymd' }, // 安卓截图
  { re: /(?:^|[\\/_])Screenshot_(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/, type: 'ymd' },
  { re: /(?:^|[\\/_])(\d{4})(\d{2})(\d{2})(?![0-9])/, type: 'ymd' },   // 通用 YYYYMMDD（锚定路径/下划线）
  { re: /(?:^|[\\/_])(\d{4})-(\d{2})-(\d{2})(?![0-9])/, type: 'ymd' }, // 通用 YYYY-MM-DD
];

function parseDateFromName(name) {
  if (typeof name !== 'string' || !name) return null;
  // 只取文件名，去掉目录（防路径里的目录名带数字误命中）
  const base = name.replace(/\\/g, '/').split('/').pop() || '';
  for (let i = 0; i < NAME_PATTERNS.length; i++) {
    const p = NAME_PATTERNS[i];
    const m = p.re.exec(base);
    if (!m) continue;
    if (p.type === 'epoch') {
      let v = Number(m[1]);
      if (v > 1e12) v = Math.floor(v / 1000); // 13 位毫秒 → 秒
      if (!(v > 0 && v <= 4e11)) continue;    // 时间戳合理范围
      const d = new Date(v * 1000);
      if (isNaN(d.getTime())) continue;
      if (d.getFullYear() < 2010 || d.getFullYear() > 2100) continue;
      return fmtDate(d);
    }
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (isValidYMD(y, mo, d)) return m[1] + '-' + m[2] + '-' + m[3];
  }
  return null;
}

/**
 * 第 2.5 层：从 Unix 时间戳（秒/毫秒均可）取日期。
 * @param {Number|String} time 时间戳
 * @returns {String|null} 'YYYY-MM-DD' 或 null
 */
function parseTimeField(time) {
  let v = Number(time);
  if (!isFinite(v) || v <= 0) return null;
  if (v > 1e12) v = Math.floor(v / 1000); // 防御毫秒
  const d = new Date(v * 1000);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() < 2010 || d.getFullYear() > 2100) return null;
  return fmtDate(d);
}

/**
 * 多图聚合：简单多数，并列第一取封面；封面识别不出 → null（不动）。
 * @param {Array<String|null>} dates 按当前列表顺序的每张图日期
 * @param {String|null} coverDate 封面（列表第一张）图的日期
 * @returns {String|null} 'YYYY-MM-DD' 或 null
 */
function aggregatePhotoDate(dates, coverDate) {
  const counted = (dates || []).filter(isValidDateStr);
  if (!counted.length) return null;
  const tally = {};
  for (let i = 0; i < counted.length; i++) {
    tally[counted[i]] = (tally[counted[i]] || 0) + 1;
  }
  const keys = Object.keys(tally);
  let best = null;
  let bestCount = 0;
  for (let i = 0; i < keys.length; i++) {
    if (tally[keys[i]] > bestCount) {
      bestCount = tally[keys[i]];
      best = keys[i];
    }
  }
  // 并列第一 → 封面日期上榜才采用，否则保持原值
  let ties = 0;
  for (let i = 0; i < keys.length; i++) {
    if (tally[keys[i]] === bestCount) ties++;
  }
  if (ties > 1) {
    return (isValidDateStr(coverDate) && tally[coverDate] === bestCount) ? coverDate : null;
  }
  return best;
}

/**
 * 多图聚合（加权取最高，替代旧「封面为主 / 简单多数」）：
 *   封面（列表第一张，dates[0]）的日期权重 1.5，其余照片权重 1.0，
 *   同一日期按权重累加，取加权总分最高者；总分并列时优先封面日期（封面上榜才采用）。
 *   —— 封面是"强一票"而非绝对一票：绝大多数普通日期靠数量也能反超封面，
 *      但封面在与别日并列时占优（符合"封面对拍摄时间的代表性"语义）。
 * @param {Array<String|null>} dates 按当前列表顺序的每张图日期（dates[0] = 封面）
 * @returns {String|null} 'YYYY-MM-DD' 或 null
 */
function weightedPhotoDate(dates) {
  const sum = {};
  const list = dates || [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (!isValidDateStr(d)) continue;
    const w = (i === 0) ? 1.5 : 1.0; // 封面权重 1.5，其余 1.0
    sum[d] = (sum[d] || 0) + w;
  }
  const keys = Object.keys(sum);
  if (!keys.length) return null;
  let best = null;
  let bestW = 0;
  for (let i = 0; i < keys.length; i++) {
    if (sum[keys[i]] > bestW) {
      bestW = sum[keys[i]];
      best = keys[i];
    }
  }
  // 总分并列 → 封面日期在并列项中才优先采用，否则取先遇到的最高者（稳定）
  const cover = list.length ? list[0] : null;
  if (isValidDateStr(cover) && sum[cover] === bestW) return cover;
  return best;
}

// ============================================================
// 文件读取（微信 API 层，均在识别函数体内使用）
// ============================================================

function getFs() {
  return wx.getFileSystemManager();
}

/**
 * stat 文件信息；兼容不同基础库/平台的属性名差异。
 * @returns {Promise<{size:Number, mtime:Number|null}|null>}
 */
function statInfo(path) {
  return new Promise(function (resolve) {
    try {
      getFs().stat({
        path: path,
        success: function (res) {
          const st = res && res.stats;
          if (!st) return resolve(null);
          const mtime = st.lastModifiedTime != null ? st.lastModifiedTime
            : (st.mtime != null ? st.mtime : st.modifyTime);
          resolve({
            size: typeof st.size === 'number' ? st.size : -1,
            mtime: mtime != null ? mtime : null,
          });
        },
        fail: function () { resolve(null); },
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * 读文件字节为 ArrayBuffer。优先局部读前 PARTIAL_LEN（EXIF 在文件头），
 * 失败降级全量读（超 EXIF_MAX_SIZE 放弃）。
 * 返回值类型防御：工具/真机可能给 ArrayBuffer / Uint8Array / 其它，非字节类型直接跳过。
 */
function readFileBuf(path, size) {
  return new Promise(function (resolve) {
    const fs = getFs();
    const ok = function (data) {
      if (data instanceof ArrayBuffer) return resolve(data);
      if (data instanceof Uint8Array) return resolve(data.buffer);
      if (data && data.buffer instanceof ArrayBuffer) return resolve(data.buffer);
      resolve(null); // 其它类型（如被解码的字符串/像素数据）跳过
    };
    try {
      fs.readFile({
        filePath: path,
        position: 0,
        length: PARTIAL_LEN,
        success: function (res) { ok(res && res.data); },
        fail: function () {
          // position/length 部分机型不支持 → 全量读兜底
          if (size != null && size > EXIF_MAX_SIZE) return resolve(null);
          try {
            fs.readFile({
              filePath: path,
              success: function (res2) { ok(res2 && res2.data); },
              fail: function () { resolve(null); },
            });
          } catch (e) {
            resolve(null);
          }
        },
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/** 第 3 层：文件修改时间（低置信度兜底，语义≈选图时刻） */
function finishByMtime(info, done) {
  if (info && info.mtime != null) {
    const d = parseTimeField(info.mtime);
    if (d) return done(d, 'mtime');
  }
  return done(null, '');
}

/**
 * 单张图三层识别。
 * @param {Object|String} item 图片项：{tempFilePath|path, name?, time?} 或路径字符串
 * @returns {Promise<{date:String|null, source:String}>} source: exif|name|time|mtime|''
 */
function identifyOne(item) {
  return new Promise(function (resolve) {
    const path = item && (item.tempFilePath || item.path || (typeof item === 'string' ? item : ''));
    if (!path) {
      resolve({ date: null, source: '' });
      return;
    }
    const isLocal = path.indexOf('wxfile://') === 0 || path.indexOf('http://tmp') === 0;
    const done = function (date, source) {
      resolve({ date: date || null, source: source || '' });
    };

    // 非本地（COS/草稿 URL）：只有文件名 / 发送时间可读
    if (!isLocal) {
      const dn = parseDateFromName(item.name);
      if (dn) return done(dn, 'name');
      const dt = parseTimeField(item.time);
      return done(dt, dt ? 'time' : '');
    }

    // ---- 本地文件：EXIF → 文件名 → 发送时间 → mtime ----
    statInfo(path).then(function (info) {
      if (info && info.size >= 0 && info.size <= EXIF_MAX_SIZE) {
        readFileBuf(path, info.size).then(function (buf) {
          if (buf) {
            const u8 = new Uint8Array(buf);
            // 非 JPEG（HEIC/PNG/WebP 等）入口直接跳过，不做任何解析
            if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xD8) {
              const d = exif.extractPhotoDate(u8);
              if (d) return done(d, 'exif');
            }
          }
          layerFilename(info); // 复用第一次 stat（避免同一张图再 stat 一次）
        }, function () { layerFilename(info); });
      } else {
        layerFilename(info); // stat 失败 / 超大文件 → 跳过 EXIF
      }
    }, function () { layerFilename(null); });

    function layerFilename(info) {
      const d2 = parseDateFromName(item.name);
      if (d2) return done(d2, 'name');
      const d25 = parseTimeField(item.time);
      if (d25) return done(d25, 'time');
      // 第 3 层 mtime（低置信度兜底）；首次 stat 已成功则直接复用，未成功再补查
      if (info && info.mtime != null) return finishByMtime(info, done);
      statInfo(path).then(function (info2) {
        finishByMtime(info2, done);
      }, function () { done(null, ''); });
    }
  });
}

/** 并发池：最多 limit 个同时跑，结果按下标对齐返回（不依赖完成顺序） */
function runPool(items, worker, limit) {
  return new Promise(function (resolve) {
    const len = items.length;
    const results = new Array(len);
    if (!len) { resolve(results); return; }
    let next = 0;
    let doneCount = 0;
    const pool = Math.min(limit || POOL_LIMIT, len);
    const tick = function () {
      if (next >= len) return;
      const i = next++;
      Promise.resolve().then(function () {
        return worker(items[i]);
      }).then(function (r) {
        results[i] = r;
      }, function () {
        results[i] = null;
      }).then(function () {
        doneCount++;
        if (doneCount === len) resolve(results);
        else tick();
      });
    };
    for (let k = 0; k < pool; k++) tick();
  });
}

/** 批量识别（并发 ≤ POOL_LIMIT，读完即释放引用，防内存峰值） */
function identifyAll(items) {
  return runPool(items, identifyOne, POOL_LIMIT);
}

// ============================================================
// 页面接入
// ============================================================

/**
 * 覆盖规则：用户手动选过 → 永不覆盖；否则 空 / 仍是默认今天 / 之前自动填写的值 → 可覆盖。
 * （自动填写的值可被后续批次重算，保证"多图多数为准"跨批次成立）
 */
function canOverwrite(page) {
  if (page._photoTimeTouched) return false;
  const cur = page.data.listData && page.data.listData.photoTime;
  if (!cur) return true;
  if (page._photoTimeAutoFilled) return true;
  return cur === todayStr();
}

/**
 * 页面接入总入口：缓存识别结果 → 多图聚合 → 按覆盖规则写 photoTime（高置信度轻提示，mtime 静默）。
 * @param {Page} page 页面实例（addBooklet/editBooklet/addOfficial）
 * @param {Array} items 刚加入的图片项（{tempFilePath, name?, time?}）
 * @returns {Promise<void>}
 */
function recognizeAndFill(page, items) {
  if (!page || page._photoUnloaded) return Promise.resolve();
  const imgEditor = require('./imgEditor.js'); // 懒加载：顶层保持 Node 可测

  const cache = page._photoTimes = page._photoTimes || {};
  const newItems = [];
  for (let i = 0; i < (items || []).length; i++) {
    const it = items[i];
    const p = imgEditor.srcOf(it);
    if (p && cache[p] === undefined) newItems.push(it); // 已识别过的不重跑
  }

  const chain = newItems.length
    ? identifyAll(newItems).then(function (results) {
        for (let j = 0; j < newItems.length; j++) {
          cache[imgEditor.srcOf(newItems[j])] = results[j];
        }
      })
    : Promise.resolve();

  return chain.then(function () {
    if (!page || page._photoUnloaded) return; // 页面已销毁，不再 setData
    const list = imgEditor.listOf(page);
    const entries = list.map(function (it) {
      const p = imgEditor.srcOf(it);
      const e = p && cache[p];
      return e && e.date ? { date: e.date, source: e.source || '' } : { date: null, source: '' };
    });
    return applyAggregation(page, entries);
  });
}

/**
 * 按覆盖规则写 photoTime（加权聚合）：封面（列表第一张）日期权重 1.5、其余 1.0，
 * 按加权总分取最高日期（并列优先封面）；被手动改过 / 越界 / 值没变时不打扰。
 */
function applyAggregation(page, entries) {
  const dates = entries.map(function (e) { return e.date; });
  const agg = weightedPhotoDate(dates); // 封面 = dates[0]，权重 1.5；其余 1.0
  if (!agg) return;
  if (!canOverwrite(page)) return;
  // 范围校验：必须落在 picker [2015-01-01, 今天] 内，防越界显示异常
  const today = todayStr();
  if (agg < MIN_DATE || agg > today) return;
  const cur = page.data.listData && page.data.listData.photoTime;
  if (agg === cur) return; // 值没变：不重复 setData / toast（拖无关图、封面没换时不打扰）
  // 低置信度：胜出日期的来源全是 mtime（文件修改时间≈选图时刻，非拍摄时间）→ 静默，不打扰
  const winnerSources = entries
    .filter(function (e) { return e.date === agg; })
    .map(function (e) { return e.source; });
  const lowConfidence = winnerSources.length > 0 &&
    winnerSources.every(function (s) { return s === 'mtime'; });
  page.setData({ 'listData.photoTime': agg });
  page._photoTimeAutoFilled = true; // 后续批次可继续重算；手动改过则被 touched 拦截
  const draft = require('./draft.js');
  if (typeof draft.markDirty === 'function') draft.markDirty(page); // 异步写完值，需再触发一次保存
  // 仅高置信度（EXIF/文件名/发送时间）给一次轻提示确认生效；mtime 兜底值用户无需知道，默认改
  if (!lowConfidence) {
    wx.showToast({ title: '已识别拍摄时间：' + agg, icon: 'none', duration: 2500 });
  }
}

/**
 * 图片顺序 / 增删变化后按当前列表 + 缓存重算拍摄时间（实时刷新）：
 * 新增/删除/切换封面后加权聚合立刻生效（不重新读文件，直接用缓存日期）。
 * @param {Page} page 页面实例
 */
function reaggregate(page) {
  if (!page || page._photoUnloaded) return;
  const imgEditor = require('./imgEditor.js');
  const cache = page._photoTimes;
  if (!cache) return;
  const entries = imgEditor.listOf(page).map(function (it) {
    const p = imgEditor.srcOf(it);
    const e = p && cache[p];
    return e && e.date ? { date: e.date, source: e.source || '' } : { date: null, source: '' };
  });
  applyAggregation(page, entries);
}

// ============================================================
// 逐图日期持久化：_photoTimes 只活在内存，跨会话（草稿恢复 / 发布后编辑）会丢。
// exportPhotoDates 按列表顺序导出（对齐数据库 photoDates 字段 / 草稿），
// seedPhotoDates 按列表顺序回填（草稿 / 发布记录恢复后重建逐图日期缓存）。
// 键用图片地址（路径可能已被替换成 COS URL），值只存日期（source 重算为 'db'，
// 低置信度静默只影响 toast，不影响加权判定）。
// ============================================================

/** 按列表顺序导出逐图日期数组（与列表一一对应，无识别结果的槽位为 ''）。
 *  @param {Page} page 页面实例（读 _photoTimes）
 *  @param {Array} list 当前图片列表（与最终落库/落盘顺序一致）
 *  @returns {Array<String>} 每张图的日期 'YYYY-MM-DD' 或 '' */
function exportPhotoDates(page, list) {
  const imgEditor = require('./imgEditor.js');
  const cache = page._photoTimes || {};
  return (list || []).map(function (it) {
    const e = cache[imgEditor.srcOf(it)];
    return (e && e.date) || '';
  });
}

/** 把持久化的逐图日期数组按列表顺序回填到 _photoTimes（list 与 dates 一一对应）。
 *  覆盖规则：只填有合法日期的槽位；已存在的识别结果保留（草稿比发布记录新，先 seed 后
 *  草稿 restore 会整体替换，见 draft.restore）。
 *  @param {Page} page 页面实例
 *  @param {Array} list 当前图片列表
 *  @param {Array} dates 持久化的日期数组 */
function seedPhotoDates(page, list, dates) {
  const imgEditor = require('./imgEditor.js');
  const cache = page._photoTimes = page._photoTimes || {};
  (list || []).forEach(function (it, i) {
    const d = dates && dates[i];
    if (!isValidDateStr(d)) return;
    const p = imgEditor.srcOf(it);
    if (p) cache[p] = { date: d, source: 'db' };
  });
}

// ============================================================
// 相册「原图取日期 + 压缩上传」：识别 EXIF 用的是原图（有 EXIF），
// 但上传/预览/草稿用压缩图（体积小）。压缩后把缓存键也换过去，
// 保证后续批次按当前列表聚合时仍能命中识别结果。
// ============================================================

/** 单张压缩：非本地 / 无 compressImage / 压缩失败 → 返回 null（原图继续，不阻断） */
function compressOne(src) {
  return new Promise(function (resolve) {
    if (!src || (src.indexOf('wxfile://') !== 0 && src.indexOf('http://tmp') !== 0)) {
      resolve(null); // 非本地（COS/草稿 URL）不压
      return;
    }
    if (typeof wx.compressImage !== 'function') {
      resolve(null);
      return;
    }
    wx.compressImage({
      src: src,
      quality: 80,
      success: function (res) {
        if (res && res.tempFilePath && res.tempFilePath !== src) resolve({ from: src, to: res.tempFilePath });
        else resolve(null);
      },
      fail: function () { resolve(null); },
    });
  });
}

/**
 * 把一批图片压缩成小图并换回列表：压缩成功的那几张，列表项从原图路径换成
 * 压缩图路径（对象/字符串格式随 draftImagesAsObjects），并把 _photoTimes 里
 * 原图的识别结果同步挂到压缩图路径上（后续批次聚合才找得到）。
 * @param {Page} page 页面实例
 * @param {Array} items 刚加入的图片项（{tempFilePath,...}）
 * @returns {Promise<void>}
 */
function compressAndSwap(page, items) {
  if (!page || page._photoUnloaded) return Promise.resolve();
  const imgEditor = require('./imgEditor.js'); // 懒加载：顶层保持 Node 可测
  const srcs = (items || []).map(function (it) { return imgEditor.srcOf(it); });
  return runPool(srcs, compressOne, POOL_LIMIT).then(function (results) {
    if (!page || page._photoUnloaded) return;
    const map = {};
    (results || []).forEach(function (r) {
      if (r && r.from && r.to) map[r.from] = r.to;
    });
    const keys = Object.keys(map);
    if (!keys.length) return; // 全部压缩失败/非本地 → 原图继续用
    const asObjects = !!page.data.draftImagesAsObjects;
    const next = imgEditor.listOf(page).map(function (it) {
      const src = imgEditor.srcOf(it);
      const to = map[src];
      if (!to) return it;
      return asObjects ? { tempFilePath: to } : to;
    });
    imgEditor.setList(page, next);
    // 缓存重挂：压缩图路径沿用原图识别结果（识别在压缩前已用原图完成）
    const cache = page._photoTimes;
    if (cache) {
      keys.forEach(function (k) {
        if (cache[k]) cache[map[k]] = cache[k];
      });
    }
    const draft = require('./draft.js');
    if (typeof draft.markDirty === 'function') draft.markDirty(page); // 列表又变了一次 → 再触发保存
  });
}

/**
 * 相册入口专用：先【原图】识别拍摄时间（EXIF 必有），识别完成后再压缩换小图。
 * 识别在压缩前跑，保证缓存里存的是原图路径；compressAndSwap 再把它重挂到压缩图路径。
 * @param {Page} page 页面实例
 * @param {Array} items 刚加入的图片项（{tempFilePath,...}）
 * @returns {Promise<void>}
 */
function recognizeAndCompress(page, items) {
  return recognizeAndFill(page, items).then(function () {
    return compressAndSwap(page, items);
  });
}

module.exports = {
  parseDateFromName: parseDateFromName,
  parseTimeField: parseTimeField,
  aggregatePhotoDate: aggregatePhotoDate,
  weightedPhotoDate: weightedPhotoDate,
  identifyOne: identifyOne,
  identifyAll: identifyAll,
  recognizeAndFill: recognizeAndFill,
  recognizeAndCompress: recognizeAndCompress,
  reaggregate: reaggregate,
  canOverwrite: canOverwrite,
  exportPhotoDates: exportPhotoDates,
  seedPhotoDates: seedPhotoDates,
};
