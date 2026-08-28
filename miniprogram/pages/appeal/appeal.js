// ============================================================
// pages/appeal/appeal.js —— 申诉页（误封申诉通道，必须有）
// 【作用】被封禁用户填写申诉说明 + 联系方式 → 写入 Appeal 集合 + 推飞书通知管理员。
//         管理员在复核中心可「解封」或「驳回」。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const guard = require('../../utils/guard.js'); // 前端保险工具（限长）
const config = require('../../config.js'); // 全局配置（管理员邮箱）
const privacy = require('../../utils/privacy.js'); // 隐私授权通用拦截（复制到剪贴板前按需弹合规授权弹窗）

Page({
  data: {
    email: config.adminEmail || '', // 兜底客服邮箱（复制直达）
    userId: '',
    detail: '',    // 申诉说明
    contact: '',   // 联系方式（手机/邮箱，选填）
    submitting: false,
  },

  async onLoad() {
    await db.initUserState();
    this.setData({ userId: app.globalData.userId || '' });
  },

  onDetailInput(e) {
    this.setData({ detail: e.detail.value });
  },

  onContactInput(e) {
    this.setData({ contact: e.detail.value });
  },

  /** 复制管理员邮箱（wx.setClipboardData 是隐私接口：未同意隐私指引先弹合规授权弹窗） */
  copyEmail() {
    privacy.guard(this, () => {
      wx.setClipboardData({
        data: this.data.email,
        success: () => wx.showToast({ title: '已复制邮箱', icon: 'success' }),
      });
    });
  },

  /** 提交申诉 */
  async submit() {
    if (this.data.submitting) return;
    const detail = (this.data.detail || '').trim();
    if (!detail) {
      wx.showToast({ title: '请填写申诉说明', icon: 'none' });
      return;
    }
    if (guard.tooLong(detail, 500)) {
      wx.showToast({ title: '说明过长（500字以内）', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      // 永久拉黑检查：已被拉黑的用户不再受理申诉
      const bn = await db.find('BlackNum', { id: this.data.userId }, { limit: 10 });
      const permanent = (bn || []).some(function (r) { return !!r.permanent; });
      if (permanent) {
        wx.showToast({ title: '你已被永久拉黑，无法申诉', icon: 'none' });
        this.setData({ submitting: false });
        return;
      }

      await db.insertOne('Appeal', {
        userId: this.data.userId,
        detail: detail,
        contact: String(this.data.contact || '').slice(0, 50),
        status: 'pending',
        time: new Date(),
      });

      // 取被封禁内容快照（推文取 tittle+main，评论取 main），供管理员快速判断
      let bannedContent = '';
      try {
        const pages = await db.find('Page', { authorId: this.data.userId, hidden: true }, { limit: 3 });
        const comments = await db.find('Comment', { authorId: this.data.userId, deleted: true }, { limit: 3 });
        const parts = [];
        (pages || []).forEach(function (p) {
          if (p) parts.push(((p.tittle || '') + (p.main ? ' ' + p.main : '')).trim());
        });
        (comments || []).forEach(function (c) {
          if (c && c.main) parts.push(String(c.main));
        });
        bannedContent = parts.filter(Boolean).slice(0, 3)
          .map(function (x) { return String(x).slice(0, 40); })
          .join(' / ');
      } catch (e) {
        console.error('[appeal] 取被封内容失败', e && e.message);
      }

      // 通知管理员（复用 secCheck 云函数 notify 模式；失败不影响申诉入库）
      try {
        // 2026-08-28 飞书推送附昵称：管理员一眼认出是谁（与举报/审核推送对齐）
        const nick = (app.globalData.userInfo && app.globalData.userInfo.nickName) || '';
        const text = '【申诉】用户申请解封' +
          '\n用户昵称：' + (nick || '（未填写）') +
          '\n用户ID：' + this.data.userId +
          '\n联系方式：' + (String(this.data.contact || '').trim() || '无') +
          '\n说明：' + detail.slice(0, 200) +
          (bannedContent ? '\n被封禁内容：' + bannedContent : '') +
          '\n——————' +
          '\n评论区回复：' +
          '\n· 解封用户 = 解除黑名单（账号可再发帖）' +
          '\n· 全部解封 = 解除黑名单 + 恢复全部内容' +
          '\n· 拉黑用户 = 永久拉黑（不再受理）';
        await app.mpServerless.function.invoke('secCheck', { action: 'notify', text: text });
      } catch (e) {
        console.error('[appeal] 申诉通知推送失败', e && e.message);
      }
      wx.showToast({ title: '申诉已提交', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    }
    this.setData({ submitting: false });
  },
});
