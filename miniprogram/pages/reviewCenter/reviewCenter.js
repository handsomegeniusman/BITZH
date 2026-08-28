// ============================================================
// pages/reviewCenter/reviewCenter.js —— 内容安全复核中心（仅管理员）
// 【作用】管理员集中处理三类待办：
//   1. 待复核内容（Review 中 type='review' & status='pending'，审核判「疑似」的已发布内容）
//   2. 举报（Report 中 status='pending'）：下架内容 / 封禁作者 / 忽略
//   3. 申诉（Appeal 中 status='pending'）：解封 / 驳回
//         所有下架/封禁都是软删除（取证留存，不物理删）。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const moderate = require('../../utils/moderate.js'); // 内容安全执行器（封禁/解封/下架/恢复，走云函数）
const guard = require('../../utils/guard.js'); // 前端保险工具（黑名单拦截/限频）

const SCENE_LABEL = { 1: '昵称', 2: '评论', 3: '推文' };

/** 时间格式化（Date → "YYYY-MM-DD HH:mm"），脏值返回空串 */
function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    tab: 1, // 0=待复核 1=举报 2=申诉
    reviews: [],
    reports: [],
    appeals: [],
    loaded: false,
    banId: '', // 快速封禁输入的用户ID
  },

  async onShow() {
    guard.ensureNotBanned();
    await db.initUserState();
    if (!app.globalData.isAdministrator) {
      wx.showToast({ title: '无权访问', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.loadAll();
  },

  switchTab(e) {
    this.setData({ tab: Number(e.currentTarget.dataset.tab) });
  },

  // ===== 快速封禁：输入用户ID直接封禁（配合飞书推送里的用户ID） =====
  onBanIdInput(e) {
    this.setData({ banId: e.detail.value });
  },

  async banById() {
    const userId = (this.data.banId || '').trim();
    if (!userId) {
      wx.showToast({ title: '请输入用户ID', icon: 'none' });
      return;
    }
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '确认封禁',
        content: '封禁用户：' + userId + '\n将软删其全部推文/评论并清退。',
        confirmColor: 'red',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    try {
      await moderate.ban(userId, '管理员手动封禁');
      this.setData({ banId: '' });
      wx.showToast({ title: '已封禁', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error('[reviewCenter] 快速封禁失败', err);
      wx.showToast({ title: '封禁失败', icon: 'none' });
    }
  },

  async unbanById() {
    const userId = (this.data.banId || '').trim();
    if (!userId) {
      wx.showToast({ title: '请输入用户ID', icon: 'none' });
      return;
    }
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '确认解封',
        content: '解封用户：' + userId + '\n将恢复其推文/评论可见并移出黑名单。',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    try {
      await moderate.unban(userId);
      this.setData({ banId: '' });
      wx.showToast({ title: '已解封', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error('[reviewCenter] 快速解封失败', err);
      wx.showToast({ title: '解封失败', icon: 'none' });
    }
  },

  /** 加载三类待办 */
  async loadAll() {
    wx.showLoading({ title: '加载中...', mask: true });
    try {
      const [reviews, reports, appeals] = await Promise.all([
        db.find('Review', { type: 'review', status: 'pending' }, { sort: { time: -1 }, limit: 50 }),
        db.find('Report', { status: 'pending' }, { sort: { time: -1 }, limit: 50 }),
        db.find('Appeal', { status: 'pending' }, { sort: { time: -1 }, limit: 50 }),
      ]);
      (reviews || []).forEach((r) => { r.sceneLabel = SCENE_LABEL[r.scene] || ''; r.timeText = fmtTime(r.time); });
      (reports || []).forEach((r) => { r.timeText = fmtTime(r.time); });
      (appeals || []).forEach((r) => { r.timeText = fmtTime(r.time); });
      this.setData({ reviews: reviews || [], reports: reports || [], appeals: appeals || [], loaded: true });
    } catch (e) {
      console.error('[reviewCenter] 加载失败', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
    wx.hideLoading();
  },

  // ===== 待复核：标记已处理 =====
  async ignoreReview(e) {
    await this.mark('Review', e.currentTarget.dataset.id, 'handled', '已标记处理');
  },

  // ===== 待复核：封禁作者（软删其全部内容 + 拉黑清退） =====
  async banReview(e) {
    const d = e.currentTarget.dataset;
    if (!d.authorid) {
      wx.showToast({ title: '无作者信息', icon: 'none' });
      return;
    }
    try {
      await moderate.ban(d.authorid, '内容违规');
      await db.updateOne('Review', { _id: d.id }, { $set: { status: 'handled', handledTime: new Date() } });
      wx.showToast({ title: '已封禁', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // ===== 举报：恢复内容（误报时恢复被自动下架的内容；举报时已自动软删） =====
  async restoreReport(e) {
    const d = e.currentTarget.dataset;
    try {
      await moderate.restore(d.type, d.targetid);
      await db.updateOne('Report', { _id: d.id }, { $set: { status: 'handled', handledTime: new Date() } });
      wx.showToast({ title: '已恢复', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // ===== 举报：封禁作者 =====
  async banReport(e) {
    const d = e.currentTarget.dataset;
    if (!d.authorid) {
      wx.showToast({ title: '无作者信息', icon: 'none' });
      return;
    }
    try {
      await moderate.ban(d.authorid, '被举报违规');
      await db.updateOne('Report', { _id: d.id }, { $set: { status: 'handled', handledTime: new Date() } });
      wx.showToast({ title: '已封禁', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // ===== 举报：忽略 =====
  async ignoreReport(e) {
    await this.mark('Report', e.currentTarget.dataset.id, 'handled', '已忽略');
  },

  // ===== 申诉：解封 =====
  async unbanAppeal(e) {
    const d = e.currentTarget.dataset;
    if (!d.userid) {
      wx.showToast({ title: '无用户信息', icon: 'none' });
      return;
    }
    try {
      await moderate.unban(d.userid);
      await db.updateOne('Appeal', { _id: d.id }, { $set: { status: 'handled', handledTime: new Date() } });
      wx.showToast({ title: '已解封', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // ===== 申诉：驳回 =====
  async rejectAppeal(e) {
    await this.mark('Appeal', e.currentTarget.dataset.id, 'rejected', '已驳回');
  },

  /** 通用：把某集合某条记录标记为已处理 */
  async mark(collection, _id, status, toastTitle) {
    try {
      await db.updateOne(collection, { _id }, { $set: { status: status, handledTime: new Date() } });
      wx.showToast({ title: toastTitle, icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },
});
