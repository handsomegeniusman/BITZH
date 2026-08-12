/**
 * utils/cos.js —— 腾讯云 COS（图片云存储）公共方法
 * ============================================================
 * 【作用】集中管理 COS 的上传 / 删除 / 路径生成，
 *        避免 addCat / editCat / addBooklet / editBooklet / regist
 *        等页面各写一大段重复的上传代码和字符串拼接。
 *
 * 【安全提醒】COS 的固定密钥写在 config.js 里（前端可被反编译看到），
 *        仅供学习 / 小范围使用。生产环境请改用"云函数 + STS 临时密钥"。
 * ============================================================
 */
const config = require('../config.js');

// ============ COS 对象路径 / 访问 URL 生成 ============
// 猫咪照片 / 推文照片 / 用户头像都按"目录 + 名字 + 序号"规则存放，
// 这里集中生成，避免 8+ 个页面各自拼接出错。
const ROOT = config.imageUrl; // 形如 https://.../main/images/

// 上传到 COS 的对象 Key（上传用）
function catJpg(name, i) { return 'main/images/' + name + i + '.jpg'; }
function catThumb(name) { return 'main/images/' + name + '.png'; }
function pageJpg(tittle, i) { return 'main/images/page/' + tittle + i + '.jpg'; }
function profilePng(nickName) { return 'main/images/profile/' + nickName + '.png'; }

// 拼接图片访问 URL（页面展示用，与 this.data.url 同根地址）
// ver 是"照片版本号"（可选）：提交后照片内容变了，微信仍按 URL 缓存旧图，
// 带上 ?v=版本号 让 URL 变新 → 微信重新下载，显示新图。旧猫没存版本号时不带。
function catUrl(name, i, ver) { return ROOT + name + i + '.jpg' + (ver ? '?v=' + ver : ''); }
function catThumbUrl(name, ver) { return ROOT + name + '.png' + (ver ? '?v=' + ver : ''); }
function pageUrl(tittle, i) { return ROOT + 'page/' + tittle + i + '.jpg'; }
function profileUrl(nickName) { return ROOT + 'profile/' + nickName + '.png'; }

let COS_SDK = null;
let COS_CLIENT = null;

// 创建（并复用）COS 客户端实例。
// 默认用 config.cos 固定密钥；config.cos.useSts=true 时改用云函数签发的临时密钥
// （拿不到临时密钥自动回退固定密钥，功能不受影响，见 utils/cosSts.js）
function getCOS() {
  if (!COS_CLIENT) {
    if (!COS_SDK) {
      COS_SDK = require('../pages/cos-wx-sdk-v5.js');
    }
    const cosSts = require('./cosSts.js');
    COS_CLIENT = new COS_SDK(cosSts.buildCosConfig());
  }
  return COS_CLIENT;
}

/**
 * 上传一个本地临时文件到 COS
 * @param {String} Key      上传到 COS 的路径，例如 main/images/小白0.jpg
 * @param {String} FilePath 本地文件路径（wx.chooseMedia 得到的 tempFilePath）
 * @param {Boolean} silent  静默上传：true 时不弹"上传中"遮罩（草稿后台自动上传用，
 *                          不打扰正在编辑的用户）；缺省 false，行为不变
 * @returns {Promise}
 */
