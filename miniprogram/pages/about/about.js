// ============================================================
// pages/about/about.js —— 关于页
// 【作用】展示社团介绍、联系方式、二维码、外部链接；
//        提供"看广告赚猫粮"的激励视频广告；管理员可进入后台。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const config = require('../../config.js'); // 全局配置（广告位 ID 等）

let videoAd = null; // 激励视频广告实例（首次点击时才创建）

Page({
  data: {
    url: app.globalData.url,
    blackNum: false, // 是否在黑名单中（黑名单用户显示"请离开"弹窗）
    popupAnimation: {}, // 弹窗动画对象（blackNumPopup 模板需要）
    screenWidth: 0,
    screenHeight: 0,
    imgwidth: 0,
    imgheight: 0,
  },

  /** 页面加载：初始化用户状态（保证管理员能进入后台），并检查黑名单 */
  async onLoad() {
    await db.initUserState();
    this.setData({ blackNum: await db.isBlacklisted() }); // 黑名单用户显示"请离开"弹窗
  },

  /** 页面显示：同步底部自定义 tabBar 选中态（关于=2） */
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
  },

  /** 按需创建激励视频广告实例（避免页面加载时触发广告组件报错） */
  createVideoAd() {
    if (!wx.createRewardedVideoAd) return null;
    const ad = wx.createRewardedVideoAd({ adUnitId: config.adUnitIds.video });
    ad.onError((err) => console.log('激励视频广告错误', err));
    return ad;
  },

  /** 点击"看广告赚猫粮" */
  showVideo() {
    wx.showModal({
      title: '观看广告赚猫粮',
      content: '您是否愿意观看广告以赚取猫粮？',
      success: (res) => {
        if (!res.confirm) return;
        if (!videoAd) videoAd = this.createVideoAd();
        if (!videoAd) return;
        videoAd.show().catch(() => {
          // 首次可能未加载好，加载后再展示
          videoAd.load()
            .then(() => videoAd.show())
            .catch((err) => console.log('激励视频广告显示失败', err));
        });
      },
    });
  },

  /** 关闭黑名单"请离开"弹窗 */
  hidePopup() {
    this.setData({ blackNum: false });
  },
  closePopup() {
    this.setData({ blackNum: false });
  },

  // ============ 复制联系方式（about 页内容，按需求保留） ============
  copyTBL() {
    wx.setClipboardData({ data: '18122371332' }); // 联系电话
  },
  copyTBL1() {
    wx.setClipboardData({ data: '1758906597@qq.com' }); // 邮箱
  },
  // ============ 预览二维码 ============
  previewQR1() {
    wx.previewImage({ urls: ['/pages/images/2weima.jpg'] }); // 二维码1
  },
  copyWechat() {
    wx.setClipboardData({ data: '北大猫协' }); // 公众号名
  },
  copyTBL4() {
    wx.setClipboardData({ data: 'https://gitee.com/circlelq/SCCAPKU-miniprogram?_from=gitee_search' }); // 开源链接
  },
  previewQR2() {
    wx.previewImage({ urls: ['/pages/images/twoweima.jpg'] }); // 二维码2
  },
  copyTBL6() {
    wx.previewImage({ urls: ['/pages/images/店铺.jpg'] }); // 店铺图片
  },

  /** 跳转合作小程序 */
  naviToMini() {
    wx.navigateToMiniProgram({
      appId: 'wx0fb7b06a5065be09',
      envVersion: 'release',
      success(res) {
        // 打开成功
      },
    });
  },

  /** 管理员进入后台 */
  edit() {
    if (app.globalData.isAdministrator) {
      wx.navigateTo({ url: '/pages/Administrator/Administrator' });
    }
  },

  /** 预览二维码大图 */
  previewImage() {
    wx.previewImage({
      urls: ['/pages/images/2weima.jpg'],
      current: '/pages/images/2weima.jpg',
    });
  },

  /** 转发给好友/群 */
  onShareAppMessage() {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/about/about',
    };
  },

  /** 转发到朋友圈 */
  onShareTimeline() {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/about/about',
    };
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    wx.stopPullDownRefresh();
  },
});
