// ============================================================
// pages/someBooklet/someBooklet.js —— 某位作者 / 某个标签的推文列表
// 【作用】从推文详情页进入：
//        - isName=true  ：查看某位作者的推文（列表按作者名精确匹配）
//        - isName=false ：按标签查看推文（relative 字段模糊匹配）
//        分享出去的链接带上 name / isName，打开后直接显示对应列表。
//        数据库查询、点赞、作者头像预览、未登录弹窗走公共模块。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const guard = require('../../utils/guard.js'); // 前端保险工具（正则转义/限频）
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）
const pageUtil = require('../../utils/page.js'); // 页面公共方法（长按编辑/头像预览/未登录弹窗）
const topic = require('../../utils/topic.js'); // 话题正则（兼容历史脏格式）
const sort = require('../../utils/sort.js'); // 排序健壮化 + 卡片时间（客户端归一化脏日期）

Page({
  data: {
    url: app.globalData.url + 'profile/',  // 作者头像目录
    urlPage: app.globalData.url + 'page/', // 推文图片目录地址
    listData: [],                          // 推文列表
    isName: 'false',                       // 是否按作者查看
    name: '',                              // 作者名 / 标签名
    sanitizedName: '',                     // 清洗后的名字（用于图片 URL，防特殊字符）
    multiArray: [['拍摄时间', '发布时间'], ['升序', '降序']],
    multiIndex: [0, 1],                    // 默认按"拍摄时间 + 降序"
    skipCount: 0,
    loaded: false,                         // 首屏查询是否完成（用于空态提示）
  },

  /** 页面加载：从分享链接可直接带 name / isName 打开；缺 name 时兜底 */
  onLoad(options) {
    if (!options || !options.name) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    // 确保 isFeeder / userId 已初始化（分享链接直接打开 this page 时可能未加载）
    db.initUserState().catch(function (err) { console.error('初始化用户状态失败', err); });
    // sanitizedName 用于图片 src（COS key 只含安全字符），name 保留原文用于 DB 查询
    var sanitizedName = guard.sanitizeFileName(options.name || '', 20);
    this.setData({
      isName: options.isName,
      name: options.name,
      sanitizedName: sanitizedName,
    });
    this.getPage();
  },

  /** 排序方式切换 */
  bindMultiPickerChange(e) {
    this.setData({ multiIndex: e.detail.value, listData: [], skipCount: 0 }, () => {
      this.getPage();
    });
  },

  /** 分页加载推文列表（两种查询方式共用一套分页逻辑） */
  getPage() {
    const sortKey = this.data.multiIndex[0] === 0 ? 'photoTime' : 'pageTime';
    const orderBy = this.data.multiIndex[1] === 0 ? -1 : 1;
    // isName=true 按作者名精确匹配；否则按标签匹配完整标签名
    // 用 topic.tokenRegex 做词边界匹配（分隔符含 #＃、空格、逗号等），
    // 兼容 "#肥仔#水晶"（无空格）、"笨笨，小鸭"（逗号）等脏格式，
    // 同时避免"海参"误匹配"小海参"的推文
    const filter = this.data.isName === 'true'
      ? { author: this.data.name }
      : { relative: { $regex: topic.tokenRegex(this.data.name), $options: 'i' } };
    // 排序字段名是动态的，用临时对象赋值（避免计算属性名触发编译错误）
    const sortObj = {};
    sortObj[sortKey] = orderBy;
    // 日期主键再加发布时间降序兜底，保证数据库分页取数稳定
    if (sortKey !== 'pageTime') sortObj.pageTime = -1;
    db.paginate('Page', filter, { sort: sortObj, limit: 20 }, this.data.listData)
      .then(list => {
        list = db.filterHidden(list); // 过滤被封禁用户下架的推文（软删除留存）
        // 客户端按真实时间归一化后重排（兼容脏 photoTime），并补卡片时间文案
        list = sort.applySort(list, sortKey, this.data.multiIndex[1] === 0);
        sort.decorateTime(list);
        this.setData({ listData: list, skipCount: list.length, loaded: true });
      })
      .catch(err => { console.error('加载推文失败', err); wx.showToast({ icon: 'none', title: '加载失败，下拉重试' }); });
  },

  /** 上拉触底：加载更多 */
  onReachBottom() {
    this.getPage();
  },

  /** 点击推文进入详情 */
  toBookletDetail(e) {
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?_id=' + e.currentTarget.dataset._id });
  },

  /** 长按推文：管理员或作者本人可编辑 */
  editBooklet(e) {
    pageUtil.editBooklet(e);
  },

  /** 点赞（连点批量提交）：
   *  每次点击本地即时 +1，防抖 1.5 秒内无新点击后一次性 $inc 提交数据库，
   *  避免连点时持续打 DB。页面离开时也会兜底提交，不丢赞。 */
  giveGood(e) {
    const _id = e.currentTarget.dataset._id;
    const index = e.currentTarget.dataset.index;
    // 本地即时 +1（乐观更新 UI）
    const current = (this.data.listData[index] || {}).good || 0;
    setField(this, 'listData[' + index + '].good', current + 1);
    // 初始化批次存储器
    if (!this._likeBatch) this._likeBatch = {};
    const batch = this._likeBatch[_id] || { count: 0, index: index };
    batch.count++;
    batch.index = index;
    // 重置防抖定时器：1.5 秒内无新点击 → 一次性提交
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      const n = batch.count;
      delete this._likeBatch[_id];
      db.updateOne('Page', { _id }, { $inc: { good: n } })
        .then(() => {
          wx.showToast({ title: ' ' + n + ' 个', icon: 'success' });
        })
        .catch(err => {
          console.error(err);
          // 提交失败 → 回退本地已加上的计数
          const cur = (this.data.listData[batch.index] || {}).good || 0;
          setField(this, 'listData[' + batch.index + '].good', Math.max(0, cur - n));
          wx.showToast({ icon: 'none', title: '点赞失败，请重试' });
        });
    }, 1500);
    this._likeBatch[_id] = batch;
  },

  /** 页面隐藏/卸载时兜底提交未发出的批量点赞 */
  _flushLikes() {
    if (!this._likeBatch) return;
    Object.keys(this._likeBatch).forEach(_id => {
      const batch = this._likeBatch[_id];
      clearTimeout(batch.timer);
      if (batch.count > 0) {
        db.updateOne('Page', { _id }, { $inc: { good: batch.count } })
          .catch(err => console.error('批量点赞提交失败', err));
      }
    });
    this._likeBatch = {};
  },
  onHide() { this._flushLikes(); },
  onUnload() { this._flushLikes(); },

  /** 发布新推文 */
  addBooklet() {
    if (app.globalData.isFeeder) {
      wx.navigateTo({ url: '/pages/addBooklet/addBooklet' });
    } else {
      pageUtil.promptRegister(app.globalData.userId);
    }
  },

  /** 点击作者头像放大预览 */
  showAuthorImg(e) {
    pageUtil.showAuthorImg(e);
  },

  /** 转发给好友/群：带上 name / isName，打开直接显示对应列表 */
  onShareAppMessage() {
    return {
      title: this.data.name,
      path: '/pages/someBooklet/someBooklet?name=' + this.data.name + '&isName=' + this.data.isName,
    };
  },

  /** 转发到朋友圈 */
  onShareTimeline() {
    return {
      title: this.data.name,
      path: '/pages/someBooklet/someBooklet?name=' + this.data.name + '&isName=' + this.data.isName,
    };
  },
});
