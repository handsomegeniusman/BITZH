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
//        - 已注册用户额外看到一个「申请发送帖子」按钮（发布权收紧成申请-审批制后的入口），
//          三态见 loadApplyState()。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const trash = require('../../utils/trash.js'); // 回收站公共逻辑（列表映射/恢复）
const guard = require('../../utils/guard.js'); // 前端保险工具（防连点限频）

/** 可申请状态下的按钮文案（三态里的默认态，改文案只改这一处） */
const APPLY_TEXT = '申请发送帖子';

/**
 * 危险操作二次确认：弹窗点「确认」返回 true，点取消 / 弹窗失败返回 false。
 * 【为什么包 Promise】wx.showModal 是回调式 API，包成 Promise 才能用 await 直线写。
 * 【调用约定】确认之后才调 guard.throttle —— 取消弹窗不该消耗限频窗口（项目约定）。
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
 * 北京时间当天键（YYYY-MM-DD）。
 * 【为什么要自己算】与云函数 postApply / adminManage 里的同名函数保持同一口径：
 *   按 UTC+8 切日，而不是按设备时区。设备时区一旦不是东八区，"今天已被拒绝"的
 *   判断就会和云函数里写进 dayKey 的那天错开。
 */
function beijingDayKey(d) {
  const t = d ? d.getTime() : Date.now();
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 调 postApply 云函数提交申请。
 * 【只做一件事】把请求发出去并解包 res.result，失败原因（NOT_FEEDER / BLACKLISTED /
 *   ALREADY_APPLIED_TODAY …）由云函数给出中文 msg，客户端直接展示，不在这里重写一套文案。
 */
function invokeApply() {
  const mp = app && app.mpServerless;
  if (!mp || !mp.function) return Promise.reject(new Error('云函数不可用'));
  return mp.function.invoke('postApply', { action: 'apply' })
    .then(function (res) {
      return (res && res.result !== undefined) ? res.result : res;
    });
}

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
    canPublish: false,     // 管理员 或 已获批发布权（db.canPublish()）：true 时整块申请按钮不显示
    applyBtnText: APPLY_TEXT, // 申请按钮文案（三态之一）
    applyDisabled: false,  // 申请按钮是否禁用（待审核 / 今天已被拒绝）
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
    // 申请状态每次进来都重查：管理员可能刚批完，或者刚过零点（"今天被拒"要变回"可申请"）
    this.loadApplyState();
  },

  /**
   * 上拉触底：加载当前分栏的更多内容。
   * 【为什么现在才需要它】原来两个分栏的触底由 scroll-view 的 bindscrolltolower 负责，
   *   但那个 scroll-view 没有任何高度（见 mydetail.wxml 的说明），永远不触发 ——
   *   所以"我的帖子"一直停在首批 10 条、"回收站"停在 20 条。改用页面级触底后恢复分页。
   */
  onReachBottom() {
    if (this.data.currentTab === 0) this.loadMyPosts();
    else this.loadTrash();
  },

  /**
   * 下拉刷新：当前分栏从第一页重拉并整体替换（另一个分栏也跟着刷，切过去就是最新的）。
   * 【为什么传 []】db.paginate 以传入列表的 length 作 skip、且只追加不删除，
   *   传空数组 = 从第一页开始，拿到的就是完整首页，可直接 setData 覆盖。
   * 【为什么失败时不 setData】失败返回的是带 _failed 的列表，不 setData 则
   *   原列表留在屏幕上，不会因为一次网络抖动把列表刷成空白。
   */
  onPullDownRefresh() {
    Promise.all([this.loadMyPosts([]), this.loadTrash([])]).then((results) => {
      const failed = results.some((r) => r && r._failed);
      if (failed) wx.showToast({ icon: 'none', title: '加载失败，下拉重试' });
      wx.stopPullDownRefresh(); // 必须调用，否则下拉转圈不收起
    });
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
      canPublish: db.canPublish(), // 必须在 initUserState 之后读（它读的是 db 的模块级缓存）
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
    this.loadApplyState();
  },

  // ============ 发布权限申请 ============

  /**
   * 刷新申请按钮的三态。
   * 【先看 canPost，再看 PostApply】回填老用户时**只写 Feeder.canPost、不建 PostApply 行**，
   *   所以「查不到申请记录」绝不等于「没被批准过」—— 那条只能靠 canPublish 判断。
   *   PostApply 只用来决定按钮上写什么字。
   * 【为什么用最新一条而不是查今天】一天只允许一条（_id 锁死），所以"今天"和"最新"在
   *   正常数据下等价；用最新一条能在数据被手工改乱时也给出一个确定答案。
   * 【失败了按可申请显示】这只是文案，真要拦住重复申请的是云函数里 _id 冲突那一道，
   *   这里判错最多是让按钮看起来能点，点下去会拿到「每天只能申请一次」。
   */
  async loadApplyState() {
    // 已获批（或管理员）的人连按钮都不显示，查了也是白查
    if (!this.data.isFeeder || this.data.canPublish) return;
    let latest = null;
    try {
      const rows = await db.find('PostApply', { userId: this.data.userId }, { sort: { appliedAt: -1 }, limit: 1 });
      latest = (rows && rows[0]) || null;
    } catch (e) {
      console.error('[mydetail] 查询发布申请失败（按可申请显示）', e);
      this.setData({ applyBtnText: APPLY_TEXT, applyDisabled: false });
      return;
    }
    let text = APPLY_TEXT;
    let disabled = false;
    if (latest && latest.status === 'pending') {
      text = '已申请，等待审核';
      disabled = true;
    } else if (latest && latest.status === 'rejected' && latest.dayKey === beijingDayKey()) {
      // 只有"今天"被拒才禁用 —— 昨天被拒的人今天应该能再申请
      text = '今天已被拒绝，明天可再申请';
      disabled = true;
    }
    this.setData({ applyBtnText: text, applyDisabled: disabled });
  },

  /** 点「申请发送帖子」：二次确认 → 提交 → 刷新按钮三态 */
  async applyPost() {
    // 按钮 disabled 时点不动，这里再挡一道防手滑（也防 setData 还没渲染时被连点）
    if (this.data.applyDisabled) return;
    // 【顺序是承重的】弹窗在前、限频在后：点「取消」不该消耗限频窗口（项目约定，
    // 同 reviewCenter.js 的 banReview/restoreReport）。
    const confirmed = await confirmAction(
      '申请发布权限',
      '提交后由管理员审核，通过即可发布帖子和评论。\n每天只能申请一次。',
      '提交申请'
    );
    if (!confirmed) return;
    if (!guard.throttle('applyPost', 3000)) return; // 限频命中：throttle 已弹提示，直接收手

    wx.showLoading({ title: '提交中', mask: true });
    try {
      const res = await invokeApply();
      wx.hideLoading();
      if (res && res.ok === false) {
        // 失败原因（未注册 / 黑名单 / 今天已申请过 …）直接用服务端文案
        wx.showToast({ icon: 'none', title: res.msg || '申请失败，请稍后重试', duration: 2500 });
        // 服务端说"已经有权限了"：本地缓存是旧的，刷新一下按钮状态（仍要退出重进才真正生效）
        if (res.code === 'ALREADY_CAN_POST') this.loadApplyState();
        return;
      }
      // 纯告知，不需要 await（也没有"取消"这个选项）—— 用 showCancel:false 的 showModal，
      // 而不是 confirmAction（那个是给"确认/取消"二选一的危险操作用的）。
      wx.showModal({
        title: '已提交',
        content: '申请已提交，等待管理员审核。\n通过后需要完全退出小程序再重新进入，加号和评论框才会出现。',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#FF405E',
      });
      this.loadApplyState();
    } catch (e) {
      wx.hideLoading();
      console.error('[mydetail] 申请发布权限失败', e);
      wx.showToast({ icon: 'none', title: '申请失败，请稍后重试' });
    }
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

  /**
   * 加载"我发布且仍存在的帖子"（按作者 openid 过滤，最新发布在前）。
   * @param {Array} [base] 分页基线：不传则接着当前列表往后翻（触底加载）；
   *                       传 [] 表示从第一页重拉（下拉刷新用）。
   * @returns {Promise<Array|undefined>} 查询结果（失败时带 _failed 标记，且不动页面数据）
   */
  loadMyPosts(base) {
    const userId = app.globalData.userId;
    if (!userId) return Promise.resolve();
    return db.paginate('Page', { authorId: userId }, { sort: { pageTime: -1 }, limit: 10 }, base || this.data.myPosts)
      .then((result) => {
        // db.paginate 出错时会吞掉异常、返回带 _failed 的原列表：此时不动页面数据，
        // 把提示交给调用方。原先挂在这里的 .catch 永远不会执行（异常在 db 层就被吞了）。
        if (result && result._failed) return result;
        this.setData({
          myPosts: db.filterHidden(result).map(p => Object.assign({}, p, {
            // 首图：官方推文（officialLogo）→ 包内 logo；否则按标题拼自有首图
            picUrl: p.officialLogo ? '/pages/images/logo.png' : this.data.urlPage + p.tittle + '0.jpg',
            // 张数：logo 不算进 photoNum，展示时补回 1
            meta: (p.photoTime || '') + ' · ' + ((p.officialLogo ? 1 : 0) + (p.photoNum || 0)) + ' 张',
          })),
        });
        return result;
      });
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

  /**
   * 加载"我删除过的帖子"（Delete 存档按 operatorId 过滤，最新删除在前）。
   * @param {Array} [base] 分页基线：不传则接着当前列表往后翻（触底加载）；
   *                       传 [] 表示从第一页重拉（下拉刷新用）。
   * @returns {Promise<Array|undefined>} 查询结果（失败时带 _failed 标记，且不动页面数据）
   */
  loadTrash(base) {
    const userId = app.globalData.userId;
    if (!userId) return Promise.resolve();
    return db.paginate(trash.DELETE_COLLECTION, { operatorId: userId }, { sort: { editTime: -1 }, limit: 20 }, base || this.data.trashList)
      .then((result) => {
        // db.paginate 出错时会吞掉异常、返回带 _failed 的原列表：此时不动页面数据，
        // 把提示交给调用方。原先挂在这里的 .catch 永远不会执行（异常在 db 层就被吞了）。
        if (result && result._failed) return result;
        this.setData({
          trashList: result.map(trash.mapTrashItem).map(r => Object.assign({}, r, {
            picUrl: r.photoUrls.length ? r.photoUrls[0] : '', // 存档首图（无照片则为空→占位）
            meta: '删除于 ' + r.timeText + (r.operator ? ' · ' + r.operator : ''),
          })),
        });
        return result;
      });
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
