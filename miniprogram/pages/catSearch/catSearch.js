// ============================================================
// pages/catSearch/catSearch.js —— 查猫
// 【作用】按状态分栏展示校园里的猫咪（在校/送养/逃学/喵星/待抓），
//        支持搜索猫咪昵称、下拉加载更多。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const pageUtil = require('../../utils/page.js'); // 页面公共方法（缩略图回退）
const topic = require('../../utils/topic.js'); // 话题正则（匹配推文里的猫名标签）
const catSearch = require('../../utils/catSearch.js'); // 猫搜索（大名/绰号/关系词）

// 状态页配置：tab 索引 → 数据库 status、数据键名、排序字段
var TAB_CFG = {
  1: { status: '送养', key: 'fostered_cat', sort: 'deliveryTime' },
  2: { status: '失踪', key: 'unknown_cat', sort: 'missingTime' },
  3: { status: '离世', key: 'dead_cat', sort: 'deathTime' },
  4: { status: '待抓', key: 'becatch_cat', sort: 'missingTime' },
};

// 毛色分类列表（数据驱动"在校"tab 的导航入口）
var CLASSIFICATIONS = [
  { name: '玳瑁及三花', img: '玳瑁及三花' },
  { name: '橘猫和橘白', img: '橘猫及橘白' },
  { name: '纯色', img: '纯色' },
  { name: '奶牛', img: '奶牛' },
  { name: '狸花', img: '狸花' },
  { name: '雀猫', img: '雀猫' },
  { name: '简州猫', img: '简州猫' },
  { name: '其他', img: '其他' },
];

