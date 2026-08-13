// ============================================================
// pages/bookletDetail/bookletDetail.js —— 推文详情页
// 【作用】展示一条推文的图片轮播、正文、相关标签、评论区。
//        登录用户可以发表 / 修改 / 删除自己的评论。
//        分享出去的链接带上 _id，其他人打开可直接看到这条推文。
//        数据库增删改查、图片 URL、未登录弹窗统一走公共模块。
//        额外支持「回收站预览」：mode=recover 时从 Delete 存档读取被删除的
//        内容（原帖已不在 Page 集合），只读展示，可点「编辑/恢复」进恢复模式。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const guard = require('../../utils/guard.js'); // 前端保险工具（限频/限长）
const cos = require('../../utils/cos.js'); // COS 图片 URL 公共方法
const pageUtil = require('../../utils/page.js'); // 页面公共方法（未登录弹窗等）
const trash = require('../../utils/trash.js'); // 删除存档字段兼容读取（回收站预览用）
const topic = require('../../utils/topic.js'); // 话题解析（兼容历史脏格式）
const catForm = require('../../utils/catForm.js'); // 话题→猫 匹配（别名/曾用名/绰号健壮匹配）

Page({
  data: {
    url: app.globalData.url + 'page/', // 推文图片目录地址
    listData: {},     // 当前推文
    imageUrls: [],    // 推文图片地址列表
    Comment: [],      // 评论列表
    showComment: true,// 无评论时显示占位提示
    isFeeder: false,  // 当前用户是否已注册（用于判断能否评论）
    userId: '',       // 当前用户 openid
    audit: false,     // 是否开放评论（管理员后台开关）
    currentImageIndex: 0,
    recoverMode: false, // 回收站预览模式：内容来自 Delete 存档，只读，不展示评论区
    catTopicMap: {},    // 话题 -> 是否猫名（是猫的话胶囊前加 🐱，和 catDetail 一致）
  },

  /** 页面加载：从分享链接可直接带 _id 打开；缺 _id 时兜底 */
  async onLoad(options) {
    console.log('[bookletDetail] onLoad, options =', options);
    if (!options || !options._id) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ audit: await db.getAudit() }); // 审核开关（getAudit 内部已兜底，不会 reject）
    try {
      await this.initUser();                      // 用户权限状态
    } catch (e) {
      // initUserState 的 getInfo 可能因授权/网络失败 reject；不能让它阻断推文内容加载（否则白屏）
      console.error('初始化用户状态失败', e);
    }
    // 回收站预览：mode=recover 时 _id 是 Delete 存档 id，从存档载入被删内容展示
    if (options.mode === 'recover') {
      this.getArchive(options._id);
      return;
    }
    this.getPage(options._id);                    // 加载推文内容
  },

  /** 获取当前用户状态（管理员/已注册用户） */
  async initUser() {
    await db.initUserState();
    this.setData({
      userId: app.globalData.userId,
      isFeeder: app.globalData.isFeeder,
      userInfo: app.globalData.userInfo,
    });
  },

  /** 加载推文 */
  getPage(_id) {
    console.log('[bookletDetail] getPage _id =', _id);
    db.findOne('Page', { _id })
      .then((data) => {
        console.log('[bookletDetail] findOne Page =>', data ? ('找到：' + data.tittle) : 'null（无此推文）');
        if (!data) {
          wx.showToast({ title: '推文不存在或已删除', icon: 'none' });
          return;
        }
        this.setData({ listData: data });
        this.setPhoto();      // 生成图片列表
        this.getRelative();   // 解析相关标签
        this.getComment();    // 加载评论
      })
      .catch(err => { console.error(err); wx.showToast({ icon: 'none', title: '加载失败' }); });
  },

  /** 回收站预览：从 Delete 存档读取被删除的内容并只读展示。
   *  权限：管理员、删除操作者本人、或原作者本人（与恢复模式一致）。
   *  照片从存档目录取；无照片存档 → 图片区留空（WXML 显示占位提示）。
   *  存档可能已被恢复/彻底删除，查不到就提示并返回。 */
  getArchive(_id) {
    db.findOne(trash.DELETE_COLLECTION, { _id })
      .then((rec) => {
        if (!rec) {
          wx.showToast({ title: '存档不存在或已恢复', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 800);
          return;
        }
        const uid = (app.globalData.userInfo || {}).userId;
        const recAuthorId = trash.pick(rec, 'authorId');
        if (!(app.globalData.isAdministrator || rec.operatorId === uid || recAuthorId === uid)) {
          wx.showToast({ title: '无权查看', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 800);
          return;
        }
        // 照片：存档目录 URL（新存档有 photoArchive + photoKeys；老存档无照片）
        const photoArchive = trash.pick(rec, 'photoArchive');
        const photoKeys = Array.isArray(trash.pick(rec, 'photoKeys')) ? trash.pick(rec, 'photoKeys') : [];
        const imageUrls = [];
        if (photoArchive && photoKeys.length) {
          photoKeys.forEach((key) => imageUrls.push(cos.archiveUrl(photoArchive, key)));
        }
        // 展示数据：从存档还原（新存档字段在 data 里、老存档在顶层）
        const data = {
          _id: rec._id,
          tittle: trash.pick(rec, 'tittle') || '',
          main: trash.pick(rec, 'main') || '',
          photoTime: trash.pick(rec, 'photoTime') || '',
          relative: trash.pick(rec, 'relative') || '',
          photoNum: imageUrls.length, // 预览轮播页码以实际存档照片数为准
        };
        this._recoverMode = true;
        this._recoverArchiveId = rec._id;
        this.setData({ recoverMode: true, listData: data, imageUrls });
        this.getRelative(); // 解析相关标签（预览模式不加载评论）
      })
      .catch(err => { console.error(err); wx.showToast({ icon: 'none', title: '加载存档失败' }); });
  },

  /** 生成推文图片地址列表（图片路径：目录+标题+序号.jpg） */
  setPhoto() {
    const imageUrls = [];
    const tittle = this.data.listData.tittle;
    for (let i = 0; i < this.data.listData.photoNum; i++) {
      imageUrls.push(cos.pageUrl(tittle, i));
    }
    this.setData({ imageUrls });
  },

  /** 解析相关标签（topic.parse 兼容 "#肥仔#水晶" / "＃小梅" / "笨笨，小鸭" 等脏格式），
   *  并异步标记哪些话题是猫名（胶囊加 🐱） */
  getRelative() {
    const relativeList = topic.parse(this.data.listData.relative);
    this.setData({ relativeList });
    this.markCatTopics(relativeList);
  },

  /** 标记话题里哪些是猫名（和 catDetail 一致）：真实名 name / 别名 otherName /
   *  曾用名 usedName / 昵称 nickname 任一字段含该话题独立词（支持 "肥猪/饭桶"、
   *  "猫哥 小奶猫" 这类分隔写法）。map 必须按【话题名】做 key——胶囊上显示的是
   *  话题原文，别名话题（肥猪）要能直接命中发福那只猫。只读查询，失败静默。 */
  async markCatTopics(list) {
    const catTopicMap = {};
    if (!list.length) { this.setData({ catTopicMap }); return; }
    try {
      const filter = catForm.topicCatFilter(list);
      const cats = filter ? await db.find('BITZH', filter, { limit: list.length * 5 }) : [];
      (cats || []).forEach((c) => {
        if (!c || !c.name) return;
        // 该猫所有"可被叫的名字"拼成串：真实名 + 别名 + 曾用名 + 昵称（含关系词/描述词）
        const stack = [c.name, c.otherName, c.usedName, c.nickname].filter(Boolean).join(' ');
        list.forEach((t) => { if (!catTopicMap[t] && catForm.aliasContains(stack, t)) catTopicMap[t] = true; });
      });
    } catch (err) {
      console.error('查询话题猫失败', err);
    }
    this.setData({ catTopicMap });
  },

  /** 点击相关标签：若对应猫咪存在则打开猫详情（真实名 / 别名 / 曾用名 / 绰号都能命中），
   *  否则按标签搜索推文 */
  toRelative(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    // 一次查询：真实名/别名/曾用名/昵称任一字段含该话题独立词 → 取第一只命中猫
    const filter = catForm.topicCatFilter([name]);
    db.find('BITZH', filter, { limit: 5 })
      .then((cats) => {
        const cat = (cats || []).find((c) => c && catForm.aliasContains(
          [c.name, c.otherName, c.usedName, c.nickname].filter(Boolean).join(' '), name
        ));
        if (cat) {
          wx.navigateTo({ url: '/pages/catDetail/catDetail?_id=' + cat._id });
        } else {
          wx.navigateTo({ url: '/pages/someBooklet/someBooklet?name=' + name + '&isName=false' });
        }
      })
      .catch(err => console.error(err));
  },

  // ============ 评论区 ============
  /** 加载评论 */
  getComment() {
    // 评论按推文的 commendId 关联（addBooklet 发布时生成随机 id）
    const commendId = this.data.listData && this.data.listData.commendId;
    // 用 == null 而非 !commendId，避免 commendId=0 时跳过评论（0 是合法值）
    if (commendId == null) return;
    db.find('Comment', { commendId })
      .then((list) => {
        this.setData({
          Comment: list,
          showComment: list.length === 0,
        });
      })
      .catch(err => { console.error(err); wx.showToast({ icon: 'none', title: '加载评论失败' }); });
  },

  /** 输入评论内容 */
  inputText(e) {
    this.setData({ comment: e.detail.value });
  },

  /** 发表评论 */
  addComment() {
    if (app.globalData.isFeeder) {
      const content = (this.data.comment || '').trim();
      if (!content) {
        wx.showToast({ title: '请输入评论内容', icon: 'none' });
        return;
      }
      // 评论限长 + 限频（前端保险）
      if (guard.tooLong(content, 200)) {
        wx.showToast({ title: '评论过长（200字以内）', icon: 'none' });
        return;
      }
      if (!guard.throttle('addComment', 2000) || !guard.rateLimit('addComment', 60000, 30)) return;
      const myCommentId = Math.floor(Math.random() * 1000000000000);
      const formattedTime = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const userInfo = app.globalData.userInfo || {};
      db.insertOne('Comment', {
        author: guard.toText(userInfo.nickName),
        authorId: userInfo.userId,
        authorImg: userInfo.avatarUrl,
        main: guard.toText(content),
        commentTime: formattedTime,
        commendId: this.data.listData.commendId,
        myCommentId,
      }).then(() => {
        this.getComment();
        this.setData({ comment: '' });
        wx.showToast({ icon: 'success', title: '评论成功' });
      }).catch(err => {
        console.error(err);
        guard.resetThrottle('addComment'); // 发表失败：可立即重试
        wx.showToast({ icon: 'error', title: '操作失败' });
      });
    } else {
      pageUtil.promptRegister(this.data.userId);
    }
  },

  /** 长按评论：弹出"修改/删除"菜单 */
  choseComment(e) {
    const authorId = e.currentTarget.dataset.authorid;
    const myCommentId = e.currentTarget.dataset.mycommentid;
    const main = e.currentTarget.dataset.main;
    wx.showActionSheet({
      itemList: ['修改评论', '删除评论'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.modifyComment(authorId, myCommentId, main);
        } else if (res.tapIndex === 1) {
          this.deleteComment(authorId, myCommentId);
        }
      },
    });
  },

  /** 删除评论（管理员或评论作者本人） */
  deleteComment(authorId, myCommentId) {
    const userInfo = app.globalData.userInfo || {};
    // 先校验权限再限频：权限不足直接提示，不消耗限频窗口（对齐 editBooklet 删除逻辑）
    if (!(app.globalData.isAdministrator || userInfo.userId === authorId)) {
      wx.showToast({ icon: 'error', title: '权限不足' });
      return;
    }
    // 前端限频（保险）：2 秒内只能删除一次评论
    if (!guard.throttle('delComment', 2000)) return;
    wx.showModal({
      title: '提示',
      confirmColor: 'red',
      content: '确定删除吗？',
      success: (res) => {
        if (res.confirm) {
          db.deleteOne('Comment', { myCommentId })
            .then(() => {
              this.getComment();
              wx.showToast({ icon: 'success', title: '删除成功' });
            })
            .catch(err => {
              console.error(err);
              wx.showToast({ icon: 'error', title: '操作失败' });
            });
        }
      },
    });
  },

  /** 修改评论（管理员或评论作者本人） */
  modifyComment(authorId, myCommentId, main) {
    const userInfo = app.globalData.userInfo || {};
    // 先校验权限再限频：权限不足直接提示，不消耗限频窗口（对齐 editBooklet 删除逻辑）
    if (!(app.globalData.isAdministrator || userInfo.userId === authorId)) {
      wx.showToast({ icon: 'error', title: '权限不足' });
      return;
    }
    // 前端限频（保险）：2 秒内只能修改一次评论
    if (!guard.throttle('modComment', 2000)) return;
    wx.showModal({
      title: '修改评论',
      content: main,
      showCancel: true,
      confirmText: '保存',
      cancelText: '取消',
      editable: true,
      confirmColor: '#FF405E',
      success: (res) => {
        if (res.confirm) {
          db.updateOne(
            'Comment',
            { myCommentId },
            { $set: { main: guard.toText(res.content) } }
          ).then(() => {
            this.getComment();
            wx.showToast({ icon: 'success', title: '修改成功' });
          }).catch(err => {
            console.error(err);
            wx.showToast({ icon: 'error', title: '操作失败' });
          });
        }
      },
    });
  },

  /** 回收站预览：进入恢复模式编辑页（可重新编辑后保存即恢复、或彻底删除存档、或返回） */
  editRecover() {
    if (!this._recoverArchiveId) return;
    wx.navigateTo({ url: '/pages/editBooklet/editBooklet?mode=recover&_id=' + this._recoverArchiveId });
  },

  /** 长按推文：管理员或作者本人可编辑（从当前推文取作者）。
   *  回收站预览模式下长按 → 进恢复模式编辑页（权限已在 getArchive 校验过）。 */
  editBooklet(e) {
    if (this._recoverMode) {
      this.editRecover();
      return;
    }
    const _id = e.currentTarget.dataset._id;
    const authorId = this.data.listData.authorId;
    const userInfo = app.globalData.userInfo || {};
    if (app.globalData.isAdministrator || userInfo.userId === authorId) {
      wx.navigateTo({ url: '/pages/editBooklet/editBooklet?_id=' + _id });
    }
  },

  /** 点击作者头像放大预览 */
  showAuthorImg(e) {
    pageUtil.showAuthorImg(e);
  },

  /** 轮播图切换 */
  bindChange(e) {
    this.setData({ currentImageIndex: e.detail.current });
  },

  /** 点击图片全屏预览 */
  previewImageHandler() {
    wx.previewImage({
      urls: this.data.imageUrls,
      current: this.data.imageUrls[this.data.currentImageIndex],
    });
  },

  /** 转发给好友/群：带上 _id，打开直接看到这条推文（回收站预览带 mode=recover，打开者需有权限） */
  onShareAppMessage() {
    const data = this.data.listData || {};
    const path = this._recoverMode
      ? '/pages/bookletDetail/bookletDetail?mode=recover&_id=' + (data._id || '')
      : '/pages/bookletDetail/bookletDetail?_id=' + (data._id || '');
    return {
      title: data.tittle || '北理珠流浪猫关爱部',
      path: path,
    };
  },

  /** 转发到朋友圈 */
  onShareTimeline() {
    const data = this.data.listData || {};
    const path = this._recoverMode
      ? '/pages/bookletDetail/bookletDetail?mode=recover&_id=' + (data._id || '')
      : '/pages/bookletDetail/bookletDetail?_id=' + (data._id || '');
    return {
      title: data.tittle || '北理珠流浪猫关爱部',
      path: path,
    };
  },
});
