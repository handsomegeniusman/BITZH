// ============================================================
// pages/catTrash/catTrash.js —— 回收站（被删除的猫）
// 【作用】管理员可查看被删除的猫咪存档（BITZHdelete），浏览其历史照片，
//        并一键恢复整只猫（含照片，无需重新上传）。
//        照片在删除时保留在 COS 原位置，另有存档目录副本；
//        恢复时先从存档目录把照片复制回原 key，保证照片与删除时一致。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const cos = require('../../utils/cos.js'); // COS 图片 URL / 存档复制公共方法
const guard = require('../../utils/guard.js'); // 前端保险工具（管理员校验）
const catForm = require('../../utils/catForm.js'); // 猫咪表单公共方法（重建 doc）
const { formatTime } = require('../../utils/util.js'); // 统一时间格式化

const DELETE_COLLECTION = 'BITZHdelete'; // 删除存档集合

Page({
  data: {
    list: [],        // 删除存档列表（含展示字段 name/timeText/operator/photoUrls/hasArchive）
    expandedId: '',  // 展开显示照片的存档 _id
  },

  /** 页面加载：只有管理员可以使用回收站 */
  async onLoad() {
    guard.ensureNotBanned();
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    this.loadList();
  },

  /**
   * 分页加载删除存档（按删除时间倒序，最新在前）。
   * @param {Array} [base] 分页基线：不传则接着当前列表往后翻（触底加载）；
   *                       传 [] 表示从第一页重拉（下拉刷新用）。
   * @returns {Promise<Array>} 查询结果（失败时带 _failed 标记，且不动页面数据）
   */
  loadList(base) {
    const list = base || this.data.list;
    return db.paginate(DELETE_COLLECTION, {}, { sort: { editTime: -1 }, limit: 20 }, list)
      .then((result) => {
        // db.paginate 出错时会吞掉异常、返回带 _failed 的原列表：此时不动页面数据，
        // 把提示交给调用方。原先挂在这里的 .catch 永远不会执行（异常在 db 层就被吞了）。
        if (result && result._failed) return result;
        // 补上展示字段：照片 URL 用存档目录拼（跳过缩略图 .png，只列照片本体）
        const items = result.map((r) => {
          const data = r.data || {};
          const photoUrls = [];
          if (data.photoArchive && Array.isArray(data.photoKeys)) {
            data.photoKeys.forEach((key) => {
              if (/\.png$/.test(key)) return;
              photoUrls.push(cos.archiveUrl(data.photoArchive, key));
            });
          }
          return Object.assign({}, r, {
            name: data.name || r.catName || '',
            timeText: formatTime(r.editTime),
            operator: r.operatorName || '',
            photoUrls: photoUrls,
            hasArchive: !!(data.photoArchive && Array.isArray(data.photoKeys) && data.photoKeys.length),
          });
        });
        this.setData({ list: items });
        return result;
      });
  },

  /** 上拉触底：加载更多 */
  onReachBottom() {
    this.loadList();
  },

  /**
   * 下拉刷新：从第一页重拉并整体替换。
   * 【为什么传 []】db.paginate 以传入列表的 length 作 skip、且只追加不删除，
   *   传空数组 = 从第一页开始，拿到的就是完整首页，可直接 setData 覆盖。
   * 【为什么失败时不 setData】失败返回的是带 _failed 的列表，不 setData 则
   *   原列表留在屏幕上，不会因为一次网络抖动把列表刷成空白。
   */
  onPullDownRefresh() {
    // 权限兜底：本页仅管理员可用。onLoad 已拦过一次，但下拉刷新是【独立入口】——
    // 非管理员经链接直达本页时 onLoad 提前 return（不加载数据），下拉却仍会触发查询，
    // 等于绕过 onLoad 的拦截看到删除存档。所以这里必须再挡一次。
    if (!guard.requireAdmin()) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadList([]).then((result) => {
      if (result && result._failed) wx.showToast({ icon: 'none', title: '加载失败，下拉重试' });
      wx.stopPullDownRefresh(); // 必须调用，否则下拉转圈不收起
    });
  },

  /** 展开/收起某条存档的照片预览 */
  toggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expandedId: this.data.expandedId === id ? '' : id });
  },

  /**
   * 恢复整只猫：先把存档目录里的照片复制回原 key（保证照片与删除时一致），
   * 再写入 BITZH，最后删掉这条存档记录，防止重复恢复。
   */
  restore(e) {
    const id = e.currentTarget.dataset.id;
    const rec = this.data.list.find((r) => r._id === id);
    if (!rec || !rec.data) return;
    wx.showModal({
      title: '恢复整只猫',
      content: '将「' + (rec.data.name || rec.catName || '') + '」恢复到首页？\n（含存档照片）',
      confirmColor: '#FF405E',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          // 同名在册猫拦截，避免重复
          const name = rec.data.name;
          if (name) {
            const exist = await db.findOne('BITZH', { name: name });
            if (exist) {
              wx.showToast({ icon: 'none', title: '已存在同名猫，请先处理' });
              return;
            }
          }
          wx.showLoading({ title: '恢复中...', mask: true });
          // 照片：从存档目录复制回原 key（老存档无照片存档则跳过，照片可能已丢）
          const archive = rec.data.photoArchive;
          const keys = rec.data.photoKeys;
          if (archive && Array.isArray(keys) && keys.length) {
            await cos.restorePhotos(archive, keys);
            cos.clearETagCache(); // 原 key 内容已被存档覆盖，清掉指纹缓存防"已有"误判
          }
          // 记录：用存档数据重建整只猫（buildDoc 含 relatedCats/nickname/lastEditTime）
          const doc = catForm.buildDoc(rec.data, rec.data.addPhotoNumber);
          // 照片版本号换成新值：恢复时照片内容（可能是存档副本）和删除前的旧缓存可能不同，
          // 首页/详情拼 URL 时带上新版本号，微信才会重新下载，不会显示删除前的旧图。
          doc.photoVer = Date.now();
          await db.insertOne('BITZH', doc);
          // 清理存档，防止重复恢复
          await db.deleteOne(DELETE_COLLECTION, { _id: rec._id });
          wx.hideLoading();
          wx.showToast({ icon: 'success', title: '已恢复' });
          this.loadList();
        } catch (err) {
          wx.hideLoading();
          console.error('恢复猫咪失败', err);
          wx.showToast({ icon: 'error', title: '恢复失败' });
        }
      },
    });
  },

  noop() {},
});
