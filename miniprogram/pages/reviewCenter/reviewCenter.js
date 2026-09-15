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

/**
 * 危险操作二次确认：弹窗点「确认」返回 true，点取消 / 弹窗失败返回 false。
 * 【为什么包 Promise】wx.showModal 是回调式 API，包成 Promise 才能用 await 直线写。
 * 【调用约定】确认之后才调 guard.throttle，且必须写成
 *   `if (!guard.throttle(label, ms)) return;`
 *   —— 一是取消弹窗不该消耗限频窗口（项目约定），
 *      二是 throttle 被拦时只弹提示、**不会**阻止后续代码，不判返回值就形同虚设。
 */
function confirmAction(title, content, confirmText, confirmColor) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title,
      content: content,
      confirmText: confirmText || '确认',
      confirmColor: confirmColor || '#FF405E',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
}

/**
 * 校验云函数返回。moderate.* 返回云函数的 { ok, ... }，ok 为 false 表示服务端没执行成功。
 * 【为什么必须查】不查的话，云函数返回 {ok:false} 时页面仍会弹「已封禁」/「已恢复」——
 *   提示与实际不符。这里抛错，交给各 handler 既有的 catch 统一弹「操作失败」。
 * 用 === false 而不是 !res.ok，是为了容忍没带 ok 字段的旧返回（视为成功）。
 */
function ensureOk(res) {
  if (res && res.ok === false) throw new Error(res.msg || '云函数返回失败');
  return res;
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
  // 【为什么没有二次确认】它只把 status 置为 handled，不恢复、不下架、不封禁、不写黑名单，
  //   误点代价仅是一条从待办列表消失。这是有意豁免，不是漏加 —— 复核台常要批量关单，
  //   给纯关单操作也套弹窗会明显拖慢处理速度。（「忽略」同理，见 ignoreReport。）
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
    const confirmed = await confirmAction(
      '确认封禁',
      '封禁作者：' + (d.author || d.authorid) + '\n将软删其全部推文/评论并移出列表（内容留存备查）。',
      '封禁', 'red'
    );
    if (!confirmed) return; // 取消：不做任何操作，也不消耗节流窗口
    if (!guard.throttle('reviewBan', 1500)) return; // 限频命中：throttle 已弹提示，直接收手
    try {
      ensureOk(await moderate.ban(d.authorid, '内容违规'));
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
    const confirmed = await confirmAction(
      '确认恢复',
      '恢复被下架的内容？\n该内容将重新对所有人可见，这条举报记为已处理。',
      '恢复'
    );
    if (!confirmed) return; // 取消：不做任何操作
    if (!guard.throttle('reviewRestore', 1500)) return; // 限频命中：throttle 已弹提示，直接收手
    try {
      ensureOk(await moderate.restore(d.type, d.targetid));
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
    const confirmed = await confirmAction(
      '确认封禁',
      '封禁作者：' + (d.author || d.authorid) + '\n将软删其全部推文/评论并移出列表（内容留存备查）。',
      '封禁', 'red'
    );
    if (!confirmed) return; // 取消：不做任何操作
    if (!guard.throttle('reviewBan', 1500)) return; // 限频命中：throttle 已弹提示，直接收手
    try {
      ensureOk(await moderate.ban(d.authorid, '被举报违规'));
      await db.updateOne('Report', { _id: d.id }, { $set: { status: 'handled', handledTime: new Date() } });
      wx.showToast({ title: '已封禁', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // ===== 举报：忽略 =====
  // 【为什么没有二次确认】同 ignoreReview：纯关单、无副作用，有意豁免。
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
    const confirmed = await confirmAction(
      '确认解封',
      '解封用户：' + d.userid + '\n将恢复其推文/评论可见并移出黑名单。',
      '解封'
    );
    if (!confirmed) return; // 取消：不做任何操作
    if (!guard.throttle('reviewUnban', 1500)) return; // 限频命中：throttle 已弹提示，直接收手
    try {
      ensureOk(await moderate.unban(d.userid));
      await db.updateOne('Appeal', { _id: d.id }, { $set: { status: 'handled', handledTime: new Date() } });
      wx.showToast({ title: '已解封', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error(err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // ===== 申诉：驳回 =====
  // 【文案必须与实际行为一致】这里只把 Appeal.status 置为 'rejected'（仅关单），
  //   不调用 moderate 云函数、不写黑名单。弹窗文案据此如实描述，不要让管理员
  //   以为点一下就把人永久拉黑了。若要改成真拉黑，必须先改行为再改文案。
  async rejectAppeal(e) {
    const id = e.currentTarget.dataset.id;
    const confirmed = await confirmAction(
      '确认驳回',
      '驳回这条申诉？\n仅驳回本次申诉，不会拉黑该作者，作者可再次提交申诉。',
      '驳回'
    );
    if (!confirmed) return; // 取消：不做任何操作
    if (!guard.throttle('reviewReject', 1500)) return; // 限频命中：throttle 已弹提示，直接收手
    await this.mark('Appeal', id, 'rejected', '已驳回');
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
