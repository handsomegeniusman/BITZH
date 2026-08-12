// ============================================================
// pages/Administrator/Administrator.js —— 管理员后台
// 【作用】管理员可在此：
//        1. 一键开关"注册/发布"审核（manage）
//        2. 进入"公告管理"页面（manageNotice）
//        页面仅管理员可用，其他人直接打开会被拦下。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const config = require('../../config.js'); // 全局配置
const guard = require('../../utils/guard.js'); // 前端保险工具（限频）

Page({
  data: {
    audit: false, // 当前是否开放注册/发布
  },

  /** 页面加载：校验管理员身份并读取当前审核开关 */
  async onLoad() {
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    this.setData({ audit: await db.getAudit() });
  },

  /** 一键开关审核（带确认弹窗，防止误操作） */
  manage() {
    // 前端限频（保险）：3 秒内只能切换一次
    if (!guard.throttle('manageAudit', 3000)) return;
    var newVal = !this.data.audit;
    var label = newVal ? '开启' : '关闭';
    var self = this;
    wx.showModal({
      title: '确认操作',
      content: '确定' + label + '注册/发布审核吗？',
      confirmText: label,
      success: function (res) {
        if (!res.confirm) return;
        db.updateOne('Administrator', { _id: config.administratorRecordId }, { $set: { audit: newVal } })
          .then(function () {
            self.setData({ audit: newVal });
            db.resetAuditCache(); // 清掉审核缓存，让其他页面拿到最新值
            wx.showToast({ icon: 'success', title: '操作成功' });
          }).catch(err => { console.error(err); wx.showToast({ icon: 'error', title: '操作失败，请重试' }); });
      },
    });
  },

  /** 管理公告板 */
  manageNotice() {
    wx.navigateTo({ url: '/pages/editAnnouncement/editAnnouncement' });
  },

  /** 回收站（被删除的猫，可看照片并恢复） */
  manageTrash() {
    wx.navigateTo({ url: '/pages/catTrash/catTrash' });
  },

  /** 帖子回收站（被删除的推文，可看照片并恢复） */
  managePageTrash() {
    wx.navigateTo({ url: '/pages/pageTrash/pageTrash' });
  },
});