Page({
  data: {
    fostered_cat: [],   // "送养"状态的猫咪
    unknown_cat: [],    // "失踪/逃学"状态的猫咪
    dead_cat: [],       // "离世/喵星"状态的猫咪
    becatch_cat: [],    // "待抓"状态的猫咪
    navbar: ['在校', '送养', '逃学', '喵星', '待抓'], // 顶部状态栏
    currentTab: 0,      // 当前选中的状态页
    url: app.globalData.url, // 图片根地址
    classifications: CLASSIFICATIONS, // 毛色分类导航（wxml 循环渲染）
    showResult: false,  // 是否显示搜索结果
    resultList: [],     // 搜索结果列表
    showList: false,
    blackNum: false,    // 是否在黑名单中（黑名单用户只显示"请离开"弹窗）
    showPopup: false,   // 是否显示公告弹窗
    notice: '',         // 公告内容
    popupAnimation: {}, // 公告弹窗动画
    blankHeight: 0,     // 底部留白高度（避免内容被遮挡）
  },

  // ============ 顶部状态栏点击切换 ============
  navbarTap: function (e) {
    var idx = e.currentTarget.dataset.idx;
    this.setData({ currentTab: idx });
    // 懒加载：首次切换到非"在校"tab 时才拉数据，减少 onLoad 时的 DB 并发
    if (idx > 0 && !this._loadedTabs[idx]) {
      this._loadedTabs[idx] = true;
      this.loadMoreCatByStatus(idx);
    }
  },

  /** 猫咪缩略图加载失败时逐级回退：.png → 0.jpg → 占位图 */
  onCatImgError(e) {
    pageUtil.onImgError(this, e);
  },

  /** 页面加载：可从分享链接带上 currentTab 参数，直接打开对应状态页 */
  onLoad(options) {
    this._loadedTabs = {}; // 各 tab 是否已加载过数据（懒加载）
    if (options && options.currentTab !== undefined) {
      var tab = parseInt(options.currentTab, 10);
      if (isNaN(tab)) tab = 0;
      tab = Math.max(0, Math.min(tab, this.data.navbar.length - 1));
      this.setData({ currentTab: tab });
      // 分享链接指定了非"在校"tab：立即加载该 tab（同时后台预热其他 tab）
      if (tab > 0) {
        this._loadedTabs[tab] = true;
        this.loadMoreCatByStatus(tab);
      }
    }
    // 用户状态 / 黑名单 / 公告 在后台异步处理，不阻塞首屏
    db.initUserState().catch(function (err) { console.error('初始化用户状态失败', err); });
    db.isBlacklisted().then(function (blackNum) { this.setData({ blackNum: blackNum }); }.bind(this))
      .catch(function (err) { console.error('黑名单检查失败', err); });
    this.getNotice();
  },

  /**
   * 回到首页时刷新四个列表：删除/修改过的猫咪不再出现在列表里。
   * 首次进入由 onLoad 加载，跳过。
   */
  onShow() {
    // 同步底部自定义 tabBar 选中态（查猫=0），置于刷新逻辑之前
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
      if (typeof this.getTabBar().refreshAudit === 'function') this.getTabBar().refreshAudit();
    }
    if (!this._firstShow) {
      this._firstShow = true;
      return;
    }
    // 重置已加载标记并重新拉取当前 tab（可能从其他页面删了猫回来）
    this._loadedTabs = {};
    this.setData({ fostered_cat: [], unknown_cat: [], dead_cat: [], becatch_cat: [] });
    if (this.data.currentTab > 0) {
      this._loadedTabs[this.data.currentTab] = true;
      this.loadMoreCatByStatus(this.data.currentTab);
    }
  },

  // ============ 公告弹窗 ============
  /** 拉取公告（Notice 集合中 status 为 true 的那条） */
  getNotice() {
    db.find('Notice', { status: true })
      .then(list => {
        if (list.length > 0 && list[0].notice) {
          this.setData({ notice: list[0].notice, showPopup: true });
        }
      })
      .catch(console.error);
  },
  /** 关闭弹窗（黑名单或公告） */
  hidePopup() {
    this.setData({ showPopup: false, blackNum: false });
  },
  closePopup() {
    this.setData({ showPopup: false, blackNum: false });
  },

  /** 管理员长按猫咪可进入编辑页 */
  editCat(e) {
    if (!app.globalData.isAdministrator) return; // 非管理员不响应
    const _id = e.currentTarget.dataset._id;
    wx.navigateTo({
      url: '/pages/editCat/editCat?_id=' + _id,
    });
  },

  /** 管理员点击顶部 Logo 可新增猫咪 */
  imageTap(e) {
    if (!app.globalData.isAdministrator) return;
    wx.navigateTo({ url: '/pages/addCat/addCat' });
  },

  /** 上拉触底：加载当前状态页的更多数据（tab 0 在校不在此分页；懒加载未初始化的 tab） */
  onReachBottom: function () {
    if (this.data.currentTab > 0) {
      if (!this._loadedTabs[this.data.currentTab]) {
        this._loadedTabs[this.data.currentTab] = true;
      }
      this.loadMoreCatByStatus(this.data.currentTab);
    }
  },

  /**
   * 通用分页加载：按 tab 索引查配置 → 从 BITZH 集合按状态筛选 → 追加到对应列表
   * @param {number} tabIndex — 状态页索引（1=送养 / 2=逃学 / 3=喵星 / 4=待抓）
   */
  loadMoreCatByStatus: function (tabIndex) {
    var cfg = TAB_CFG[tabIndex];
    if (!cfg) return;
    var list = this.data[cfg.key];
    var sort = {};
    sort[cfg.sort] = -1;
    var self = this;
    db.paginate('BITZH', { status: cfg.status }, { sort: sort, limit: 20 }, list)
      .then(function (result) {
        var data = {};
        data[cfg.key] = pageUtil.stampThumbs(result, self.data.url);
        self.setData(data);
      })
      .catch(function (err) { console.error('分页加载失败', err); wx.showToast({ icon: 'none', title: '加载失败，下拉重试' }); });
  },

  // ============ 搜索：大名 / 绰号（关键词）/ 关系词 ============
  onInput: function (e) {
    const name = e.detail.value;
    // 输入为空时隐藏搜索结果
    if (name.length <= 0) {
      clearTimeout(this._searchTimer);
      this.setData({ showResult: false, showList: false });
      return;
    }
    // 搜索关键词限长（防止超长/超复杂正则给数据库带来压力）
    if (name.length > 20) {
      clearTimeout(this._searchTimer);
      this.setData({ showResult: false, showList: false });
      wx.showToast({ title: '搜索关键词过长', icon: 'none' });
      return;
    }
    // 防抖：停止输入 300ms 后才真正查询，避免每次按键都打数据库
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._searchSeq = (this._searchSeq || 0) + 1;
      const seq = this._searchSeq;
      // 统一走 utils/catSearch.js：大名/绰号/关键词，以及「X的妈妈/孩子」等关系短语
      catSearch.searchCats(name, { limit: 50 }).then(result => {
        if (seq !== this._searchSeq) return; // 响应已过期（输入又变了），丢弃
        // 搜索结果同样补上带版本号的缩略图 URL，避免照片变化后仍显示旧缓存图
        result = pageUtil.stampThumbs(result, this.data.url);
        // 给匹配的前 3 只猫各预取"相关推文"（relative 命中猫名的推文），
        // 展示在下拉里（猫名下方小字）。同一搜索会话按猫 id 缓存，避免重复查询。
        const catCache = this._relCache || (this._relCache = {});
        const tasks = [];
        const TOP = Math.min(3, result.length);
        for (let i = 0; i < TOP; i++) {
          const cat = result[i];
          const key = cat._id || cat.name;
          if (catCache[key]) {
            cat._relPages = catCache[key]; // 命中缓存
          } else {
            tasks.push(
              db.find('Page',
                { relative: { $regex: topic.tokenRegex(cat.name), $options: 'i' } },
                { sort: { pageTime: -1 }, limit: 3 })
                .then(pages => {
                  catCache[key] = (pages || []).map(p => ({ _id: p._id, tittle: p.tittle }));
                  cat._relPages = catCache[key];
                })
                .catch(() => { catCache[key] = []; cat._relPages = []; })
            );
          }
        }
        // 全部相关推文就绪后一次性渲染（单只猫的查询失败不阻塞整个列表）
        Promise.all(tasks).then(() => {
          if (seq !== this._searchSeq) return;
          this.setData({
            resultList: result,
            showResult: result.length > 0,
            showList: true
          });
          if (result.length === 0) wx.showToast({ icon: 'none', title: '未找到相关猫咪' });
        });
      }).catch(err => { console.error(err); wx.showToast({ icon: 'none', title: '搜索失败，请重试' }); });
    }, 300);
  },

  // 点击搜索结果，跳转到猫咪详情
  onClick: function (e) {
    const _id = e.currentTarget.dataset._id;
    wx.navigateTo({ url: '/pages/catDetail/catDetail?_id=' + _id });
  },

  // 点击搜索结果里"猫名下方的相关推文"，跳到推文详情
  onRelPageTap: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?_id=' + id });
  },

  // 输入框聚焦时触发（与 onInput 行为一致，兼容 wxml 绑定）
  onFocus: function (e) {
    console.log('[catSearch.onFocus] 输入框聚焦, value=', e.detail && e.detail.value);
    this.onInput(e);
  },

  // 键盘"搜索/完成"键：明确结束搜索 → 收起搜索结果
  onConfirm: function () {
    console.log('[catSearch.onConfirm] 点击搜索/完成，收起搜索结果');
    clearTimeout(this._searchTimer);
    this._searchSeq = (this._searchSeq || 0) + 1;
    this.setData({ showResult: false, showList: false });
  },

  // 输入框失焦（键盘收起）时【不】收起搜索结果：
  // 真机上滑一下搜索框就会让键盘收起并触发 blur，若 blur 就隐藏结果，搜索收缩太灵敏。
  // 现在结果保留到用户点空白处 / 按搜索完成 / 清空输入才收起，只取消尚未发出的查询防过期。
  onBlur: function () {
    clearTimeout(this._searchTimer);
    this._searchSeq = (this._searchSeq || 0) + 1;
    console.log('[catSearch.onBlur] 键盘收起，保留搜索结果 showResult=', this.data.showResult,
      '（点空白处 / 搜索完成 / 清空输入 才收起）');
  },

  // 点击页面空白处（内容区/状态栏/logo）时收起搜索结果：
  // 用 bindtap 而非 bindtouchstart——滑动/滚动内容不会触发 tap，
  // 避免"滑一下搜索框（或列表）就收缩"；只有真正的点击才收起。
  onPageTap: function () {
    console.log('[catSearch.onPageTap] 点击空白处，收起搜索结果');
    this.setData({ showResult: false, showList: false });
  },

  // ============ 分享 ============
  /** 转发给好友/群：带上当前状态页参数，打开后直接显示对应分类 */
  onShareAppMessage: function () {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/catSearch/catSearch?currentTab=' + this.data.currentTab,
    };
  },

  /** 转发到朋友圈 */
  onShareTimeline: function () {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/catSearch/catSearch?currentTab=' + this.data.currentTab,
    };
  },
});
