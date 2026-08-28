// ============================================================
// pages/mydetail/mydetail.js —— 我的（帖子历史 + 回收站）
// 【作用】普通用户查看并管理自己发布过的内容：
//        - 「历史」分栏：我创建/编辑且仍存在的帖子，单击卡片像小猫书一样看详情，
//          长按卡片或点「编辑」按钮进编辑页修改；
//        - 「回收站」分栏：我删除过的帖子（Delete 存档），单击卡片进 bookletDetail
//          回收站预览（只读展示被删内容，可点「编辑/恢复」进恢复模式）；长按卡片
//          或点「编辑」按钮直接进编辑页恢复模式（重新编辑后保存即恢复、
//          或彻底删除存档、或返回取消）。
//        两个分栏卡片统一样式（大图 + 标题 + 编辑按钮），交互统一：单击看详情、
//        长按或点编辑进编辑页。列表分页/存档映射复用公共模块
//        （db.paginate 分页 + utils/trash.js 回收站逻辑）。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const trash = require('../../utils/trash.js'); // 回收站公共逻辑（列表映射/恢复）

Page({
  data: {
    userId: '',
    audit: false,          // 是否开放注册（管理员后台开关）
    blackNum: false,       // 是否在黑名单中
    popupAnimation: {},    // 弹窗动画对象（blackNumPopup 模板需要）
    navbar: ['历史', '回收站'], // 顶部两个分栏
    currentTab: 0,
    url: app.globalData.url,
    urlPage: app.globalData.url + 'page/', // 帖子图片目录地址
    isFeeder: false,
    isAdministrator: false, // 当前用户是否为管理员（控制「发官方推文」按钮）
    userInfo: {},
    myPosts: [],           // 我发布且仍存在的帖子（历史分栏）
    trashList: [],         // 我删除过的帖子存档（回收站分栏）
    displayAvatarUrl: '/pages/images/logo.png',  // 我的头像（默认占位，initUser 后更新为真实头像）
    displayNickName: '',   // 我的昵称
  },

  /** 顶部状态栏切换 */
  navbarTap: function (e) {
    this.setData({ currentTab: e.currentTarget.dataset.idx });
  },

  /** 页面加载 */
  async onLoad(options) {
    console.log('[mydetail] onLoad 开始');
    // 审核开关：是否开放注册
    try {
      this.setData({ audit: await db.getAudit() });
      console.log('[mydetail] getAudit =', this.data.audit);
    } catch (e) {
      console.error('[mydetail] getAudit 失败（不影响页面显示）', e);
    }
    // 支持分享链接直接打开对应分栏（解析并钳制到有效范围）
    if (options && options.currentTab !== undefined) {
      let tab = parseInt(options.currentTab, 10);
      if (isNaN(tab)) tab = 0;
      this.setData({ currentTab: Math.max(0, Math.min(tab, this.data.navbar.length - 1)) });
    }
    // 获取用户状态（管理员/已注册用户）；失败不能阻塞页面加载（否则 switchTab 超时、灰屏）
    try {
      await this.initUser();
      console.log('[mydetail] initUser OK');
    } catch (e) {
      console.error('[mydetail] initUser 失败（不影响页面显示）', e);
    }
    // 黑名单检查
    try {
      const blackNum = await db.isBlacklisted();
      if (blackNum) {
        wx.reLaunch({ url: '/pages/banned/banned' }); // 黑名单用户禁止访问任何页面
        return;
      }
    } catch (e) {
      console.error('[mydetail] isBlacklisted 失败（不影响页面显示）', e);
    }
    console.log('[mydetail] onLoad 完成');
    // 监听用户资料变化（注册/修改资料后自动刷新头像昵称）
    this._pageDataListener = (updatedUserInfo) => {
      if (updatedUserInfo && updatedUserInfo.avatarUrl) {
        this.setData({
          displayAvatarUrl: updatedUserInfo.avatarUrl,
          displayNickName: updatedUserInfo.nickName,
        });
      }
    };
    app.addPageDataListener(this._pageDataListener);
    this._initialized = true; // onLoad 已加载列表；首次 onShow（紧随 onLoad）靠此跳过重复加载
  },

  /** 每次进入本页（含从其他 tab 切回）都刷新列表：编辑/删除后回来能看到最新状态。
   *  先清空再加载——paginate 是"只追加不删除"的，不清空的话已删除的帖子会一直留在列表里。 */
  onShow() {
    console.log('[mydetail] onShow 触发');
    // 同步底部自定义 tabBar 选中态（我的=3），置于刷新逻辑之前
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
      if (typeof this.getTabBar().refreshAudit === 'function') this.getTabBar().refreshAudit();
    }
    if (!this._initialized) return; // 首次进入由 onLoad 加载过了
    this.setData({ myPosts: [], trashList: [] });
    this.loadMyPosts();
    this.loadTrash();
  },

  /** 页面卸载：移除监听器，防止内存泄漏和向已销毁页面 setData */
  onUnload() {
    if (this._pageDataListener && typeof app.removePageDataListener === 'function') {
      app.removePageDataListener(this._pageDataListener);
      this._pageDataListener = null;
    }
  },

  /** 获取当前用户状态并加载我的帖子 + 回收站 */
  async initUser() {
    await db.initUserState();
    this.setData({
      userId: app.globalData.userId,
      isFeeder: app.globalData.isFeeder,
      isAdministrator: app.globalData.isAdministrator,
      userInfo: app.globalData.userInfo || {},
    });
    if (app.globalData.isFeeder) {
      this.setData({
        displayAvatarUrl: app.globalData.userInfo.avatarUrl,
        displayNickName: app.globalData.userInfo.nickName,
      });
    }
    // 按 userId 过滤加载，与投喂身份无关
    this.loadMyPosts();
    this.loadTrash();
  },

  /** 发官方推文（仅管理员；入口按钮在 WXML 按 isAdministrator 显示） */
  addOfficial() {
    wx.navigateTo({ url: '/pages/addOfficial/addOfficial' });
  },

  /** 点击头像/注册按钮 */
  editMessage() {
    wx.showModal({
      content: '请确认您已阅读并同意信息收集说明',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({ url: '/pages/regist/regist?userId=' + this.data.userId });
        }
      }
    });
  },

  // ============ 历史分栏：我的帖子 ============

  /** 加载"我发布且仍存在的帖子"（按作者 openid 过滤，最新发布在前） */
  loadMyPosts() {
    const userId = app.globalData.userId;
    if (!userId) return;
    db.paginate('Page', { authorId: userId }, { sort: { pageTime: -1 }, limit: 10 }, this.data.myPosts)
      .then(list => this.setData({
        myPosts: db.filterHidden(list).map(p => Object.assign({}, p, {
          // 首图：官方推文（officialLogo）→ 包内 logo；否则按标题拼自有首图
          picUrl: p.officialLogo ? '/pages/images/logo.png' : this.data.urlPage + p.tittle + '0.jpg',
          // 张数：logo 不算进 photoNum，展示时补回 1
          meta: (p.photoTime || '') + ' · ' + ((p.officialLogo ? 1 : 0) + (p.photoNum || 0)) + ' 张',
        })),
      }))
      .catch(err => { console.error('加载我的帖子失败', err); wx.showToast({ icon: 'none', title: '加载失败，下拉重试' }); });
  },

  /** 历史分栏触底：加载更多 */
  loadMoreMyPosts() {
    this.loadMyPosts();
  },

  /** 单击帖子卡片 → 像小猫书一样查看详情（bookletDetail），不直接编辑 */
  toBookletDetail(e) {
    const _id = e.currentTarget.dataset.id;
    if (!_id) return;
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?_id=' + _id });
  },

  /** 编辑：长按卡片 / 点卡片上的「编辑」按钮 → 进入编辑页（作者可修改自己帖子） */
  toEditPost(e) {
    const _id = e.currentTarget.dataset.id;
    if (!_id) return;
    wx.navigateTo({ url: '/pages/editBooklet/editBooklet?_id=' + _id });
  },

  // ============ 回收站分栏：我删除过的帖子 ============

  /** 加载"我删除过的帖子"（Delete 存档按 operatorId 过滤，最新删除在前） */
  loadTrash() {
    const userId = app.globalData.userId;
    if (!userId) return;
    db.paginate(trash.DELETE_COLLECTION, { operatorId: userId }, { sort: { editTime: -1 }, limit: 20 }, this.data.trashList)
      .then(list => this.setData({
        trashList: list.map(trash.mapTrashItem).map(r => Object.assign({}, r, {
          picUrl: r.photoUrls.length ? r.photoUrls[0] : '', // 存档首图（无照片则为空→占位）
          meta: '删除于 ' + r.timeText + (r.operator ? ' · ' + r.operator : ''),
        })),
      }))
      .catch(err => { console.error('加载我的回收站失败', err); wx.showToast({ icon: 'none', title: '加载失败，下拉重试' }); });
  },

  /** 回收站分栏触底：加载更多 */
  loadMoreTrash() {
    this.loadTrash();
  },

  /** 回收站：单击卡片 → 进入 bookletDetail 回收站预览（只读展示被删内容） */
  toRecoverPreview(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?mode=recover&_id=' + id });
  },

  /** 回收站：长按卡片 / 点「编辑」→ 进入编辑页恢复模式。
   *  恢复模式载入被删内容，可重新编辑后保存（即恢复推文）、
   *  或彻底删除存档、或返回取消。 */
  toRecoverPost(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/editBooklet/editBooklet?mode=recover&_id=' + id });
  },

  // 点击空白处（隐藏搜索/列表，本页为兼容保留）
  onPageTap() {
    this.setData({ showResult: false, showList: false });
  },
  /** 关闭黑名单"请离开"弹窗 */
  hidePopup() {
    this.setData({ blackNum: false });
  },
  /** 关闭黑名单弹窗（按钮回调） */
  closePopup() {
    this.setData({ blackNum: false });
  },

  /** 黑名单弹窗兜底：去申诉页（正常情况下黑名单用户会被 reLaunch 到 banned 页） */
  goAppeal() {
    wx.navigateTo({ url: '/pages/appeal/appeal' });
  },

  /** 转发给好友/群 */
  onShareAppMessage: function () {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/mydetail/mydetail?currentTab=' + this.data.currentTab,
    };
  },

  /** 转发到朋友圈 */
  onShareTimeline: function () {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/mydetail/mydetail?currentTab=' + this.data.currentTab,
    };
  },
});
