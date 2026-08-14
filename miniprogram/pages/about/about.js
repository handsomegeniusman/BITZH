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
    console.log('[about] onLoad 开始');
    // 用户状态查询失败不能阻塞页面加载（否则 switchTab 超时、页面灰屏）
    try {
      await db.initUserState();
      console.log('[about] initUserState OK, isAdministrator=', app.globalData.isAdministrator, 'isFeeder=', app.globalData.isFeeder);
    } catch (e) {
      console.error('[about] initUserState 失败（不影响页面显示）', e);
    }
    try {
      const blackNum = await db.isBlacklisted(); // 黑名单用户禁止访问任何页面，直接清退
      console.log('[about] isBlacklisted =', blackNum);
      if (blackNum) wx.reLaunch({ url: '/pages/banned/banned' });
    } catch (e) {
      console.error('[about] isBlacklisted 失败（不影响页面显示）', e);
    }
    console.log('[about] onLoad 完成');
  },

  /** 页面显示：同步底部自定义 tabBar 选中态（关于=2） */
  onShow() {
    console.log('[about] onShow 触发');
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
      if (typeof this.getTabBar().refreshAudit === 'function') this.getTabBar().refreshAudit();
    }
  },

  /** 按需创建激励视频广告实例（避免页面加载时触发广告组件报错） */
  createVideoAd() {
    if (!wx.createRewardedVideoAd) return null;
    const ad = wx.createRewardedVideoAd({ adUnitId: config.adUnitIds.video });
    ad.onError((err) => console.log('激励视频广告错误', err));
    // 看完广告后把结果同步给用户：完整观看才算数，中途退出不给奖励，两种结果都要明确提示
    ad.onClose((res) => {
      const isEnded = !!(res && res.isEnded);
      console.log('[about.videoAd.onClose] 是否完整观看 isEnded=', isEnded, res);
      if (isEnded) {
        wx.showToast({ title: '观看完成，赞助收益已计入', icon: 'success', duration: 2000 });
      } else {
        wx.showToast({ title: '未完整观看，本次不计入赞助', icon: 'none', duration: 2000 });
      }
    });
    return ad;
  },

  /** 点击"看广告赚猫粮" */
  showVideo() {
    wx.showModal({
      title: '观看广告赚猫粮',
      content: '完整观看广告后，赞助收益将计入流浪猫救助经费',
      success: (res) => {
        if (!res.confirm) return;
        if (!videoAd) videoAd = this.createVideoAd();
        if (!videoAd) return;
        videoAd.show().catch(() => {
          // 首次可能未加载好，加载后再展示
          videoAd.load()
            .then(() => videoAd.show())
            .catch((err) => {
              console.log('激励视频广告显示失败', err);
              wx.showToast({ title: '广告暂不可用，请稍后再试', icon: 'none' });
            });
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

  /** 黑名单弹窗兜底：去申诉页（正常情况下黑名单用户会被 reLaunch 到 banned 页） */
  goAppeal() {
    wx.navigateTo({ url: '/pages/appeal/appeal' });
  },

  // ============ 复制联系方式（about 页内容，按需求保留） ============
  // 统一封装：成功/失败都明确反馈（真机上系统自带的"已复制"提示可能不显示，
  // 所以这里主动 showToast，并打日志方便排查真机点击无反应的问题）。
  // 失败时（尤其 iOS 报 setClipboardData:fail:system permission denied / errno 3）：
  // 先查 scope.clipboard 授权状态 → 引导用户去小程序设置里打开剪贴板权限，或重试。
  _copy(data, label) {
    console.log('[about._copy] 点击复制', label, data);
    wx.setClipboardData({
      data: data,
      success: () => {
        console.log('[about._copy] 复制成功', label);
        wx.showToast({ title: '已复制', icon: 'success' });
      },
      fail: (err) => {
        console.error('[about._copy] 复制失败', label, err);
        this._copyFail(data, label);
      },
    });
  },

  /** 复制失败后的引导：判断剪贴板权限状态，给出可操作路径（去设置 / 重试） */
  _copyFail(data, label) {
    // 1) 查权限：authSetting['scope.clipboard'] === false 表示用户在小程序设置里关掉了剪贴板
    wx.getSetting({
      success: (res) => {
        const denied = !!(res.authSetting && res.authSetting['scope.clipboard'] === false);
        console.log('[about._copyFail] 剪贴板权限状态 authSetting=', res.authSetting, 'denied=', denied);
        wx.showModal({
          title: '复制失败',
          content: denied
            ? '剪贴板权限被关闭了，点击「去设置」打开后即可正常复制。'
            : '系统未允许写入剪贴板（iOS 首次复制会弹系统授权，需点「允许粘贴」）。点击「去设置」开启，或点「重试」再试一次。',
          confirmText: '去设置',
          cancelText: '重试',
          success: (r) => {
            if (r.confirm) {
              // 2) 打开小程序设置页，用户手动打开"剪贴板"开关
              wx.openSetting({
                success: (s) => {
                  console.log('[about._copyFail] openSetting 返回', s.authSetting);
                  // 用户回来时剪贴板已允许 → 自动重试复制，省得再点一次
                  const allowed = !!(s.authSetting && s.authSetting['scope.clipboard'] !== false);
                  if (allowed) {
                    console.log('[about._copyFail] 权限已开启，自动重试复制', label);
                    this._copy(data, label);
                  } else {
                    wx.showToast({ title: '剪贴板权限未开启', icon: 'none' });
                  }
                },
                fail: (e) => console.error('[about._copyFail] openSetting 失败', e),
              });
            } else {
              // 3) 重试：用户刚点了系统"允许粘贴"后再复制一次
              console.log('[about._copyFail] 用户选择重试', label);
              this._copy(data, label);
            }
          },
        });
      },
      // 连 getSetting 都失败（极端情况）：兜底提示，不阻塞
      fail: () => {
        console.error('[about._copyFail] getSetting 失败');
        wx.showToast({ title: '复制失败，请长按手动复制', icon: 'none' });
      },
    });
  },
  copyTBL() {
    this._copy('18122371332', '联系电话'); // 联系电话
  },
  copyTBL1() {
    this._copy('1758906597@qq.com', '邮箱'); // 邮箱
  },
  copyWechat() {
    this._copy('北大猫协', '公众号名'); // 公众号名
  },
  copyTBL4() {
    this._copy('https://gitee.com/circlelq/SCCAPKU-miniprogram', '原项目 Gitee 链接'); // 原项目（北大猫协）开源链接
  },
  copyGithub() {
    this._copy('https://github.com/handsomegeniusman/BITZH', 'GitHub 开源仓库'); // 作者 GitHub 仓库
  },
  copyGitee() {
    this._copy('https://gitee.com/handsomejenius2', 'Gitee 开源仓库'); // 作者 Gitee 仓库
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
