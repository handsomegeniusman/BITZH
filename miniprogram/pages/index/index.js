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
const guard = require('../../utils/guard.js'); // 前端保险工具（正则转义等）

/** 时间格式化（Date → "YYYY-MM-DD HH:mm"），脏值返回空串（与 userManage 一致） */
function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

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
    userResults: [],       // 搜索命中的用户（仅管理员展示，点击进用户管理）
    defaultAvatar: 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0', // 用户头像占位
    isAdministrator: false, // 当前用户是否为管理员（决定是否显示用户搜索入口）
    loaded: false,         // 首屏查询是否完成（用于搜索空态提示）
  },

  /** 页面加载 */
  onLoad(options) {
    // 审核模式（audit=false）下不读小猫书数据：等审核开关结果回来再决定是否加载。
    // 开关开放（true）→ 加载全量瀑布流；开关关闭 → 不读数据，除非用户搜索。
    // 【为什么用 getAuditForMe 而不是 getAudit】审核模式**只挡没在本机注册过的人**
    //   （游客 / 微信审核员）：Feeder.enable=true 的注册用户、以及管理员，
    //   效果都等同"审核模式已关闭"。合并逻辑在 db.getAuditForMe → utils/auditGate.js。
    this.getNotice();
    db.getAuditForMe().then((audit) => {
      this._auditSettled = true; // 首屏闸门已定，onShow 的重算从此刻起才允许介入
      this.setData({ audit });
      if (audit) this.getPage(); // 开放发布才默认加载小猫书
    }).catch((err) => {
      this._auditSettled = true; // 连"读不出结果"也算定过 —— 否则 onShow 永远不敢重算
      // 【这个分支实际上到不了】getAuditForMe 内部对两种失败都各自兜了底
      //   （查询失败 → 按"审核模式"处理），永远不会 reject。留着只是以防将来改坏。
      //   所以"读失败按开放处理"只描述这一行的效果，**不是**真实的失败行为 ——
      //   真实口径是 fail-closed，见 db.getAudit / db.getAuditForMe 的注释。
      console.error('读取审核开关失败', err);
      this.getPage();
    });
    this.initUser();
    db.isBlacklisted().then((blackNum) => {
      if (blackNum) wx.reLaunch({ url: '/pages/banned/banned' }); // 黑名单用户禁止访问任何页面
    }).catch((err) => console.error('黑名单检查失败', err));
  },

  /** 页面显示：同步底部自定义 tabBar 选中态（小猫书=1），并重算一次审核闸门 */
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
      if (typeof this.getTabBar().refreshAudit === 'function') this.getTabBar().refreshAudit();
    }
    this.recheckGateOnShow();
  },

  /**
   * 切回本页时重算「审核模式对本人开不开」，**只在由闭变开时**补加载瀑布流。
   * ============================================================
   * 【为什么必须有这个】瀑布流只在 onLoad 里按闸门加载一次（onShow 不重读）。
   *   而"连点五次开通豁免"这件事**恰恰是在别的页面发生的**（「关于」页），本页只是被
   *   switchTab 切回来 —— 于是它带着 onLoad 时那句 `audit:false` 继续渲染审核模式的
   *   遮挡页。用户点了「去首页」，看到的是一个"什么都没变"的首页，唯一出路是杀进程重进
   *   （about.js 的兜底提示写的就是这句）。这个函数把那条兜底从"唯一出路"降成"保险"。
   * 【为什么闸门重算不会拖慢切换】它读的全是 db 的模块级缓存，命中时**不发任何网络请求**；
   *   缓存万一没命中，也是在 onShow 之后异步补的，不挡渲染。
   *   另一半代价在别处付掉了：连点成功时 about.js 只写 `state.enable` 一个字段，
   *   不再用 resetUserState 清掉 userId / 名册 / 全局开关（见 db.markSelfEnable）。
   * 【为什么用 _auditSettled 而不是"比较新旧值"】首次进入时 onLoad 与本函数都会各发一次
   *   getAuditForMe，两者的回调**先后不定**。若不加这道闸，onLoad 的回调无条件
   *   `if (audit) this.getPage()`，本函数的回调也 `getPage()` —— 首次进首页就可能**拉两遍
   *   第一页**，那正好是"首页变慢"的一个现成来源。加了之后：首屏一律归 onLoad，
   *   本函数只负责"之后某次切回来时发现闸门开了"。
   * 【只认 false → true】反过来（由开变闭，比如管理员在后台关了审核）不该由这里处理：
   *   本页已经渲染出来的内容不该因为一次 onShow 就被抹掉，那属于管理员页的职责。
   */
  recheckGateOnShow() {
    if (!this._auditSettled) return; // 首屏还没定，交给 onLoad
    db.getAuditForMe().then((audit) => {
      if (!audit || this.data.audit) return; // 只处理"由闭变开"
      this.setData({ audit });
      this.getPage(); // 此刻 listData 必为空（闸门关着时从没加载过），从第一页拉
    }).catch((err) => console.error('[index] onShow 重算审核闸门失败', err));
  },

  /**
   * 下拉刷新：重取审核开关后再从第一页重拉当前列表。
   * 【为什么要重取审核开关】getPage 有闸门「audit 为假且不在搜索态就直接返回」，
   *   onLoad 时若 getAudit 失败，audit 就一直是假的 → 下拉会变成什么都没发生的空操作。
   *   （与 onLoad 一样用 getAuditForMe：本人被豁免时也该照常刷新。）
   * 【为什么传 []】db.paginate 以传入列表的 length 作 skip、且只追加不删除，
   *   传空数组 = 从第一页开始；buildColumns 会把左右两列整体覆盖，不是追加。
   * 【为什么失败时不 setData】失败返回的是带 _failed 的列表，不 setData 则
   *   原列表留在屏幕上，不会因为一次网络抖动把列表刷成空白。
   */
  onPullDownRefresh() {
    db.getAuditForMe().then((audit) => {
      this.setData({ audit });
      return this.getPage([]);
    }).catch((err) => {
      console.error('读取审核开关失败', err);
      return this.getPage([]); // 读失败按开放处理，与 onLoad 一致
    }).then((result) => {
      if (result && result._failed) wx.showToast({ icon: 'none', title: '加载失败，下拉重试' });
      wx.stopPullDownRefresh(); // 必须调用，否则下拉转圈不收起
    });
  },

  /** 获取当前用户状态（管理员/已注册用户），写入全局并同步到页面 */
  async initUser() {
    await db.initUserState();
    this.setData({
      userId: app.globalData.userId,
      isFeeder: app.globalData.isFeeder,
      userInfo: app.globalData.userInfo,
      isAdministrator: app.globalData.isAdministrator,
    });
  },

  // ============ 排序选择器 ============
  bindMultiPickerChange: function (e) {
    this.setData({ multiIndex: e.detail.value, listData: [], leftList: [], rightList: [], skipCount: 0 }, () => {
      this.getPage();
    });
  },

  /**
   * 分页加载推文：按所选排序规则查询，去重合并；搜索关键词非空时按话题/标题模糊过滤。
   * @param {Array} [base] 分页基线：不传则接着当前列表往后翻（触底加载）；
   *                       传 [] 表示从第一页重拉（下拉刷新用）。
   * @returns {Promise<Array|undefined>} 查询结果（失败时带 _failed 标记，且不动页面数据）
   */
  getPage(base) {
    // 审核模式（audit=false）不读小猫书数据：除非用户正在搜索。
    // 避免关闭发布审核时每次进首页都白读一遍 Page 集合。
    if (!this.data.audit && !this.data.searchMode) return Promise.resolve();
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
    return db.paginate('Page', filter, { sort: sortObj, limit: 20 }, base || this.data.listData)
      .then((result) => {
        // db.paginate 出错时会吞掉异常、返回带 _failed 的原列表：此时不动页面数据，
        // 把提示交给调用方。原先挂在这里的 .catch 永远不会执行（异常在 db 层就被吞了）。
        // 注意：必须先判 _failed 再做 filterHidden/applySort —— 它们都会返回新数组，标记会丢。
        if (result && result._failed) return result;
        let list = db.filterHidden(result); // 过滤被封禁用户下架的推文（软删除留存）
        // 客户端按真实时间归一化后重排（兼容脏 photoTime），并补卡片时间文案
        list = sort.applySort(list, sortKey, this.data.multiIndex[1] === 0);
        sort.decorateTime(list);
        this.setData(this.buildColumns(list)); // buildColumns 整体覆盖左右两列，不是追加
        return result;
      });
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
      // 清空搜索 → 立即恢复全量瀑布流、隐藏猫横条/用户入口
      this._searchCatSeq = (this._searchCatSeq || 0) + 1;
      this._searchUserSeq = (this._searchUserSeq || 0) + 1;
      this.setData({ catResults: [], userResults: [], listData: [], leftList: [], rightList: [], skipCount: 0, loaded: false }, () => {
        this.getPage();
      });
      return;
    }
    this._searchTimer = setTimeout(() => {
      // 关键词变化 → 重置列表从头查（保持当前排序），并搜猫/搜用户
      this.setData({ listData: [], leftList: [], rightList: [], skipCount: 0, loaded: false }, () => {
        this.getPage();
        this.searchCats(value);
        this.searchUsers(value);
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

  /** 搜用户（仅管理员）：昵称模糊 + 用户ID精确，命中则展示用户入口 + 他的帖子（过期 seq 丢弃） */
  searchUsers(keyword) {
    // 非管理员不展示用户搜索入口
    if (!app.globalData.isAdministrator) return;
    this._searchUserSeq = (this._searchUserSeq || 0) + 1;
    const seq = this._searchUserSeq;
    const re = guard.escapeRegExp(keyword);
    Promise.all([
      db.find('Feeder', { userId: keyword }, { limit: 3 }),
      db.find('Feeder', { nickName: { $regex: re, $options: 'i' } }, { limit: 5 }),
    ]).then(([byId, byName]) => {
      if (seq !== this._searchUserSeq) return; // 输入又变了，丢弃过期响应
      // 按 _id 去重合并
      const map = {};
      (byId || []).concat(byName || []).forEach((u) => {
        if (u && u._id && !map[u._id]) map[u._id] = u;
      });
      const users = Object.keys(map).map((k) => map[k]);
      // 批量查这些用户发过的帖子（含已下架的，标注 hidden），供用户横条下方直接展示
      const ids = users.map((u) => u.userId).filter(Boolean);
      if (!ids.length) {
        this.setData({ userResults: [] });
        return;
      }
      db.find('Page', { authorId: { $in: ids } }, { sort: { pageTime: -1 }, limit: 30 })
        .then((posts) => {
          if (seq !== this._searchUserSeq) return; // 输入又变了，丢弃过期响应
          const byAuthor = {};
          (posts || []).forEach((p) => {
            if (!p || !p.authorId) return;
            (byAuthor[p.authorId] = byAuthor[p.authorId] || []).push(p);
          });
          users.forEach((u) => {
            const list = byAuthor[u.userId] || [];
            u.posts = list.slice(0, 5).map((p) => ({
              _id: p._id,
              tittle: p.tittle || '（无标题）',
              timeText: fmtTime(p.pageTime || p.photoTime),
              hidden: !!p.hidden,
            }));
            u.postsLoaded = true; // 帖子已查好，点击进管理页可直接展开
          });
          this.setData({ userResults: users });
        })
        .catch((err) => {
          console.error('搜索用户帖子失败', err);
          if (seq === this._searchUserSeq) this.setData({ userResults: users });
        });
    }).catch((err) => {
      console.error('搜索用户失败', err);
      if (seq === this._searchUserSeq) this.setData({ userResults: [] });
    });
  },

  /** 点击用户横条 → 进用户管理页（带 userId + 已搜好的用户数据，免重复搜索，跳转更快） */
  toUserManage(e) {
    const userId = e.currentTarget.dataset.userid;
    const index = e.currentTarget.dataset.index;
    // 把 index 已搜到的用户数据（含帖子）暂存，userManage 打开后直接展示
    const user = this.data.userResults[index];
    if (user && user.userId) app.globalData.userManageSeed = user;
    wx.navigateTo({ url: '/pages/userManage/userManage?userId=' + encodeURIComponent(userId) });
  },

  /** 点击用户帖子 → 跳转推文详情页看原文 */
  toPostDetail(e) {
    const _id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?_id=' + _id });
  },

  /** 点击猫横条 → 猫详情 */
  toCatDetail(e) {
    const _id = e.currentTarget.dataset._id;
    wx.navigateTo({ url: '/pages/catDetail/catDetail?_id=' + _id });
  },

  /** 长按猫横条：管理员可直接进编辑页（和 catDetail 图片长按一致，非管理员静默） */
  editCatFromSearch(e) {
    if (!app.globalData.isAdministrator) return;
    const _id = e.currentTarget.dataset._id;
    wx.navigateTo({ url: '/pages/editCat/editCat?_id=' + _id });
  },

  /** 猫横条缩略图加载失败逐级回退 */
  onCatImgError(e) {
    pageUtil.onImgError(this, e);
  },

  /** 用户横条头像加载失败 → 回退微信默认头像 */
  onUserImgError(e) {
    const index = e.currentTarget.dataset.index;
    if (index === undefined) return;
    setField(this, 'userResults[' + index + '].avatarUrl', this.data.defaultAvatar);
  },

  /** 清空搜索 → 恢复全量瀑布流 */
  onSearchClear() {
    clearTimeout(this._searchTimer);
    this._searchCatSeq = (this._searchCatSeq || 0) + 1;
    this._searchUserSeq = (this._searchUserSeq || 0) + 1;
    this.setData({ search: '', searchMode: false, catResults: [], userResults: [], listData: [], leftList: [], rightList: [], skipCount: 0, loaded: false }, () => {
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

  /** 黑名单弹窗兜底：去申诉页（正常情况下黑名单用户会被 reLaunch 到 banned 页） */
  goAppeal() {
    wx.navigateTo({ url: '/pages/appeal/appeal' });
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
    // 2026-08-28 点赞也是写库操作：必须已注册（Feeder）才能点赞，游客引导去注册
    if (!app.globalData.isFeeder) {
      pageUtil.promptRegister(app.globalData.userId);
      return;
    }
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
