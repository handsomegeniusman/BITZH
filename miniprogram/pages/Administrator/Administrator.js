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
    phone: '', // 联系方式（手机号），从 Administrator 集合读取
    email: '', // 联系方式（邮箱），从 Administrator 集合读取
    contactOpen: false, // 联系方式填写区是否展开（默认收起）
  },

  /** 展开/收起联系方式填写区（输入值保留在 data，不会丢） */
  toggleContact() {
    this.setData({ contactOpen: !this.data.contactOpen });
  },

  /** 页面加载：校验管理员身份并读取当前审核开关、联系方式 */
  async onLoad() {
    guard.ensureNotBanned();
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    this.setData({ audit: await db.getAudit() });
    this.loadContact();
  },

  /** 读取联系方式并回填输入框（from Administrator 集合） */
  loadContact() {
    const self = this;
    db.getContact().then(function (c) {
      self.setData({ phone: c.phone || '', email: c.email || '' });
    }).catch(function (e) {
      console.error('读取联系方式失败', e);
    });
  },

  /** 手机号输入框 */
  onPhoneInput(e) {
    this.setData({ phone: e.detail.value });
  },

  /** 邮箱输入框 */
  onEmailInput(e) {
    this.setData({ email: e.detail.value });
  },

  /** 保存联系方式到数据库（about 页展示即生效，无需重新发布版本；写联系方式记录，非审核开关记录） */
  saveContact() {
    if (!guard.throttle('saveContact', 3000)) return;
    const phone = (this.data.phone || '').trim();
    const email = (this.data.email || '').trim();
    const self = this;
    db.updateOne('Administrator', { _id: config.contactRecordId }, { $set: { phone: phone, email: email } })
      .then(function () {
        self.setData({ phone: phone, email: email });
        wx.showToast({ icon: 'success', title: '保存成功' });
      }).catch(err => { console.error(err); wx.showToast({ icon: 'error', title: '保存失败，请重试' }); });
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

  /** 回收站（合并入口）：先弹选择，再去猫回收站或帖子回收站 */
  manageTrashMenu() {
    wx.showActionSheet({
      itemList: ['被删除的猫（可恢复）', '被删除的帖子（可恢复）'],
      success: (res) => {
        const url = res.tapIndex === 0 ? '/pages/catTrash/catTrash'
          : (res.tapIndex === 1 ? '/pages/pageTrash/pageTrash' : '');
        if (!url) return;
        // 等 actionSheet 收起动画结束再跳转，避免原生面板与路由交叠触发
        // "routeDone with a webviewId XX is not found"（框架层路由噪音，通常无害）
        setTimeout(() => wx.navigateTo({ url: url }), 300);
      },
      fail: () => {}, // 用户取消选择，不处理
    });
  },

  /** 回收站（被删除的猫，可看照片并恢复） */
  manageTrash() {
    wx.navigateTo({ url: '/pages/catTrash/catTrash' });
  },

  /** 帖子回收站（被删除的推文，可看照片并恢复） */
  managePageTrash() {
    wx.navigateTo({ url: '/pages/pageTrash/pageTrash' });
  },

  /** 内容安全复核中心（举报 / 申诉 / 待复核内容，含下架、封禁、解封） */
  manageReview() {
    wx.navigateTo({ url: '/pages/reviewCenter/reviewCenter' });
  },

  /** 用户管理 / 黑名单（搜索用户 / 封禁解封 / 查看黑名单） */
  manageUsers() {
    wx.navigateTo({ url: '/pages/userManage/userManage' });
  },

  /** 官方推文管理列表（含"发布新推文"入口） */
  manageOfficial() {
    wx.navigateTo({ url: '/pages/manageOfficial/manageOfficial' });
  },
});
