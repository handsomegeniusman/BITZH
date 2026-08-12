// ============================================================
// pages/editAnnouncement/editAnnouncement.js —— 公告管理
// 【作用】管理员查看 / 新增 / 修改公告，并控制公告是否展示
//        （status 为 true 时，"小猫书"首页才会弹出来）。
//        页面仅管理员可用。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const guard = require('../../utils/guard.js'); // 前端保险工具（限频/限长）
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）

Page({
  data: {
    announcementList: [], // 公告列表
    isModalVisible: false, // 弹窗
    isAdd: false,          // 是否处于"新增"模式
    _id: '',               // 当前编辑的公告 id
    noticeName: '',        // 当前编辑的公告标题（原值）
    notice: '',            // 当前编辑的公告内容（原值）
    noticeNameChange: '',  // 新输入的标题
    noticeChange: '',      // 新输入的内容
    order: true,           // 排序：true=倒序（默认），false=正序
  },

  /** 切换排序方向 */
  inOrder() {
    this.setData({ order: !this.data.order, announcementList: this.data.announcementList.slice().reverse() });
  },

  /** 页面加载：校验管理员身份并加载公告列表 */
  async onLoad() {
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    this.getNotice();
  },

  /** 加载全部公告 */
  getNotice() {
    db.find('Notice', {})
      .then((list) => this.setData({ announcementList: list }))
      .catch(console.error);
  },

  /** 公告开关：控制是否展示（先乐观更新，DB 失败时回退） */
  onSwitchChange(e) {
    const newStatus = e.detail.value;
    const index = e.currentTarget.dataset.index;
    const _id = e.currentTarget.dataset._id;
    const oldStatus = !newStatus;
    // 先乐观更新 UI（响应快），再写数据库
    setField(this, 'announcementList[' + index + '].status', newStatus);
    db.updateOne('Notice', { _id }, { $set: { status: newStatus } })
      .then(() => {
        wx.showToast({ icon: 'success', title: '修改成功' });
      }).catch((err) => {
        // 数据库写入失败 → 回退开关状态
        console.error(err);
        setField(this, 'announcementList[' + index + '].status', oldStatus);
        wx.showToast({ icon: 'error', title: '操作失败' });
      });
  },

  /** 新增公告 */
  addNotice() {
    this.setData({
      isModalVisible: true,
      isAdd: true,
      noticeNameChange: '',
      noticeChange: '',
    });
  },

  /** 修改已有公告 */
  changeNotice(e) {
    this.setData({
      isModalVisible: true,
      isAdd: false,
      _id: e.currentTarget.dataset._id,
      noticeName: e.currentTarget.dataset.noticename,
      notice: e.currentTarget.dataset.notice,
      noticeNameChange: '',
      noticeChange: '',
    });
  },

  hideModal() {
    this.setData({ isModalVisible: false });
  },

  onModalBackgroundTap(e) {
    if (e.target.id === 'modal') this.hideModal();
  },

  onNameInput(e) {
    this.setData({ noticeNameChange: e.detail.value });
  },

  onNoticeInput(e) {
    this.setData({ noticeChange: e.detail.value });
  },

  /** 弹窗确认 */
  confirmSelection() {
    if (this.data.isAdd) {
      this.insertNotice();
    } else {
      this.updateAll();
    }
  },

  /** 新增公告（默认 status=true，保存后立即展示） */
  insertNotice() {
    if (this._submitting) return; // 防止异步流程中重复提交
    const noticeName = this.data.noticeNameChange;
    const notice = this.data.noticeChange;
    if (!noticeName && !notice) {
      wx.showToast({ icon: 'error', title: '请填写内容' });
      return;
    }
    // 公告内容限长
    if (guard.tooLong(noticeName, 30) || guard.tooLong(notice, 1000)) {
      wx.showToast({ icon: 'error', title: '内容过长（标题30字/正文1000字内）' });
      return;
    }
    // 校验通过后才限频（防连点）：校验失败不消耗限频，改完可立即重提
    if (!guard.throttle('addNotice', 1500)) return;
    this._submitting = true;
    wx.showLoading({ title: '保存中...', mask: true });
    db.insertOne('Notice', { noticeName: guard.toText(noticeName), notice: guard.toText(notice), status: true })
      .then(() => {
        this._submitting = false;
        wx.hideLoading();
        wx.showToast({ icon: 'success', title: '操作成功' });
        this.hideModal();
        this.getNotice();
      })
      .catch((err) => {
        this._submitting = false;
        guard.resetThrottle('addNotice'); // 写库失败：重试不等待
        wx.hideLoading();
        console.error(err);
        wx.showToast({ icon: 'error', title: '操作失败' });
      });
  },

  /** 修改公告：判断哪些字段被改动，无变化则跳过 DB 写入 */
  updateAll() {
    const newName = this.data.noticeNameChange;
    const newNotice = this.data.noticeChange;
    const oldName = this.data.noticeName;
    const oldNotice = this.data.notice;
    // 空字段 = 用户未修改，用原值补上
    const finalName = newName !== '' ? newName : oldName;
    const finalNotice = newNotice !== '' ? newNotice : oldNotice;
    // 最终值和原值完全一致 → 无需写入，直接关闭弹窗
    if (finalName === oldName && finalNotice === oldNotice) {
      wx.showToast({ icon: 'none', title: '未做修改' });
      return;
    }
    this.setData({ noticeNameChange: finalName, noticeChange: finalNotice });
    this.updataNotice();
  },

  /** 保存公告修改 */
  updataNotice() {
    if (this._submitting) return; // 防止异步流程中重复提交
    if (guard.tooLong(this.data.noticeNameChange, 30) || guard.tooLong(this.data.noticeChange, 1000)) {
      wx.showToast({ icon: 'error', title: '内容过长（标题30字/正文1000字内）' });
      return;
    }
    // 校验通过后才限频（防连点）：校验失败不消耗限频，改完可立即重提
    if (!guard.throttle('upNotice', 1500)) return;
    this._submitting = true;
    wx.showLoading({ title: '保存中...', mask: true });
    db.updateOne('Notice', { _id: this.data._id }, {
      $set: {
        noticeName: guard.toText(this.data.noticeNameChange),
        notice: guard.toText(this.data.noticeChange),
      },
    }).then(() => {
      this._submitting = false;
      wx.hideLoading();
      wx.showToast({ icon: 'success', title: '操作成功' });
      this.hideModal();
      this.changeShowNotice(); // 同步更新列表显示
    }).catch((err) => {
      this._submitting = false;
      guard.resetThrottle('upNotice'); // 写库失败：重试不等待
      wx.hideLoading();
      console.error(err);
      wx.showToast({ icon: 'error', title: '操作失败' });
    });
  },

  /** 把修改结果同步到本地列表 */
  changeShowNotice() {
    const list = this.data.announcementList;
    const index = list.findIndex((item) => item._id === this.data._id);
    if (index > -1) {
      // 用 setField 写法（动态字段名），避免计算属性名触发 ES5 编译报错
      setField(this, 'announcementList[' + index + '].noticeName', this.data.noticeNameChange);
      setField(this, 'announcementList[' + index + '].notice', this.data.noticeChange);
    }
  },
});
