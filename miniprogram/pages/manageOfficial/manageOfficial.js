// ============================================================
// pages/manageOfficial/manageOfficial.js —— 官方推文管理列表（仅管理员）
// 【作用】列出全部官方推文（Page.official=true），
//        封面（logo 或自有首图）+ 标题 + 编辑时间，点「编辑」进 editBooklet。
//        顶部「发布新推文」入口进 addOfficial。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const guard = require('../../utils/guard.js'); // 前端保险工具（管理员校验）
const cos = require('../../utils/cos.js'); // 图片 URL / 包内 logo 常量
const { formatTime } = require('../../utils/util.js'); // 时间格式化

Page({
  data: {
    list: [], // 官方推文列表（含展示字段 _cover / _timeText / _count）
  },

  /** 页面加载：只有管理员可以使用 */
  async onLoad() {
    guard.ensureNotBanned();
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    this.loadList();
  },

  /**
   * 分页加载官方推文（按发布时间倒序，最新在前）。
   * @param {Array} [base] 分页基线：不传则接着当前列表往后翻（触底加载）；
   *                       传 [] 表示从第一页重拉（下拉刷新用）。
   * @returns {Promise<Array>} 查询结果（失败时带 _failed 标记，且不动页面数据）
   */
  loadList(base) {
    const list = base || this.data.list;
    return db.paginate('Page', { official: true }, { sort: { pageTime: -1 }, limit: 20 }, list)
      .then((result) => {
        // db.paginate 出错时会吞掉异常、返回带 _failed 的原列表：此时不动页面数据，
        // 把提示交给调用方。原先挂在这里的 .catch 永远不会执行（异常在 db 层就被吞了）。
        if (result && result._failed) return result;
        this.setData({
          list: result.map((p) => Object.assign({}, p, {
            // 封面：officialLogo（包内 logo）→ 包内路径；否则取自有首图（photoNum=0 时为空 → WXML 显示占位）
            _cover: p.officialLogo ? cos.BUNDLED_LOGO : (p.photoNum ? cos.pageUrl(p.tittle, 0) : ''),
            _timeText: formatTime(p.editTime) || formatTime(p.pageTime),
            _count: (p.officialLogo ? 1 : 0) + (p.photoNum || 0), // 实际展示图片数（logo + 自有图）
          })),
        });
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
    // 等于绕过 onLoad 的拦截看到官方推文管理列表。所以这里必须再挡一次。
    if (!guard.requireAdmin()) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadList([]).then((result) => {
      if (result && result._failed) wx.showToast({ icon: 'none', title: '加载失败，下拉重试' });
      wx.stopPullDownRefresh(); // 必须调用，否则下拉转圈不收起
    });
  },

  /** 发布新官方推文 */
  addOfficial() {
    wx.navigateTo({ url: '/pages/addOfficial/addOfficial' });
  },

  /** 编辑官方推文 */
  editOfficial(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/editBooklet/editBooklet?_id=' + id });
  },

  /** 单击卡片进详情（与普通推文一致） */
  toDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?_id=' + id });
  },
});
