// ============================================================
// pages/pageTrash/pageTrash.js —— 帖子回收站（被删除的推文）
// 【作用】管理员可查看被删除的推文存档（Delete 集合），浏览其存档照片，
//        并一键恢复整条推文（含照片，无需重新上传）。
//        列表映射与恢复流程抽在 utils/trash.js，本页只负责
//        "管理员权限 + 分页加载 + 确认弹窗"。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const guard = require('../../utils/guard.js'); // 前端保险工具（管理员校验/文本清洗）
const trash = require('../../utils/trash.js'); // 回收站公共逻辑（列表映射/恢复）

Page({
  data: {
    list: [],        // 删除存档列表（含展示字段 tittle/timeText/operator/photoUrls/hasArchive）
    expandedId: '',  // 展开显示照片的存档 _id
  },

  /** 页面加载：只有管理员可以使用回收站 */
  async onLoad() {
    guard.ensureNotBanned();
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    this.loadList();
  },

  /** 分页加载删除存档（按删除时间倒序，最新在前） */
  loadList() {
    db.paginate(trash.DELETE_COLLECTION, {}, { sort: { editTime: -1 }, limit: 20 }, this.data.list)
      .then((list) => {
        this.setData({ list: list.map(trash.mapTrashItem) });
      })
      .catch((err) => { console.error('加载帖子回收站失败', err); wx.showToast({ icon: 'none', title: '加载失败，下拉重试' }); });
  },

  /** 上拉触底：加载更多 */
  onReachBottom() {
    this.loadList();
  },

  /** 展开/收起某条存档的照片预览 */
  toggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expandedId: this.data.expandedId === id ? '' : id });
  },

  /**
   * 恢复整条推文：确认后复用 utils/trash.js 的恢复流程
   * （同名查重 / 照片复制 / 重建 Page / 删除存档）。
   */
  restore(e) {
    const id = e.currentTarget.dataset.id;
    const rec = this.data.list.find((r) => r._id === id);
    if (!rec) return;
    const data = rec.data || rec; // 新存档字段在 data 里，老存档就是顶层
    wx.showModal({
      title: '恢复推文',
      content: '将「' + (data.tittle || rec.pageTittle || '') + '」恢复到小猫书？\n（含存档照片）',
      confirmColor: '#FF405E',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          wx.showLoading({ title: '恢复中...', mask: true });
          const result = await trash.restoreTrashItem(rec);
          wx.hideLoading();
          if (!result.ok && result.reason === 'duplicate') {
            wx.showToast({ icon: 'none', title: '已存在同名推文，请先处理' });
            return;
          }
          wx.showToast({ icon: 'success', title: '已恢复' });
          this.loadList();
        } catch (err) {
          wx.hideLoading();
          console.error('恢复推文失败', err);
          wx.showToast({ icon: 'error', title: '恢复失败' });
        }
      },
    });
  },

  noop() {},
});
