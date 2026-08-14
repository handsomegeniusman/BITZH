// ============================================================
// pages/report/report.js —— 举报页
// 【作用】用户举报违规推文/评论：填写理由 → 写入 Report 集合 + 推飞书通知管理员。
//         同一用户对同一目标 24h 内限举报 1 次（utils/report.js 内校验）。
// ============================================================
const report = require('../../utils/report.js'); // 举报公共逻辑（写库 + 通知）
const guard = require('../../utils/guard.js'); // 前端保险工具（限长）

Page({
  data: {
    type: 'page',        // page=推文 comment=评论
    targetId: '',
    content: '',         // 被举报内容快照（只读展示）
    targetAuthorId: '',
    reason: '',          // 举报理由
    submitting: false,
    reasonTags: ['赌博/诱导', '色情低俗', '广告引流', '虚假信息', '人身攻击', '涉政/谣言', '其他'],
  },

  onLoad(options) {
    const type = options.type === 'comment' ? 'comment' : 'page';
    this.setData({
      type: type,
      targetId: options.targetId || '',
      content: decodeURIComponent(options.content || ''),
      targetAuthorId: options.targetAuthorId || '',
    });
    wx.setNavigationBarTitle({ title: type === 'comment' ? '举报评论' : '举报推文' });
  },

  onReasonInput(e) {
    this.setData({ reason: e.detail.value });
  },

  /** 点选常见类型：自动填入理由（用户可再补充细节） */
  onReasonTag(e) {
    const tag = e.currentTarget.dataset.tag;
    if (tag) this.setData({ reason: tag });
  },

  /** 提交举报 */
  async submit() {
    if (this.data.submitting) return;
    const reason = (this.data.reason || '').trim();
    if (!reason) {
      wx.showToast({ title: '请填写举报理由', icon: 'none' });
      return;
    }
    if (guard.tooLong(reason, 200)) {
      wx.showToast({ title: '理由过长（200字以内）', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const r = await report.submitReport({
      targetType: this.data.type,
      targetId: this.data.targetId,
      content: this.data.content,
      reason: reason,
      targetAuthorId: this.data.targetAuthorId,
    });
    this.setData({ submitting: false });
    if (r.ok) {
      wx.showToast({ title: '举报已提交', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } else if (r.reason === 'duplicate') {
      wx.showToast({ title: '24小时内已举报过该内容', icon: 'none' });
    } else if (r.reason === 'too_long') {
      wx.showToast({ title: '理由过长（200字以内）', icon: 'none' });
    } else {
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    }
  },
});
