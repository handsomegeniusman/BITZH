// ============================================================
// app.js —— 小程序入口文件
// 【作用】
//   1. 初始化阿里云 MPServerless 云开发后端（密钥等敏感信息在 config.js 中）
//   2. 小程序启动时：检查更新、静默登录授权、设置音频选项
//   3. 维护全局数据 globalData 和"页面数据监听器"（页面间同步用户信息）
// ============================================================

// 引入全局配置（私密信息都集中在 config.js，方便替换）
const config = require('./config.js');
import MPServerless from '@alicloud/mpserverless-sdk';

// 初始化阿里云 MPServerless 客户端
// 注意：clientSecret 放在前端会有被反编译的风险，正式上线建议改用云函数
const mpServerless = new MPServerless({
  uploadFile: wx.uploadFile,
  request: wx.request,
  getAuthCode: wx.login,
  getFileInfo: wx.getFileInfo,
  getImageInfo: wx.getImageInfo,
}, {
  appId: config.serverless.appId,
  spaceId: config.serverless.spaceId,
  clientSecret: config.serverless.clientSecret,
  endpoint: config.serverless.endpoint,
});

App({
  /** 小程序启动时执行 */
  onLaunch: async function () {
    this.checkForUpdates();       // 检查是否有新版本
    await this.authorizeUser();   // 静默登录授权（获取用户 openid）
    this.setAudioOptions();       // 设置音频播放选项
  },

  /** 检查小程序是否有新版本 */
  checkForUpdates: function () {
    if (wx.canIUse('getUpdateManager')) {
      const updateManager = wx.getUpdateManager();
      updateManager.onCheckForUpdate(res => {
        if (res.hasUpdate) {
          updateManager.onUpdateReady(() => {
            wx.showModal({
              title: '更新提示',
              content: '新版本已经准备好，是否重启应用？',
              success: res => {
                if (res.confirm) {
                  updateManager.applyUpdate();
                }
              }
            });
          });
          updateManager.onUpdateFailed(() => {
            wx.showModal({
              title: '已经有新版本了哟~',
              content: '新版本已经上线啦~，请您删除当前小程序，重新搜索打开哟~'
            });
          });
        }
      });
    } else {
      wx.showModal({
        title: '提示',
        content: '当前微信版本过低，无法使用该功能，请升级到最新微信版本后重试。'
      });
    }
  },

  /** 静默授权登录（获取用户身份）；失败时提示用户重启 */
  authorizeUser: async function () {
    try {
      await mpServerless.user.authorize({
        authProvider: 'wechat_openapi',
      });
    } catch (e) {
      console.error('授权登录失败', e);
      wx.showModal({
        title: '登录失败',
        content: '获取用户信息失败，请退出小程序后重新打开',
        showCancel: false,
      });
    }
  },

  /** 设置音频：后台播放时也遵守静音开关关闭的选项 */
  setAudioOptions: function () {
    wx.setInnerAudioOption({
      obeyMuteSwitch: false
    });
  },

  mpServerless, // 云开发客户端，页面通过 app.mpServerless 使用

  globalData: {
    userId: '',               // 当前用户 openid（由 utils/db.js 填充）
    isAdministrator: false,   // 当前用户是否为管理员
    Administrator: undefined, // 管理员姓名
    isFeeder: false,          // 当前用户是否已注册用户资料
    userInfo: {},             // 当前用户在 Feeder 表中的资料（昵称、头像等）
    url: config.imageUrl,     // 图片访问根地址（从 config 读取）
    pageDataListeners: [],    // 页面数据监听器列表（用于用户信息变化时同步到各页面）
  },

  /** 添加页面数据监听器（页面 onLoad 时注册，用于接收用户信息更新） */
  addPageDataListener: function (listener) {
    if (typeof listener !== 'function') return;
    if (this.globalData.pageDataListeners.indexOf(listener) >= 0) return; // 防重复注册
    this.globalData.pageDataListeners.push(listener);
  },

  /** 移除页面数据监听器（页面 onUnload 时调用，防止内存泄漏） */
  removePageDataListener: function (listener) {
    const idx = this.globalData.pageDataListeners.indexOf(listener);
    if (idx >= 0) {
      this.globalData.pageDataListeners.splice(idx, 1);
    }
  },

  /** 通知所有页面监听器：用户信息已更新 */
  notifyPageDataListeners: function (updatedUserInfo) {
    // 复制一份再遍历，避免回调中触发 removePageDataListener 影响遍历
    const listeners = this.globalData.pageDataListeners.slice();
    for (const listener of listeners) {
      try {
        listener(updatedUserInfo);
      } catch (e) {
        console.error('页面数据监听器执行出错', e);
      }
    }
  },
});

// 开启分享（允许转发给好友/群）
wx.showShareMenu({
  withShareTicket: true
});
