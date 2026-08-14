// ============================================================
// pages/catDetail/catDetail.js —— 猫咪详情页
// 【作用】展示单只猫咪的照片轮播、状态（健康/送养/绝育等）、
//        详细信息、相关猫咪，以及该猫相关的推文（可按时间/点赞排序分页）。
//        分享出去的链接带上 _id，其他人打开可直接看到这只猫。
//        数据库查询、图片 URL、缩略图回退、作者头像预览走公共模块。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const guard = require('../../utils/guard.js'); // 前端保险工具（正则转义）
const cos = require('../../utils/cos.js'); // COS 图片 URL 公共方法
const pageUtil = require('../../utils/page.js'); // 页面公共方法（缩略图回退/头像预览）
const catForm = require('../../utils/catForm.js'); // 文本字段兜底归一化（防 [object Object] 脏数据显示）
const topic = require('../../utils/topic.js'); // 话题解析/正则（兼容历史脏格式）
const sort = require('../../utils/sort.js'); // 排序健壮化 + 卡片时间（客户端归一化脏日期）

Page({
  data: {
    cat: {},                 // 当前猫咪
    url: app.globalData.url, // 图片根地址
    urlPage: app.globalData.url + 'page/', // 推文图片目录地址
    relatedCatsId: [],       // 相关猫咪列表
    relationMap: {},         // 相关猫咪 -> 关系描述
    photoArray: [],          // 照片序号数组（0,1,2,...）
    photoNum: '',            // 照片张数
    imageUrls: [],           // 当前猫咪的图片地址列表
    currentImageIndex: 0,    // 轮播图当前页
    windowWidth: 0,          // 屏幕宽度
    showDetail: false,       // 是否展开详细信息
    bgcolor: '',             // 状态标签背景色
    bgcolor1: '',            // 绝育标签背景色
    height: '300rpx',        // 轮播图高度（展开详情时变高）
    listData: [],            // 该猫相关的推文列表
    multiArray: [['拍摄时间', '发布时间'], ['升序', '降序']],
    multiIndex: [1, 0],      // 默认按"发布时间 + 升序"（故事按时间从早到晚讲）
    skipCount: 0,
    relatedTopics: [],       // 相关话题（本猫出现在哪些推文话题里，去重后，含 isCat/count 标记）
    relatedTopicsShow: [],   // 当前展示的相关话题（默认 8 个，展开后为全部）
    topicsExpanded: false,   // 相关话题是否已展开（个别猫话题太多 → 收缩/展开）
    selectedTopics: [],      // 用户已选中的相关话题（多选，点胶囊切换）
    topicSelectedMap: {},    // 选中话题 → true（WXML 直接取值判断高亮）
    topicArticles: [],       // 选中话题的内联文章列表（不跳页，直接在详情页展示）
    topicArticlesLoading: false, // 内联文章加载中
  },

  /** 页面加载：从分享链接可直接带 _id 打开；缺 _id 时兜底 */
  async onLoad(options) {
    this._id = options && options._id;
    console.log('[catDetail] onLoad, _id =', this._id, ', options =', options);
    if (!this._id) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    // 获取屏幕宽度（预览图片时可用）
    this.setData({ windowWidth: wx.getWindowInfo().windowWidth });
    // 加载猫咪信息
    try {
      const raw = await db.findOne('BITZH', { _id: this._id });
      console.log('[catDetail] findOne BITZH =>', raw ? ('找到：' + raw.name) : 'null（无此猫）');
      if (!raw) {
        wx.showToast({ title: '未找到该猫咪', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      const cat = catForm.normalizeTextFields(raw);
      this.setData({ cat });
      this.getStatusColor();   // 状态颜色
      this.buildPhotos(cat);   // 照片轮播
      this.loadRelatedCats(cat); // 相关猫咪
      this.loadRelatedTopics(cat); // 相关话题（聚合本猫出现的推文话题）
      this.getPage();          // 该猫相关推文
    } catch (e) {
      console.error('加载猫咪失败', e);
      wx.showToast({ icon: 'none', title: '加载失败，请返回重试' });
    }
  },

  /**
   * 从其它页面返回时刷新：若该猫已被删除（编辑页删除后 navigateBack 回来），
   * 清空页面并返回，避免继续渲染已删除的图片（COS 404）；内容有变则重新加载。
   */
  async onShow() {
    if (!this._id || !this.data.cat || !this.data.cat._id) return; // 首次进入由 onLoad 加载
    try {
      const raw = await db.findOne('BITZH', { _id: this._id });
      if (!raw) {
        // 该猫已被删除：占位 + 提示 + 返回
        this.setData({
          cat: {},
          photoArray: [0],
          imageUrls: ['/pages/images/logo.png'],
          photoNum: 0,
          relatedCatsId: [],
          relationMap: {},
          listData: [],
        });
        wx.showToast({ title: '该猫咪已被删除', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      const cat = catForm.normalizeTextFields(raw);
      const cur = this.data.cat;
      // 内容没变就不重复渲染，避免轮播闪烁
      // 用 getTime() 比较时间戳，避免 String(date) 因毫秒差异误判"已修改"
      if (cur._id && new Date(cur.lastEditTime).getTime() === new Date(cat.lastEditTime).getTime() && String(cur.name) === String(cat.name)) {
        return;
      }
      this.setData({ cat });
      this.getStatusColor();
      this.buildPhotos(cat);
      this.loadRelatedCats(cat);
      this.loadRelatedTopics(cat);
      this.getPage();
    } catch (e) {
      console.error('刷新猫咪失败', e);
      wx.showToast({ icon: 'none', title: '刷新失败' });
    }
  },

  /** 根据猫咪的照片张数生成图片地址列表；数据库没有照片时用 logo 占位 */
  buildPhotos(cat) {
    // 旧数据无照片数 / 数量异常（含 NaN）时，用一张 logo 图占位，避免轮播图空白
    if (typeof cat.addPhotoNumber !== 'number' || isNaN(cat.addPhotoNumber) || cat.addPhotoNumber < 0) {
      this.setData({ photoArray: [0], imageUrls: ['/pages/images/logo.png'], photoNum: 0 });
      return;
    }
    const photoArray = [];
    const imageUrls = [];
    for (let i = 0; i <= cat.addPhotoNumber; i++) {
      photoArray.push(i);
      imageUrls.push(cos.catUrl(cat.name, i, cat.photoVer)); // 带照片版本号：照片变了 URL 变新，不显示旧缓存图
    }
    this.setData({ photoArray, imageUrls, photoNum: cat.addPhotoNumber });
  },

  /** 加载"相关猫咪"（relatedCats 用空格分隔；名字可能带"。"表示关系，如 小白。兄弟） */
  async loadRelatedCats(cat) {
    if (!cat.relatedCats) return;
    const relationMap = {};
    const names = cat.relatedCats.split(' ').filter(Boolean).map(item => {
      if (item.includes('。')) {
        const [name, relation] = item.split('。');
        relationMap[name] = relation;
        return name;
      }
      relationMap[item] = '';
      return item;
    });
    try {
      // 一次查询所有相关猫咪（代替逐只查询）
      const list = await db.find('BITZH', { name: { $in: names } });
      const byName = {};
      list.forEach(c => { byName[c.name] = c; });
      // 按原顺序排列，找不到的跳过；缩略图也带照片版本号，避免显示旧缓存图
      const related = pageUtil.stampThumbs(names.map(n => byName[n]).filter(Boolean), this.data.url);
      this.setData({
        relatedCatsId: related,
        relationMap,
      });
    } catch (e) {
      console.error('加载相关猫咪失败', e);
      wx.showToast({ icon: 'none', title: '加载相关猫咪失败' });
    }
  },

  /**
   * 聚合"相关话题"：查所有 relative 命中本猫名的推文，把里面的话题全部收集、
   * 去重、排除猫名自身，渲染成可多选的话题胶囊。
   * count = 本猫的文章里有多少篇带该话题（热度，让用户知道点开不会太空洞）。
   * 只读查询，失败静默（话题区只是增强展示，不影响主内容）。
   */
  async loadRelatedTopics(cat) {
    const catName = cat && cat.name;
    if (!catName) {
      this.setData({ relatedTopics: [], relatedTopicsShow: [] });
      return;
    }
    try {
      const pages = await db.find(
        'Page',
        { relative: { $regex: topic.tokenRegex(catName), $options: 'i' } },
        { sort: { pageTime: -1 }, limit: 100 }
      );
      const seen = {};
      const list = [];
      const countMap = {};
      db.filterHidden(pages).forEach(function (p) {
        // topic.parse 对单篇去重；countMap 按"篇数"计数（同篇多标签只算一次）
        topic.parse(p.relative).forEach(function (t) {
          if (t === catName) return;          // 排除猫名自身
          countMap[t] = (countMap[t] || 0) + 1;
          if (seen[t]) return;
          seen[t] = true;
          list.push(t);
        });
      });
      // 建"猫名"集合：话题里是猫的话题加 🐱 标识 + 记录目标猫 _id（点击可跳那只猫的详情页）。
      // 真实名 name / 别名 otherName / 曾用名 usedName / 昵称 nickname 任一字段含该话题
      // 独立词即算命中（支持 "肥猪/饭桶"、"猫哥 小奶猫" 等分隔写法），map 按【话题名】登记，
      // 别名话题（肥猪）直接命中发福那只猫（bookletDetail 同逻辑）。
      const catMap = {};
      if (list.length) {
        try {
          const filter = catForm.topicCatFilter(list);
          const cats = filter ? await db.find('BITZH', filter, { limit: list.length * 5 }) : [];
          (cats || []).forEach(function (c) {
            if (!c || !c.name) return;
            // 该猫所有"可被叫的名字"拼成串：真实名 + 别名 + 曾用名 + 昵称（含关系词/描述词）
            const stack = [c.name, c.otherName, c.usedName, c.nickname].filter(Boolean).join(' ');
            list.forEach(function (t) {
              if (!catMap[t] && catForm.aliasContains(stack, t)) catMap[t] = c;
            });
          });
        } catch (e2) {
          console.error('查询猫名集合失败', e2);
        }
      }
      // 统一转成 { name, isCat, count, catId }；count 供胶囊尾部显示热度
      const topics = list.map(function (t) {
        const c = catMap[t];
        return { name: t, isCat: !!c, catId: c && c._id ? c._id : '', count: countMap[t] || 0 };
      });
      // 按热度（count）从高到低排，同热度按名称稳定排序：默认展示"最多人聊"的话题在前
      topics.sort(function (a, b) {
        return (b.count - a.count) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      });
      // 新猫咪加载时清空上一次的选择与内联文章（防止串页）
      this.setData({
        relatedTopics: topics,
        relatedTopicsShow: topics.slice(0, 8),
        topicsExpanded: false,
        selectedTopics: [],
        topicSelectedMap: {},
        topicArticles: [],
      });
    } catch (e) {
      console.error('加载相关话题失败', e);
      this.setData({ relatedTopics: [], relatedTopicsShow: [] });
    }
  },

  /** 相关话题太多时收缩/展开：折叠只显示前 8 个，展开显示全部 */
  toggleTopics() {
    const expanded = !this.data.topicsExpanded;
    this.setData({
      topicsExpanded: expanded,
      relatedTopicsShow: expanded ? this.data.relatedTopics : this.data.relatedTopics.slice(0, 8),
    });
  },

  /** 点相关话题胶囊：猫名话题（🐱）直接跳到那只猫的详情页（别名也能命中）；
   *  其余话题多选切换（不跳页），选中后在本页内联展示文章 */
  toggleTopic(e) {
    const name = e.currentTarget.dataset.name;
    const catId = e.currentTarget.dataset.id;
    if (!name) return;
    if (catId) {
      console.log('[catDetail.toggleTopic] 猫名话题 → 跳猫详情页', name, catId);
      wx.navigateTo({ url: '/pages/catDetail/catDetail?_id=' + catId });
      return;
    }
    const sel = (this.data.selectedTopics || []).slice();
    const idx = sel.indexOf(name);
    if (idx >= 0) sel.splice(idx, 1); else sel.push(name);
    const map = {};
    sel.forEach(function (n) { map[n] = true; });
    this.setData({ selectedTopics: sel, topicSelectedMap: map }, () => this.loadTopicArticles());
  },

  /** 全选：选中所有"非猫名"话题（同时展开显示全部），并加载内联文章。
   *  猫名话题（🐱）点击是跳详情页，不参与多选，故排除在外，避免选中后无法点掉 */
  selectAllTopics() {
    const full = this.data.relatedTopics || [];
    const selectable = full.filter(function (t) { return !t.isCat; });
    const map = {};
    selectable.forEach(function (t) { if (t && t.name) map[t.name] = true; });
    this.setData({
      selectedTopics: selectable.map(function (t) { return t.name; }),
      topicSelectedMap: map,
      topicsExpanded: true,
      relatedTopicsShow: full, // 展开显示全部话题（猫名话题仍显示，点击跳详情）
    }, () => this.loadTopicArticles());
  },

  /** 取消选择：清空全部选中，收起内联文章 */
  deselectAllTopics() {
    this.setData({
      selectedTopics: [],
      topicSelectedMap: {},
      topicArticles: [],
    });
  },

  /** 清空话题筛选，收起内联文章 */
  clearTopicFilter() {
    this.setData({
      selectedTopics: [],
      topicSelectedMap: {},
      topicArticles: [],
    });
  },

  /** 加载选中话题的内联文章：匹配「本猫 + 任一选中话题」，按拍摄时间倒序取最近 30 篇 */
  async loadTopicArticles() {
    const catName = this.data.cat && this.data.cat.name;
    const sel = this.data.selectedTopics || [];
    if (!catName || !sel.length) {
      this.setData({ topicArticles: [], topicArticlesLoading: false });
      return;
    }
    this.setData({ topicArticlesLoading: true });
    try {
      // 本猫文章 + 任一选中话题（多选 = 并集展示）
      const ors = sel.map(function (t) {
        return { relative: { $regex: topic.tokenRegex(t), $options: 'i' } };
      });
      const filter = {
        relative: { $regex: topic.tokenRegex(catName), $options: 'i' },
        $or: ors,
      };
      let list = await db.find('Page', filter, { sort: { pageTime: -1 }, limit: 30 });
      list = db.filterHidden(list); // 过滤被封禁用户下架的推文（软删除留存）
      // 与主列表一致：客户端按真实时间归一化重排（兼容脏 photoTime），并补卡片时间文案
      list = sort.applySort(list, 'photoTime', true);
      sort.decorateTime(list);
      // 补 _i 供 pageCard 模板的 data-index 使用
      list.forEach(function (item, i) { item._i = i; });
      this.setData({ topicArticles: list, topicArticlesLoading: false });
    } catch (err) {
      console.error('加载话题文章失败', err);
      this.setData({ topicArticlesLoading: false });
      wx.showToast({ icon: 'none', title: '加载话题文章失败' });
    }
  },

  /** 根据状态设置标签颜色 */
  getStatusColor() {
    const statusColor = {
      '健康': '#22bb33',
      '送养': '#3399ff',
      '失踪': '#ff0000',
      '离世': '#6e6e6e',
      '待抓': '#fbcf43',
    };
    const sterColor = {
      '已绝育': '#22bb33',
      '未知': '#ff0000',
      '未绝育': '#fbcf43',
    };
    this.setData({
      bgcolor: statusColor[this.data.cat.status] || '',
      bgcolor1: sterColor[this.data.cat.isSterilization] || '',
    });
  },

  /** 轮播图某张照片加载失败（COS 上缺图）时，用 logo 占位，避免空白和 404 刷屏 */
  onSwiperImgError(e) {
    const index = e.currentTarget.dataset.index;
    const imageUrls = this.data.imageUrls.slice(); // 复制一份再改，让 setData 感知变化
    if (imageUrls[index] === '/pages/images/logo.png') return; // 已是占位图，不再替换
    imageUrls[index] = '/pages/images/logo.png';
    this.setData({ imageUrls });
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

  /** 展开 / 收起详细信息（同时放大缩小轮播图） */
  showDetail() {
    const height = this.data.showDetail ? '300rpx' : '600rpx';
    const animation = wx.createAnimation({ duration: 500, timingFunction: 'ease' });
    animation.height(height).step();
    this.setData({
      animationData: animation.export(),
      showDetail: !this.data.showDetail,
      height,
    });
  },

  /** 管理员长按图片可编辑猫咪 */
  editCat(e) {
    if (!app.globalData.isAdministrator) return;
    const _id = e.currentTarget.dataset._id;
    wx.navigateTo({ url: '/pages/editCat/editCat?_id=' + _id });
  },

  /** 猫咪缩略图加载失败时逐级回退：.png → 0.jpg → 占位图 */
  onCatImgError(e) {
    pageUtil.onImgError(this, e);
  },

  // ============ 相关推文 ============
  /** 排序方式切换 */
  bindMultiPickerChange(e) {
    this.setData({ multiIndex: e.detail.value, listData: [], skipCount: 0 }, () => {
      this.getPage();
    });
  },

  /** 分页加载该猫相关的推文（relative 字段按猫名匹配完整标签）。
   *  使用词边界正则 (^|[\\s])name($|[\\s])，避免"海参"误匹配"小海参"的推文。 */
  getPage() {
    // 猫名为空时不查询（空正则 = 匹配所有推文 = 数据泄露）
    const catName = this.data.cat && this.data.cat.name;
    if (!catName) return;
    const sortKey = this.data.multiIndex[0] === 0 ? 'photoTime' : 'pageTime';
    // multiIndex[1]：0=升序、1=降序（与选择器标签一致；此前倒挂已修正）
    const orderBy = this.data.multiIndex[1] === 0 ? 1 : -1;
    const sortObj = {};
    sortObj[sortKey] = orderBy;
    // 日期主键再加发布时间降序兜底，保证数据库分页取数稳定
    if (sortKey !== 'pageTime') sortObj.pageTime = -1;
    // 词边界匹配：只匹配作为独立话题出现的猫名（前后是空白/井号/逗号等分隔符或字符串边界）。
    // 用 topic.tokenRegex 统一处理，兼容 "#肥仔#水晶"（无空格）、"笨笨，小鸭"（逗号）等脏格式。
    var tagRe = topic.tokenRegex(catName);
    db.paginate(
      'Page',
      { relative: { $regex: tagRe, $options: 'i' } },
      { sort: sortObj, limit: 20 },
      this.data.listData
    ).then(list => {
      list = db.filterHidden(list); // 过滤被封禁用户下架的推文（软删除留存）
      // 客户端按真实时间归一化后重排（兼容脏 photoTime），并补卡片时间文案
      list = sort.applySort(list, sortKey, this.data.multiIndex[1] === 1);
      sort.decorateTime(list);
      // 补上 _i 供 pageCard 模板的 data-index 使用（瀑布流索引）
      var base = this.data.listData.length;
      list.forEach(function (item, i) { item._i = base + i; });
      this.setData({ listData: list, skipCount: list.length });
      // 该猫没有任何相关推文 → 直接展开全部详细信息（只自动展开一次，不覆盖用户手动收起）
      if (!this._autoExpanded && !list.length && !this.data.showDetail) {
        this._autoExpanded = true;
        this.setData({ showDetail: true, height: '600rpx' });
      }
    }).catch(err => { console.error('加载相关推文失败', err); wx.showToast({ icon: 'none', title: '加载推文失败' }); });
  },

  /** 上拉触底：加载更多 */
  onReachBottom() {
    this.getPage();
  },

  /** 点击推文进入详情 */
  toBookletDetail(e) {
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?_id=' + e.currentTarget.dataset._id });
  },

  /** 点赞：本页不支持直接点赞（无瀑布流索引），点击爱心跳转到帖子详情页再点赞 */
  giveGood(e) {
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?_id=' + e.currentTarget.dataset._id });
  },

  /** 长按推文：管理员或作者本人可编辑 */
  editBooklet(e) {
    pageUtil.editBooklet(e);
  },

  /** 点击作者头像放大预览 */
  showAuthorImg(e) {
    pageUtil.showAuthorImg(e);
  },

  /** 点击作者昵称：查看该作者全部推文 */
  toName(e) {
    wx.navigateTo({
      url: '/pages/someBooklet/someBooklet?name=' + e.currentTarget.dataset.author + '&isName=true',
    });
  },

  /** 打开系统设置（订阅消息等） */
  openSetting() {
    wx.openSetting({ withSubscriptions: true });
  },

  /** 转发给好友/群：带上 _id，打开直接看到这只猫 */
  onShareAppMessage() {
    return {
      title: this.data.cat.name || '北理珠流浪猫关爱部',
      path: '/pages/catDetail/catDetail?_id=' + (this.data.cat._id || this._id || ''),
    };
  },

  /** 转发到朋友圈 */
  onShareTimeline() {
    return {
      title: this.data.cat.name || '北理珠流浪猫关爱部',
      path: '/pages/catDetail/catDetail?_id=' + (this.data.cat._id || this._id || ''),
    };
  },
});
