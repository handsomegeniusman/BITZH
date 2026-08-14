// ============================================================
// pages/banned/banned.js —— 全屏封禁页（禁止访问任何页面）
// 【作用】黑名单用户打开任意 tab 页会被 reLaunch 到本页，
//         无 tabBar、无法返回，只有「申诉」与「管理员邮箱」两个出口。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const config = require('../../config.js'); // 全局配置（管理员邮箱）

Page({
  data: {
    email: config.adminEmail || '',
    reason: '', // 封禁原因（从 BlackNum 读取，供用户了解）
    userId: '',
  },

  async onLoad() {
    await db.initUserState();
    const userId = app.globalData.userId || '';
    this.setData({ userId });
    try {
      const rec = await db.findOne('BlackNum', { id: userId });
      if (rec && rec.reason) this.setData({ reason: rec.reason });
    } catch (e) {
      console.error('[banned] 读取封禁原因失败', e);
    }
  },

  /** 去申诉页 */
  goAppeal() {
    wx.navigateTo({ url: '/pages/appeal/appeal' });
  },

  /** 复制管理员邮箱 */
  copyEmail() {
    wx.setClipboardData({
      data: this.data.email,
      success: () => wx.showToast({ title: '已复制邮箱', icon: 'success' }),
    });
  },
});