function uploadOne(Key, FilePath, silent) {
  return new Promise((resolve, reject) => {
    getCOS().postObject({
      Bucket: config.cos.Bucket,
      Region: config.cos.Region,
      Key: Key,
      FilePath: FilePath,
      onProgress: function () {
        // 显示上传进度（显示一次即可，避免频繁弹窗）；静默上传不弹，避免编辑中闪遮罩
        if (!silent) wx.showLoading({ title: '上传中', mask: true });
      }
    }, function (err, data) {
      if (!silent) wx.hideLoading();
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

/**
 * 把网络图片（http/https 开头的 URL）下载成本地临时文件
 * （COS 在重新上传前必须先下载到本地，否则会报错）
 * @param {String} url 网络图片地址
 * @returns {Promise<String>} 本地临时文件路径
 */
function downloadFile(url) {
  return new Promise(function (resolve, reject) {
    wx.downloadFile({
      url: url,
      success: function (res) {
        if (res.statusCode === 200) {
          resolve(res.tempFilePath);
        } else {
          reject(new Error('图片下载失败：' + url));
        }
      },
      fail: reject,
    });
  });
}

/**
 * 依次上传一组图片（自动把网络图片先下载再上传）
 * @param {Array} items [{ Key: '上传路径', FilePath: '本地或网络路径' }]
 * @returns {Promise<Number>} 成功上传的数量
 */
async function uploadList(items) {
  let successCount = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      // FilePath 可能是本地路径或网络地址；防御：非字符串当失败处理
      const filePath = String(item.FilePath || '');
      if (!filePath) {
        console.error('上传失败（路径为空）：' + item.Key);
        continue;
      }
      // 判断是本地文件还是网络图片：本地文件直接上传，网络图片先下载
      const isLocal = filePath.indexOf('wxfile://') === 0 || filePath.indexOf('http://tmp') === 0;
      const file = isLocal ? filePath : await downloadFile(filePath);
      await uploadOne(item.Key, file);
      successCount++;
    } catch (e) {
      console.error('上传失败：' + item.Key, e);
      // 单个图片失败不中断整批上传（网络不好时允许重试一次）
      // 如需"失败就重试"，可在此处再次调用 uploadOne
    }
  }
  return successCount;
}

/**
 * 删除 COS 上的一组图片
 * @param {Array} keys COS 对象路径数组，例如 ['main/images/小白0.jpg']
 */
function deleteList(keys) {
  const cos = getCOS();
  keys.forEach(function (key) {
    if (!key) return;
    cos.deleteObject({
      Bucket: config.cos.Bucket,
      Region: config.cos.Region,
      Key: key,
    }, function (err) {
      if (err) console.error('删除失败：' + key, err);
    });
  });
}

// ============ 服务端复制（改名 / 排序专用，不重新上传图片数据） ============
// 图片 key 可能含中文（猫名/标题），CopySource 里必须逐段 URL 编码，
// 否则中文会被解析错误导致复制失败。
function encodeKey(key) {
  return String(key || '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/**
 * 把 COS 上的一个对象"服务端复制"到新 key（改名为新 key，不传图片数据）
 * 基于 SDK 的 putObjectCopy（经实测 cos-wx-sdk-v5.js 暴露该方法）。
 * @param {String} fromKey 源对象 key，例如 'main/images/小白0.jpg'
 * @param {String} toKey   目标对象 key，例如 'main/images/小白3.jpg'
 * @returns {Promise}
 */
function copyObject(fromKey, toKey) {
  return new Promise(function (resolve, reject) {
    getCOS().putObjectCopy({
      Bucket: config.cos.Bucket,
      Region: config.cos.Region,
      Key: toKey,
      CopySource: config.cos.Bucket + '.cos.' + config.cos.Region + '.myqcloud.com/' + encodeKey(fromKey),
    }, function (err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

/**
 * 并发执行一批异步任务（限制同时进行的数量，防止一次发出太多网络请求）。
 * 上传/复制时"每张图等上一张"会非常慢（N 张图 = N 次串行网络往返），
 * 这里让它们同时跑，但最多 limit 个，微信/服务器都不会被压垮。
 * @param {Array} items 要处理的数据项
 * @param {Function} worker 处理函数 (item, index) => Promise
 * @param {Number} limit 同时最多跑几个（默认 6）
 * @returns {Promise<Array>} 结果数组；某项失败时对应位置为 {err}，不中断整批
 */
async function runPool(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0; // 下一个要领取的任务下标（并发安全：Worker 只认自己的 i）
  const count = Math.max(1, Math.min(limit || 6, items.length));
  const runners = [];
  for (let r = 0; r < count; r++) {
    runners.push((async () => {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await worker(items[i], i);
        } catch (e) {
          results[i] = { err: e };
        }
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

/**
 * 批量"服务端复制"。
 * 用两阶段临时 key 防止覆盖顺序问题：
 *   阶段1 源→临时 key，阶段2 临时 key→目标，最后清理临时文件。
 * 这样即使"某目标的 key 恰是另一张图的源 key"，也能保证读到原始数据。
 * 两个阶段各自"并发"执行（两阶段仍是严格的先后关系，保证读到的是改动前数据），
 * 所以 N 张图也只要 2 轮网络往返，提交速度不受图片数量拖累。
 * @param {Array} items [{ from: 源key, to: 目标key }]
 * @returns {Promise<Array<{from:String,to:String,ok:Boolean}>>}
 *   逐项成败结果：ok=true 表示该 from 已被成功复制到 to。
 *   调用方据此决定能否删除 from（复制失败则必须保留原始文件，防误删）。
 */
async function copyList(items) {
  // 过滤空项与"源=目标"（无需复制）
  const jobs = (items || []).filter(function (x) {
    return x && x.from && x.to && x.from !== x.to;
  });
  if (!jobs.length) {
    return jobs.map(function (x) { return { from: x.from, to: x.to, ok: false }; });
  }
  const stamp = Date.now();
  const temps = jobs.map(function (x, i) {
    const base = String(x.to).split('/').pop() || ('img' + i);
    return {
      from: x.from,
      to: x.to,
      temp: 'main/images/.tmp/' + base + '_' + stamp + '_' + i + '.tmp',
      copied: false, // 阶段1成功（用于临时文件清理）
      ok: false,     // 阶段2成功（用于判定源文件可删除）
    };
  });
  // 阶段 1：源 → 临时 key（并发）
  await runPool(temps, async function (t) {
    try {
      await copyObject(t.from, t.temp);
      t.copied = true;
    } catch (e) {
      console.error('复制失败(源→临时)：' + t.from, e);
    }
  }, 6);
  // 阶段 2：临时 key → 目标（只做阶段 1 成功的，并发）
  await runPool(
    temps.filter(function (t) { return t.copied; }),
    async function (t) {
      try {
        await copyObject(t.temp, t.to);
        t.ok = true;
      } catch (e) {
        console.error('复制失败(临时→目标)：' + t.temp, e);
      }
    },
    6
  );
  // 阶段 3：清理临时文件（只清理阶段 1 成功创建的）
  deleteList(temps.filter(function (t) { return t.copied; }).map(function (t) { return t.temp; }));
  return temps.map(function (t) { return { from: t.from, to: t.to, ok: t.ok }; });
}

/**
 * 从图片 URL 反推出它在 COS 上的对象 key（用于改名/排序时定位"这张网络图当前是哪个文件"）
 * 例如 https://.../main/images/小白0.jpg → main/images/小白0.jpg
 *       https://.../main/images/page/标题2.jpg → main/images/page/标题2.jpg
 * 无法识别（非本项目根地址）时返回空字符串，调用方应跳过该图，不破坏数据。
 * @param {String} url 网络图片地址
 * @returns {String} COS 对象 key，或 ''
 */
function keyFromUrl(url) {
  if (typeof url !== 'string') return '';
  if (url.indexOf(ROOT) !== 0) return '';
  // 展示用的 URL 可能带了 ?v=版本号（照片版本缓存刷新用），反推 key 前先剥掉 query
  const q = url.indexOf('?');
  const clean = q >= 0 ? url.slice(0, q) : url;
  // ROOT 形如 https://.../main/images/，去掉后剩 猫名0.jpg 或 page/标题0.jpg
  return 'main/images/' + clean.slice(ROOT.length);
}

// ============ 照片内容指纹（ETag）用于历史照片去重 ============
// 本项目图片都是单次 PUT 上传，COS 的 ETag 即内容 MD5；copyObject 同区域复制
// 会保留源对象 ETag。因此"同内容 ⇔ 同 ETag"，可判断两张历史照片是不是同一张图
// （跨版本去重、与当前列表去重）。同一 key 内容不变 ETag 不变，模块级缓存避免重复 headObject。
const _etagCache = {};
/** 清空 ETag 缓存：提交/删除会覆盖当前照片 key，缓存会残留旧值，改动后需调用 */
function clearETagCache() {
  for (const k in _etagCache) delete _etagCache[k];
}
function getETag(key) {
  if (!key) return Promise.resolve('');
  if (_etagCache[key]) return Promise.resolve(_etagCache[key]);
  return new Promise(function (resolve) {
    getCOS().headObject({
      Bucket: config.cos.Bucket,
      Region: config.cos.Region,
      Key: key,
    }, function (err, data) {
      if (err || !data || !data.ETag) {
        resolve(''); // 读取失败返回空串，调用方按"保留展示"处理，不阻断
        return;
      }
      const t = String(data.ETag).replace(/"/g, '').toLowerCase();
      _etagCache[key] = t;
      resolve(t);
    });
  });
}

// ============ 照片历史存档（每次编辑/删除前把当时照片整套复制到存档目录） ============
// 存档目录放 main/images/archive/ 下，可复用 ROOT 直接拼 URL 供页面展示历史照片。
// 服务端复制不传图片数据、成本极低；存副本是"多一份保险"——即使原图被
// 同名新猫覆盖或老代码删除过，历史版本也永久可恢复。
function basename(key) {
  const s = String(key || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function archivePrefix(catId, stamp) {
  return 'main/images/archive/' + catId + '/' + stamp + '/';
}

function archiveKey(prefix, key) {
  return (prefix || '') + basename(key);
}

function archiveUrl(prefix, key) {
  return ROOT + String(prefix || '').replace(/^main\/images\//, '') + basename(key);
}

/**
 * 把一组照片复制到存档目录（每次编辑/删除前调用，拍下"当时的照片"快照）。
 * 失败只记日志、不阻断主流程——副本失败时原图仍在原 key 上。
 * @param {String} catId 猫的 _id
 * @param {Number|String} stamp 存档时间戳（作目录名，与存档记录 editTime 对应）
 * @param {Array} keys 源文件 key 列表（jpg0..n + 缩略图）
 * @returns {Promise<Array>} copyList 结果 [{from,to,ok}]
 */
async function archiveSnapshot(catId, stamp, keys) {
  const prefix = archivePrefix(catId, stamp);
  try {
    return await copyList((keys || []).map(function (k) {
      return { from: k, to: archiveKey(prefix, k) };
    }));
  } catch (e) {
    console.error('照片存档复制失败', e);
    return [];
  }
}

/**
 * 把存档目录里的照片复制回原 key（回收站恢复整只猫 / 历史照片单张恢复共用）。
 * @param {String} prefix 存档目录前缀（archiveSnapshot 时存入记录的 photoArchive）
 * @param {Array} keys 原 key 列表
 * @returns {Promise<Array>} copyList 结果 [{from,to,ok}]
 */
async function restorePhotos(prefix, keys) {
  try {
    return await copyList((keys || []).map(function (k) {
      return { from: archiveKey(prefix, k), to: k };
    }));
  } catch (e) {
    console.error('照片恢复复制失败', e);
    return [];
  }
}

/**
 * 图片"对账"：让 COS 上当前记录的图片达到"新列表按序号命名"的目标态。
 * 通用逻辑（editCat / editBooklet 共用）：
 *   - 本地新图      → 上传（只传真正新增的）
 *   - 网络旧图      → 服务端复制到新序号（改名/排序都不重新上传数据）
 *   - 删除          → 仅删"新列表不再占用、且（若被引用则已复制成功）"的旧 key，
 *                     由集合推导，绝不多删、不误删；改名后不留孤儿文件。
 * 执行顺序：先复制 → 再上传 → 最后删除（避免上传目标覆盖复制源）。
 * @param {Object} opts
 *   opts.imageUrls    新顺序的图片列表（本地路径 或 网络 URL）
 *   opts.newKey       生成新位置 key 的函数 (index) => Key，例如 i => cos.catJpg(name, i)
 *   opts.oldKeys      旧记录存在过的全部 key 数组
 *   opts.urlToKey     (url) => 网络图源 key，缺省用 keyFromUrl
 *   opts.extraCopies  额外追加的复制项 [{from, to}]（如封面缩略图），
 *                     与 jpg 复制同批次两阶段执行，保证源文件读到的是"改动前"的原始数据
 * @returns {Promise<{uploads:Number, copies:Number, deleted:Number}>}
 */
async function reconcileImages(opts) {
  const urls = Array.isArray(opts.imageUrls) ? opts.imageUrls : [];
  const newKey = typeof opts.newKey === 'function' ? opts.newKey : null;
  const oldKeys = Array.isArray(opts.oldKeys) ? opts.oldKeys : [];
  const urlToKey = typeof opts.urlToKey === 'function' ? opts.urlToKey : keyFromUrl;
  const extraCopies = Array.isArray(opts.extraCopies) ? opts.extraCopies : [];

  function isLocal(u) {
    return typeof u === 'string' && (u.indexOf('wxfile://') === 0 || u.indexOf('http://tmp') === 0);
  }

  const uploads = []; // [{ Key, FilePath }]
  const copies = [];  // [{ from, to }]
  const kept = [];    // 新列表仍引用的源 key

  urls.forEach(function (url, i) {
    if (!newKey) return;
    const target = newKey(i);
    if (isLocal(url)) {
      uploads.push({ Key: target, FilePath: url });
    } else {
      const src = urlToKey(url);
      if (!src) return; // 无法定位源文件：跳过该图，不破坏现有数据
      kept.push(src);
      if (src !== target) copies.push({ from: src, to: target });
    }
  });
  // 额外复制项并入同一批次（如缩略图），与上面的复制一起做两阶段，防覆盖
  extraCopies.forEach(function (x) {
    if (x && x.from && x.to && x.from !== x.to) copies.push({ from: x.from, to: x.to });
  });

  // 新目标 key 集合（新列表最终占用的全部位置，任何目标 key 都不得删除）
  const targets = new Set();
  urls.forEach(function (_, i) { if (newKey) targets.add(newKey(i)); });
  const keptSet = new Set(kept);

  // 先复制、再上传，最后删除（避免上传/复制源被覆盖）
  let copyResults = [];
  if (copies.length) copyResults = await copyList(copies);
  if (uploads.length) await uploadList(uploads);

  // 删除判定（防误删 + 不留孤儿）：
  //  - 仍是目标的 key → 保留
  //  - 仍被引用的旧图（kept）：只有它被成功复制到新 key 后才可删；
  //    复制失败则保留原始文件（数据优先，宁可多存不可误删）
  //  - 旧记录里从未被引用的文件 → 删
  const copiedOkFrom = new Set(
    copyResults.filter(function (r) { return r.ok; }).map(function (r) { return r.from; })
  );
  const toDelete = oldKeys.filter(function (k) {
    if (targets.has(k)) return false;
    if (keptSet.has(k)) return copiedOkFrom.has(k);
    return true;
  });

  if (toDelete.length) deleteList(toDelete);

  return {
    uploads: uploads.length,
    copies: copies.length,
    deleted: toDelete.length,
  };
}

module.exports = {
  // 上传 / 删除
  uploadOne: uploadOne,
  uploadList: uploadList,
  downloadFile: downloadFile,
  deleteList: deleteList,
  // 并发限流（草稿后台自动上传图片时限制同时进行的数量）
  runPool: runPool,
  // 内容指纹（历史照片去重用）
  getETag: getETag,
  clearETagCache: clearETagCache,
  // 服务端复制 / 对账（改名、排序不重传数据）
  copyObject: copyObject,
  copyList: copyList,
  keyFromUrl: keyFromUrl,
  reconcileImages: reconcileImages,
  // 照片历史存档（编辑/删除前快照 + 恢复）
  archivePrefix: archivePrefix,
  archiveKey: archiveKey,
  archiveUrl: archiveUrl,
  archiveSnapshot: archiveSnapshot,
  restorePhotos: restorePhotos,
  // COS 路径 / URL 生成
  catJpg: catJpg,
  catThumb: catThumb,
  pageJpg: pageJpg,
  profilePng: profilePng,
  catUrl: catUrl,
  catThumbUrl: catThumbUrl,
  pageUrl: pageUrl,
  profileUrl: profileUrl,
};
