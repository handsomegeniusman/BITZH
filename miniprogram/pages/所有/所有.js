// ============================================================
// pages/所有/所有.js —— 猫咪列表（全部健康 / 按毛色分类）
// 【作用】分页展示"健康"状态的猫咪。
//         - 不带参数：显示所有健康猫咪（原"所有"入口）
//         - 带 classification 参数：按毛色分类过滤（原"花色图鉴"入口）
//         从首页各入口进入。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const pageUtil = require('../../utils/page.js'); // 页面公共方法（缩略图回退）
const guard = require('../../utils/guard.js'); // 前端保险工具（黑名单拦截）

Page({
  data: {
    cat: [],            // 猫咪列表
    url: app.globalData.url, // 图片根地址
    classification: '', // 毛色分类（空 = 全部健康猫）
  },

  /** 页面加载：记录分类并加载猫咪 */
  onLoad(options) {
    guard.ensureNotBanned();
    this.setData({ classification: options.classification || '' });
    this.loadMoreCat();
  },

  /** 回到本页时刷新：删除/修改的猫咪不再残留在列表（避免继续加载已删图片） */
  onShow() {
    if (!this._firstShow) {
      this._firstShow = true;
      return;
    }
    this.setData({ cat: [] }); // paginate 只追加不删除，先重置再重拉
    this.loadMoreCat();
  },

  /** 上拉触底：加载更多 */
  onReachBottom() {
    this.loadMoreCat();
  },

  /** 分页加载健康猫咪（可选项：按毛色分类过滤） */
  loadMoreCat() {
    const filter = { status: "健康" };
    if (this.data.classification) filter.classification = this.data.classification;
    db.paginate('BITZH', filter, { sort: { lastEditTime: -1 }, limit: 20 }, this.data.cat)
      // stampThumbs：缩略图带照片版本号，照片变了 URL 变新，避免显示旧缓存图
      .then(list => this.setData({ cat: pageUtil.stampThumbs(list, this.data.url) }))
      .catch(err => { console.error('分页加载失败', err); wx.showToast({ icon: 'none', title: '加载失败，下拉重试' }); });
  },

  /** 猫咪缩略图加载失败时逐级回退：.png → 0.jpg → 占位图 */
  onCatImgError(e) {
    pageUtil.onImgError(this, e);
  },

  /** 管理员长按猫咪可进入编辑页 */
  editCat(e) {
    if (!app.globalData.isAdministrator) return;
    wx.navigateTo({ url: '/pages/editCat/editCat?_id=' + e.currentTarget.dataset._id });
  },

  /** 转发给好友/群 */
  onShareAppMessage() {
    const classification = this.data.classification;
    return {
      title: classification || '北理珠流浪猫关爱部',
      path: classification
        ? 'pages/所有/所有?classification=' + classification
        : 'pages/所有/所有',
    };
  },

  /** 转发到朋友圈 */
  onShareTimeline() {
    const classification = this.data.classification;
    return {
      title: classification || '北理珠流浪猫关爱部',
      path: classification
        ? 'pages/所有/所有?classification=' + classification
        : 'pages/所有/所有',
    };
  },
});
