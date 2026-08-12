// ============================================================
// pages/index/index.js —— 小猫书（首页·推文社区）
// 【作用】展示大家的猫咪推文（支持按时间/点赞排序、分页加载），
//        可点赞、评论（跳详情页）、发布新推文。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）
const pageUtil = require('../../utils/page.js'); // 页面公共方法（长按编辑/头像预览/未登录弹窗）
const topic = require('../../utils/topic.js'); // 话题模糊匹配（搜索框用）
const sort = require('../../utils/sort.js'); // 排序健壮化 + 卡片时间（客户端归一化脏日期）
const catSearch = require('../../utils/catSearch.js'); // 猫搜索（大名/绰号/关系词）

Page({
  data: {
    audit: false,          // 是否开放发布（由管理员在后台控制）
    blackNum: false,       // 是否在黑名单中（黑名单用户禁止使用）
    showPopup: false,      // 是否显示公告弹窗
    popupAnimation: {},    // 弹窗动画对象（blackNumPopup / noticePopup 模板需要）
    notice: '',            // 公告内容
    listData: [],          // 推文列表
    leftList: [],          // 左列（偶数下标，瀑布流左列）
    rightList: [],         // 右列（奇数下标，瀑布流右列）
    url: app.globalData.url,
    urlPage: app.globalData.url + 'page/', // 推文图片的目录地址
    skipCount: 0,          // 已加载条数（分页用）
    multiArray: [['拍摄时间', '发布时间', '点赞量'], ['升序', '降序']],
    multiIndex: [1, 0],    // 默认按"发布时间 + 降序"
    userId: '',
    search: '',            // 搜索框关键词（话题 / 猫名 / 标题）
    searchMode: false,     // 是否处于搜索态（搜索时卡片显示时间、展示猫横条）
    catResults: [],        // 搜索命中的猫（猫横条，点击直达猫详情）
    loaded: false,         // 首屏查询是否完成（用于搜索空态提示）
  },

  /** 页面加载 */
  onLoad(options) {
    // 先拉推文列表，尽快首屏；审核开关/用户状态/黑名单等后台查询异步更新
    this.getPage();
    this.getNotice();
    db.getAudit().then((audit) => this.setData({ audit }))
      .catch((err) => console.error('读取审核开关失败', err));
    this.initUser();
    db.isBlacklisted().then((blackNum) => this.setData({ blackNum }))
      .catch((err) => console.error('黑名单检查失败', err));
  },

  /** 页面显示：同步底部自定义 tabBar 选中态（小猫书=1） */
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
  },

  /** 获取当前用户状态（管理员/已注册用户），写入全局并同步到页面 */
  async initUser() {
    await db.initUserState();
    this.setData({
      userId: app.globalData.userId,
      isFeeder: app.globalData.isFeeder,
      userInfo: app.globalData.userInfo,
    });
  },

  // ============ 排序选择器 ============
  bindMultiPickerChange: function (e) {
    this.setData({ multiIndex: e.detail.value, listData: [], leftList: [], rightList: [], skipCount: 0 }, () => {
      this.getPage();
    });
  },

  /** 分页加载推文：按所选排序规则查询，去重合并；搜索关键词非空时按话题/标题模糊过滤 */
  getPage() {
    const orderBy = this.data.multiIndex[1] === 0 ? -1 : 1; // 降序/升序
    // 排序字段：0=拍摄时间 1=发布时间 2=点赞量
    const sortKey = this.data.multiIndex[0] === 2 ? 'good' :
      (this.data.multiIndex[0] === 0 ? 'photoTime' : 'pageTime');
    // 排序字段名是动态的，用临时对象赋值（避免计算属性名触发编译错误）
    const sortObj = {};
    sortObj[sortKey] = orderBy;
    // 数据库取数按主键排序（保证分页去重/取数稳定）；日期主键再加发布时间降序兜底
    if (sortKey !== 'good' && sortKey !== 'pageTime') sortObj.pageTime = -1;
    // 搜索：按空格/逗号等分词，词间 $and 模糊匹配 relative（话题）或 tittle（标题）；
    // 空关键词（无搜索）→ 空过滤，即正常全量瀑布流
    const tokens = topic.parse(this.data.search);
    const filter = tokens.length ? topic.tagFilter(tokens) : {};
    db.paginate('Page', filter, { sort: sortObj, limit: 20 }, this.data.listData)
      .then(list => {
        // 客户端按真实时间归一化后重排（兼容脏 photoTime），并补卡片时间文案
        list = sort.applySort(list, sortKey, this.data.multiIndex[1] === 0);
        sort.decorateTime(list);
        this.setData(this.buildColumns(list));
      })
      .catch(err => { console.error('加载推文失败', err); wx.showToast({ icon: 'none', title: '加载失败，下拉重试' }); });
  },

  /** 把推文列表拆成左右两列（瀑布流）：避免整表被 wx:for+wx:if 过滤两遍，渲染工作量减半 */
  buildColumns(list) {
    const leftList = [];
    const rightList = [];
    list.forEach((item, i) => {
      // 拷贝一份并带上全局下标 _i：点赞回写 listData 时仍能定位原位置
      const row = Object.assign({}, item, { _i: i });
      if (i % 2 === 0) leftList.push(row);
      else rightList.push(row);
    });
    return { listData: list, leftList: leftList, rightList: rightList, skipCount: list.length, loaded: true };
  },

  // ============ 搜索（推文 / 猫） ============
  /** 搜索框输入：防抖 300ms 后刷新推文列表 + 并行搜猫（猫横条） */
  onSearchInput(e) {
    const value = e.detail.value;
    this.setData({ search: value, searchMode: !!value });
    clearTimeout(this._searchTimer);
    if (!value) {
      // 清空搜索 → 立即恢复全量瀑布流、隐藏猫横条
      this._searchCatSeq = (this._searchCatSeq || 0) + 1;
      this.setData({ catResults: [], listData: [], leftList: [], rightList: [], skipCount: 0, loaded: false }, () => {
        this.getPage();
      });
      return;
    }
    this._searchTimer = setTimeout(() => {
      // 关键词变化 → 重置列表从头查（保持当前排序），并搜猫
      this.setData({ listData: [], leftList: [], rightList: [], skipCount: 0, loaded: false }, () => {
        this.getPage();
        this.searchCats(value);
      });
    }, 300);
  },

  /** 搜猫：大名 / 绰号（关键词）/ "X的妈妈或孩子" → 猫横条（过期 seq 丢弃） */
  searchCats(keyword) {
    this._searchCatSeq = (this._searchCatSeq || 0) + 1;
    const seq = this._searchCatSeq;
    catSearch.searchCats(keyword, { limit: 5 })
      .then(result => {
        if (seq !== this._searchCatSeq) return; // 输入又变了，丢弃过期响应
        result = pageUtil.stampThumbs(result, this.data.url);
        result.forEach(cat => {
          cat._sub = [cat.status, cat.location].filter(Boolean).join(' · ');
        });
        this.setData({ catResults: result });
      })
      .catch(err => console.error('搜索猫咪失败', err));
  },

  /** 点击猫横条 → 猫详情 */
  toCatDetail(e) {
    const _id = e.currentTarget.dataset._id;
    wx.navigateTo({ url: '/pages/catDetail/catDetail?_id=' + _id });
  },

  /** 猫横条缩略图加载失败逐级回退 */
  onCatImgError(e) {
    pageUtil.onImgError(this, e);
  },

  /** 清空搜索 → 恢复全量瀑布流 */
  onSearchClear() {
    clearTimeout(this._searchTimer);
    this._searchCatSeq = (this._searchCatSeq || 0) + 1;
    this.setData({ search: '', searchMode: false, catResults: [], listData: [], leftList: [], rightList: [], skipCount: 0, loaded: false }, () => {
      this.getPage();
    });
  },

  // ============ 公告 ============
  getNotice() {
    db.find('Notice', { status: true })
      .then(list => {
        if (list.length > 0 && list[0].notice) {
          this.setData({ notice: list[0].notice, showPopup: true });
        }
      })
      .catch(console.error);
  },
  closePopup() {
    this.setData({ showPopup: false });
  },
  hidePopup() {
    this.setData({ showPopup: false });
  },

  /** 点击推文进入详情页 */
  toBookletDetail(e) {
    const _id = e.currentTarget.dataset._id;
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?_id=' + _id });
  },

  /** 长按推文：管理员或作者本人可编辑 */
  editBooklet(e) {
    pageUtil.editBooklet(e);
  },

  /** 点击作者头像放大预览 */
  showAuthorImg(e) {
    pageUtil.showAuthorImg(e);
  },

  /** 点赞（连点批量提交）：
   *  每次点击本地即时 +1，防抖 1.5 秒内无新点击后一次性 $inc 提交数据库，
   *  避免连点时持续打 DB。页面离开时也会兜底提交，不丢赞。 */
  /** 同时更新 listData 和瀑布流列（leftList/rightList 是 buildColumns 的拷贝，只改 listData 屏幕数字不变） */
  _bumpGood(index, good) {
    setField(this, 'listData[' + index + '].good', good);
    const col = index % 2 === 0 ? 'leftList' : 'rightList';
    setField(this, col + '[' + Math.floor(index / 2) + '].good', good);
  },

  giveGood(e) {
    const _id = e.currentTarget.dataset._id;
    const index = e.currentTarget.dataset.index;
    // 本地即时 +1（乐观更新 UI）
    const current = (this.data.listData[index] || {}).good || 0;
    this._bumpGood(index, current + 1);
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
          wx.showToast({ title: '已增加点赞 ' + n + ' 个', icon: 'success' });
        })
        .catch(err => {
          console.error(err);
          // 提交失败 → 回退本地已加上的计数
          const cur = (this.data.listData[batch.index] || {}).good || 0;
          this._bumpGood(batch.index, Math.max(0, cur - n));
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

  /** 点击作者昵称，查看该作者的全部推文 */
  toName(e) {
    const author = e.currentTarget.dataset.author;
    wx.navigateTo({ url: '/pages/someBooklet/someBooklet?name=' + author + '&isName=true' });
  },

  /** 上拉触底：加载更多 */
  onReachBottom() {
    this.getPage();
  },

  /** 转发给好友/群 */
  onShareAppMessage: function () {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/index/index',
    };
  },

  /** 转发到朋友圈 */
  onShareTimeline: function () {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/index/index',
    };
  },
});
