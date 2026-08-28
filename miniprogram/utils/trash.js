// ============================================================
// utils/trash.js —— 帖子回收站公共逻辑（管理员回收站 / 我的页个人回收站共用）
// ============================================================
// 【作用】把"删除存档（Delete 集合）"的列表展示字段映射 与"一键恢复整条推文"
//        的流程抽出来，供两个入口复用：
//          - pages/pageTrash（管理员后台 → 帖子回收站）
//          - pages/mydetail 的「回收站」分栏（普通用户看自己删除的帖子）
//        存档两种形态：新存档字段在 rec.data 里（含 authorId/photoArchive/photoKeys），
//        老存档字段在顶层、无照片存档。所有读取都优先 data、回退顶层。
// ============================================================
const db = require('./db.js');
const cos = require('./cos.js');
const guard = require('./guard.js');
const { formatTime } = require('./util.js');

const DELETE_COLLECTION = 'Delete'; // 删除存档集合（帖子专用）

/** 兼容双形态取值：新存档字段在 rec.data 里、老存档在顶层，优先读 data */
function pick(rec, k) {
  return (rec.data && rec.data[k] !== undefined) ? rec.data[k] : rec[k];
}

/**
 * 把一条删除存档映射为列表展示项：
 *   tittle（标题）/ timeText（删除时间）/ operator（操作者）/ photoUrls（存档照片）/
 *   hasArchive（是否有照片存档）
 * 展开的照片预览用 photoUrls；恢复流程直接用返回项保留的原始字段（_id/data/photoArchive/photoKeys）。
 * @param {Object} r 存档记录（Delete 集合的一条）
 * @returns {Object} 展示项（含原始记录字段）
 */
function mapTrashItem(r) {
  const data = r.data || {};
  const photoArchive = data.photoArchive || r.photoArchive;
  // data.photoKeys 为空数组时不优先——回退到顶层 r.photoKeys（兼容旧存档格式）
  const photoKeys = (Array.isArray(data.photoKeys) && data.photoKeys.length) ? data.photoKeys
    : (Array.isArray(r.photoKeys) && r.photoKeys.length) ? r.photoKeys : [];
  const photoUrls = [];
  // 官方推文：包内 logo 首张展示（不上传、未存档），其后是存档里的自有图
  if (pick(r, 'officialLogo')) photoUrls.push(cos.BUNDLED_LOGO);
  if (photoArchive && photoKeys.length) {
    photoKeys.forEach((key) => {
      photoUrls.push(cos.archiveUrl(photoArchive, key));
    });
  }
  return Object.assign({}, r, {
    tittle: pick(r, 'tittle') || pick(r, 'pageTittle') || '',
    timeText: formatTime(r.editTime),
    operator: r.operatorName || '',
    photoUrls: photoUrls,
    hasArchive: !!(photoArchive && photoKeys.length),
  });
}

/**
 * 一键恢复整条推文（调用方先弹确认框，本函数执行实际恢复）：
 *   - 同名在册推文拦截（避免重复，与发布页 checkName 一致）→ { ok:false, reason:'duplicate' }
 *   - 从存档目录把照片复制回原 key（老存档无照片存档则跳过）
 *   - 用存档数据重建 Page 记录（作者字段原值写回），最后删除这条存档，防止重复恢复
 * @param {Object} rec 删除存档（mapTrashItem 的结果项或原始记录均可）
 * @returns {Promise<Object>} { ok:true } 或 { ok:false, reason:'duplicate' }；真实失败抛错
 */
async function restoreTrashItem(rec) {
  if (!rec) throw new Error('restoreTrashItem: rec is null or undefined');
  const data = rec.data || rec; // 新存档字段在 data 里，老存档就是顶层
  const tittle = data.tittle || rec.pageTittle;
  if (tittle) {
    const exist = await db.findOne('Page', { tittle: tittle });
    if (exist) return { ok: false, reason: 'duplicate' };
  }
  // 照片：从存档目录复制回原 key（保证照片与删除时一致）
  const archive = data.photoArchive || rec.photoArchive;
  const keys = Array.isArray(data.photoKeys) ? data.photoKeys
    : (Array.isArray(rec.photoKeys) ? rec.photoKeys : []);
  if (archive && keys.length) {
    await cos.restorePhotos(archive, keys);
    cos.clearETagCache(); // 原 key 内容已被存档覆盖，清掉指纹缓存防"已有"误判
  }
  // 记录：用存档数据重建整条推文（原值写回；commendId 缺失则新生成，评论丢失记录在案）
  const doc = {
    author: guard.toText(data.author || ''),
    authorId: data.authorId || '',
    authorImg: data.authorImg || '',
    tittle: guard.toText(tittle || ''),
    main: guard.toText(data.main || ''),
    photoTime: data.photoTime || guard.todayString(), // 缺省用今天，保证排序字段不为空
    relative: guard.toText(data.relative || ''),
    photoNum: data.photoNum || keys.length || 0, // 数字，不做文本兜底
    // 兜底生成 commendId，但不能为 0（falsy 会导致评论加载跳过）
    commendId: data.commendId != null ? data.commendId : (Math.floor(Math.random() * 9999999999) + 1),
    good: data.good || 0,
    pageTime: data.pageTime || new Date(),
  };
  // 官方推文：恢复时原样保留 official 标记与编辑人/编辑时间（logo 为包内资源，无需存档）
  if (data.official || data.officialLogo) {
    doc.official = true;
    doc.officialLogo = !!data.officialLogo;
    if (data.editBy) doc.editBy = data.editBy;
    if (data.editTime) doc.editTime = data.editTime;
  }
  await db.insertOne('Page', doc);
  await db.deleteOne(DELETE_COLLECTION, { _id: rec._id });
  return { ok: true };
}

module.exports = {
  DELETE_COLLECTION: DELETE_COLLECTION,
  pick: pick,
  formatTime: formatTime,
  mapTrashItem: mapTrashItem,
  restoreTrashItem: restoreTrashItem,
};
