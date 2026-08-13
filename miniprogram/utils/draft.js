// ============================================================
// utils/draft.js —— 编辑草稿自动保存 / 崩溃恢复
// ============================================================
// 【作用】用户在"新增/编辑猫、发布/编辑帖子"时，表单内容和选好的照片会
//        自动保存成本地草稿 + COS 草稿目录里的图片副本。这样即使断网、
//        上传失败或小程序卡退，重新打开页面也能一键恢复，不用重新输入。
//
// 【方案要点】
//  1. 照片"选一张传一张"：用户选图后立刻把本地临时图静默上传到
//     main/images/draft/{userId}/{草稿目录}/img{n}.jpg，页面图片区里的
//     本地路径被替换成草稿 URL（可正常预览）。
//     - 每张图一个独立 key（img{n}，n 全局自增永不复用）→ 排序错了也串不了图；
//     - 上传失败的那张保持本地路径，恢复时探活剔除并提示，不显示破图。
//  2. 草稿存本地 storage（文本 + URL 字符串，很小）：提交成功 / 删除成功 /
//     用户明确"放弃草稿"时才清除；失败不清，重试或重进页面都能找回。
//  3. 写回列表用的是"上传完成时刻"重新读取的当前列表，只替换上传成功的那
//     几张 → 上传期间用户新增 / 删除 / 拖拽排序都不受影响。
//  4. 关键：草稿是【先存文字、再传图片】两步走。每次内容变化都先把
//     "文字 + 当前图片地址"同步写进本地 storage（不等图片上传，秒级可恢复），
//     图片则在后台静默上传，完成后【只补图片地址】写回——绝不覆盖文字。
//     所以用户编辑后哪怕 1 秒内就关掉页面重进，标题等全部文字也已在草稿里。
// ============================================================
const db = require('./db.js');
const cos = require('./cos.js');
const guard = require('./guard.js');
const imgEditor = require('./imgEditor.js');

const COUNTER_KEY = 'draft_counter'; // 草稿图片编号的全局计数器（storage 里）

/** 判断一个图片地址是不是"本地临时文件"（微信相册/拍摄得到的 wxfile:// 或 http://tmp 开头） */
function isLocal(u) {
  return typeof u === 'string' && (u.indexOf('wxfile://') === 0 || u.indexOf('http://tmp') === 0);
}

/** 本地草稿的 storage key：'draft_' + 类型 + '_' + id（add 页 id=userId，edit 页 id=记录 _id） */
function keyOf(type, id) {
  return 'draft_' + type + '_' + (id || '');
}

/** 草稿目录名：类型 + id 拼在一起后清洗掉危险字符（防 / % 等破坏 COS 路径） */
function safeDirName(type, id) {
  return guard.sanitizeFileName(type + '_' + (id || ''), 40);
}

/** 给一张新本地图分配一个永不复用的编号 n（跨会话也递增，同一草稿目录不会撞 key） */
function nextN() {
  const n = wx.getStorageSync(COUNTER_KEY) || 0;
  wx.setStorageSync(COUNTER_KEY, n + 1);
  return n;
}

/** 当前页面图片列表的全部地址（字符串数组）；对象（tempFiles）会自动取 tempFilePath */
function pageImages(page) {
  return imgEditor.listOf(page).map(imgEditor.srcOf);
}

/** 把一串地址写回页面图片列表：新增页存对象 {tempFilePath}，编辑页存字符串 */
function setPageImages(page, urls) {
  const asObjects = !!page.data.draftImagesAsObjects;
  const next = asObjects
    ? urls.map(function (u) { return { tempFilePath: u }; })
    : urls;
  console.log('[draft.restore] setPageImages → 字段=' + page.data.imgField + ' 对象格式=' + asObjects + ' 写入' + next.length + '张');
  imgEditor.setList(page, next);
}

/** 草稿保存时间的中文描述：'刚刚' / '5分钟前' / '3小时前' / '2天前' */
function ageText(savedAt) {
  const diff = Date.now() - (savedAt || 0);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + '小时前';
  return Math.floor(diff / 86400000) + '天前';
}

