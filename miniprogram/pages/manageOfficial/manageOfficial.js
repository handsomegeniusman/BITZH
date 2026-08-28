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

  /** 分页加载官方推文（按发布时间倒序，最新在前） */
  loadList() {
    db.paginate('Page', { official: true }, { sort: { pageTime: -1 }, limit: 20 }, this.data.list)
      .then((list) => {
        this.setData({
          list: list.map((p) => Object.assign({}, p, {
            // 封面：officialLogo（包内 logo）→ 包内路径；否则取自有首图（photoNum=0 时为空 → WXML 显示占位）
            _cover: p.officialLogo ? cos.BUNDLED_LOGO : (p.photoNum ? cos.pageUrl(p.tittle, 0) : ''),
            _timeText: formatTime(p.editTime) || formatTime(p.pageTime),
            _count: (p.officialLogo ? 1 : 0) + (p.photoNum || 0), // 实际展示图片数（logo + 自有图）
          })),
        });
      })
      .catch((err) => { console.error('加载官方推文失败', err); wx.showToast({ icon: 'none', title: '加载失败，下拉重试' }); });
  },

  /** 上拉触底：加载更多 */
  onReachBottom() {
    this.loadList();
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