/** 判断一个本地临时路径还存不存在（小程序卡退后，最后一次选的图可能已经失效） */
function fileExists(path) {
  return new Promise(function (resolve) {
    try {
      wx.getFileSystemManager().access({
        path: path,
        success: function () { resolve(true); },
        fail: function () { resolve(false); },
      });
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * 把页面图片列表里"还是本地临时文件"的图，静默上传到 COS 草稿目录。
 * 上传完成后重读当前列表，只把上传成功的那几张按"图"定位替换成草稿 URL。
 * 排序安全 + 追加安全：不依赖上传前捕获的下标，期间新增/删除/拖拽都不受影响。
 * @returns {Promise<Array<String>>} 上传完成后的图片地址列表（字符串数组）
 */
async function persistLocalImages(page, type, id) {
  const list = imgEditor.listOf(page);
  // 挑出仍需要上传的本地图（已是 URL 的不用再传）
  const jobs = [];
  list.forEach(function (item) {
    const src = imgEditor.srcOf(item);
    if (isLocal(src)) jobs.push({ src: src, n: nextN() });
  });
  if (!jobs.length) return pageImages(page);

  const userId = await db.getUserId();
  const dir = 'main/images/draft/' + userId + '/' + safeDirName(type, id) + '/';

  // 并发上传（limit 6，静默：不弹"上传中"遮罩打扰编辑）；失败项置 err，不中断整批
  const results = await cos.runPool(jobs, function (job) {
    return cos.uploadOne(dir + 'img' + job.n + '.jpg', job.src, true);
  }, 6);

  // 记下上传成功的源地址
  const ok = {};
  jobs.forEach(function (job, k) {
    if (!(results[k] && results[k].err)) ok[job.src] = true;
  });

  // 【上传完成时刻】重新读一次当前列表（期间可能又增删/排序），
  // 只替换"上传成功的那几张"，其余原样保留 → 不覆盖用户期间的改动
  const asObjects = !!page.data.draftImagesAsObjects;
  const cur = imgEditor.listOf(page);
  const next = cur.map(function (item) {
    const src = imgEditor.srcOf(item);
    if (!ok[src]) return item; // 失败项保持本地路径（恢复时探活剔除并提示）
    let n = -1;
    for (let i = 0; i < jobs.length; i++) {
      if (jobs[i].src === src) { n = jobs[i].n; break; }
    }
    const url = n >= 0 ? cos.archiveUrl(dir, 'img' + n + '.jpg') : src;
    return asObjects ? { tempFilePath: url } : url;
  });
  imgEditor.setList(page, next);
  return pageImages(page);
}

/**
 * 保存草稿（每次内容变化 / onHide / onUnload 兜底时调用）。分两步：
 *  第一步【同步】把"文字 + 当前图片地址"立即写进 storage——不等图片上传。
 *    只要改过一个字，标题等全部文字就已在草稿里，编辑后 1 秒内重进也能恢复；
 *    图片这时可能还是本地路径（恢复时探活剔除失效的）。
 *  第二步【后台】把本地图片上传到 COS 草稿目录，完成后【只补图片地址】写回，
 *    绝不覆盖 fields（文字）——上传快慢/成败都不影响文字找回。
 * 重入保护：上一次保存还在传图时再触发，先记"需要再补一次"，等上次结束再跑一遍。
 * 保存失败只记日志、不清草稿——断网/崩溃后重试仍可恢复。
 * @param {Page} page 页面实例
 * @param {String} type 草稿类型（addCat/editCat/addBooklet/editBooklet）
 * @param {String} id   add 页传 userId，edit 页传记录 _id
 * @param {Object} fields 表单字段（页面传 this.data.cat 或 this.data.listData）
 * @param {Array} relationList 关系卡片（猫页才有；帖子页传空数组）
 * @param {Array} relationSyncTasks 待同步关系任务（猫页才有；帖子页传空数组）
 */
async function saveNow(page, type, id, fields, relationList, relationSyncTasks) {
  // 本次调用是否"有内容可保存"（用户编辑过 / 恢复过）。第一步会把它清掉，
  // 所以必须先记下来：第二步判断"是否值得落盘"要用它。
  const dirty = page._draftDirty;
  // ============ 第一步：文字立即同步落盘（不做任何 await，秒级可恢复） ============
  if (page._draftDirty) {
    try {
      wx.setStorageSync(keyOf(type, id), {
        savedAt: Date.now(),
        fields: fields || null,
        relationList: Array.isArray(relationList) ? relationList : [],
        relationSyncTasks: Array.isArray(relationSyncTasks) ? relationSyncTasks : [],
        images: pageImages(page), // 当前列表：已传好的 URL + 刚选还没传完的本地路径
      });
      page._draftDirty = false;
    } catch (e) {
      console.error('草稿保存失败', e); // 不清草稿，重试仍可恢复
    }
  }
  // ============ 第二步：后台传图，完成后只补图片地址（不影响文字） ============
  if (page._draftSaving) { page._draftSavingAgain = true; return; } // 上次传图没结束 → 稍后补一次
  page._draftSaving = true;
  try {
    const images = await persistLocalImages(page, type, id);
    // 传图期间用户可能已提交成功 / 删除成功 / 放弃草稿（clearDraft 置了 _draftCleared）：
    // 这时不能再写回草稿，否则会残留一份"已提交内容"的过期草稿，下次进页面误弹恢复。
    // 顺带清掉脏标记：被 _draftSavingAgain 排队的补存会因此直接跳过，不再重复上传
    if (page._draftCleared) { page._draftDirty = false; return; }
    const existing = readDraft(type, id);
    // 关键：用户没编辑过、也没有历史草稿时，不落盘。
    // 否则"新页面打开又退出"（onHide/onUnload 兜底触发 saveNow）会写进一份草稿；
    // 新增页是空草稿，编辑页是"原始记录快照"。一旦用户清了缓存（storage 里的真草稿
    // 被清掉），下次再进新增页就会误弹"发现草稿"、点恢复却表单图片全空；
    // 编辑页则每次只看一眼就留一份快照，重开就误弹恢复框。
    // 注：真实页面里图片/关系必然伴随 markDirty（选图、恢复都会置脏），
    // 所以这里只需判断"是否编辑过 + 是否已有草稿"，无需再判断图片。
    if (!existing && !dirty) return;
    const draftObj = existing || {};
    draftObj.images = images;              // 只更新图片地址
    draftObj.savedAt = Date.now();
    if (draftObj.fields === undefined && fields) draftObj.fields = fields; // 兜底：万一第一步没写到
    wx.setStorageSync(keyOf(type, id), draftObj);
  } catch (e) {
    console.error('草稿图片上传失败', e); // 文字草稿已在第一步保存，图片可等下次补传
  } finally {
    page._draftSaving = false;
    if (page._draftSavingAgain) {
      page._draftSavingAgain = false;
      saveNow(page, type, id, fields, relationList, relationSyncTasks);
    }
  }
}

/**
 * 标记"内容变了"并【立即】保存：不做防抖。
 * saveNow 的第一步会同步把文字写进 storage（只是普通小对象写入，很便宜），
 * 图片上传在后台做 → 用户编辑后随时离开 / 重进，草稿都已在，不需要等任何延迟。
 * 同时重置 _draftCleared——否则"用户放弃草稿后继续编辑"，onUnload 兜底保存会被旧标志跳过。
 */
function markDirty(page) {
  page._draftDirty = true;
  page._draftCleared = false;
  if (typeof page._draftSaveNow === 'function') page._draftSaveNow();
}

/**
 * 清除草稿：置 _draftCleared（onUnload 不再写回），删本地草稿，
 * 并尽力回收草稿目录里的图片副本（只删 main/images/draft/ 前缀的文件，绝不动正式图）。
 * 在"提交成功 / 删除成功 / 用户放弃草稿"三个出口调用。
 */
function clearDraft(page, type, id) {
  page._draftCleared = true;
  try {
    const d = readDraft(type, id);
    if (d && Array.isArray(d.images)) {
      const del = d.images
        .map(cos.keyFromUrl)
        .filter(function (k) { return k && k.indexOf('main/images/draft/') === 0; });
      if (del.length) cos.deleteList(del); // 尽力回收，失败静默（孤儿副本可接受）
    }
    wx.removeStorageSync(keyOf(type, id));
  } catch (e) {
    console.error('清除草稿失败', e);
  }
}

/** 读取草稿；没有返回 null */
function readDraft(type, id) {
  return wx.getStorageSync(keyOf(type, id)) || null;
}

/**
 * 页面加载后检查是否有草稿：有 → 弹窗询问是否恢复。
 * 确认 → 把草稿填回表单（字段 / 关系 / 图片），失效的本地图剔除并提示；
 * 放弃 → 清掉草稿（自动保存会在下次编辑时重新生成）。
 * @param {Page} page 页面实例
 * @param {String} type 草稿类型
 * @param {String} id   草稿 id
 * @param {Object} apply 页面提供的应用回调：
 *   apply.fields(page, fields)      —— 把表单字段合并回页面数据（含重算下拉选中/昵称）
 *   apply.relation(page, list, syncTasks) —— 把关系填回（猫页需要）
 * @returns {Promise<Boolean>} 是否成功恢复
 */
async function restore(page, type, id, apply) {
  const d = readDraft(type, id);
  console.log('[draft.restore] 第0步：读取草稿 type=' + type + ' id=' + id +
    ' 找到=' + (!!d) + (d ? ' savedAt=' + d.savedAt + ' images=' + (Array.isArray(d.images) ? d.images.length : '非数组') : ''));
  if (d && Array.isArray(d.images) && d.images.length) {
    console.log('[draft.restore] 图片样例：' + d.images.slice(0, 3).join(' | '));
  }
  if (!d || !d.savedAt) return false;
  const res = await new Promise(function (resolve) {
    wx.showModal({
      title: '发现草稿',
      content: '检测到' + ageText(d.savedAt) + '未完成的编辑草稿。\n' +
        '恢复会用草稿覆盖当前未提交内容，是否恢复？',
      confirmText: '恢复',
      cancelText: '放弃草稿',
      success: resolve,
    });
  });
  if (!res || !res.confirm) {
    console.log('[draft.restore] 用户点了"放弃草稿"，清除草稿');
    clearDraft(page, type, id); // 用户明确放弃 → 清掉，下次编辑再自动保存
    return false;
  }
  page._draftDirty = true; // 恢复后的内容也要继续自动保存（onHide 兜底）
  console.log('[draft.restore] 用户点了"恢复"，开始回填');
  // 1) 填回表单字段
  if (apply && typeof apply.fields === 'function' && d.fields) {
    console.log('[draft.restore] 第1步：回填表单字段 keys=' + Object.keys(d.fields).join(','));
    apply.fields(page, d.fields);
  }
  // 2) 填回关系（猫页）
  if (apply && typeof apply.relation === 'function') {
    console.log('[draft.restore] 第2步：回填关系 relationList=' + (Array.isArray(d.relationList) ? d.relationList.length : 0));
    apply.relation(page, d.relationList || [], d.relationSyncTasks || []);
  }
  // 3) 图片：剔除已失效的本地路径（卡退后最后一次选的临时图可能已不存在）
  const urls = d.images || [];
  const alive = [];
  let dead = 0;
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    if (isLocal(u)) {
      if (await fileExists(u)) alive.push(u);
      else {
        dead++;
        console.log('[draft.restore] 失效本地图已剔除：' + u);
      }
    } else {
      alive.push(u); // 网络 URL（草稿目录图/正式图）直接保留
    }
  }
  console.log('[draft.restore] 第3步：图片 存活=' + alive.length + ' 总数=' + urls.length + '（剔除 ' + dead + ' 张）');
  setPageImages(page, alive);
  console.log('[draft.restore] 第3步完成：写入后列表 ' + imgEditor.listOf(page).length + ' 张，imgField=' + page.data.imgField +
    ' asObjects=' + !!page.data.draftImagesAsObjects);
  if (dead > 0) {
    wx.showToast({ icon: 'none', title: '已跳过 ' + dead + ' 张失效图片（可重新添加）' });
  }
  return true;
}

module.exports = {
  isLocal: isLocal,
  keyOf: keyOf,
  persistLocalImages: persistLocalImages,
  saveNow: saveNow,
  markDirty: markDirty,
  clearDraft: clearDraft,
  readDraft: readDraft,
  restore: restore,
};
