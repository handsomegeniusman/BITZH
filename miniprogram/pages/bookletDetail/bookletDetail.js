// ============================================================
// pages/bookletDetail/bookletDetail.js —— 推文详情页
// 【作用】展示一条推文的图片轮播、正文、相关标签（话题是猫名时换成圆头像胶囊）、评论区。
//        登录用户可以发表 / 修改 / 删除自己的评论。
//        分享出去的链接带上 _id，其他人打开可直接看到这条推文。
//        数据库增删改查、图片 URL、未登录弹窗统一走公共模块。
//        额外支持「回收站预览」：mode=recover 时从 Delete 存档读取被删除的
//        内容（原帖已不在 Page 集合），只读展示，可点「编辑/恢复」进恢复模式。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const guard = require('../../utils/guard.js'); // 前端保险工具（限频/限长）
const secCheck = require('../../utils/secCheck.js'); // 内容安全审核（评论，写库前拦截）
const cos = require('../../utils/cos.js'); // COS 图片 URL 公共方法
const pageUtil = require('../../utils/page.js'); // 页面公共方法（未登录弹窗等）
const trash = require('../../utils/trash.js'); // 删除存档字段兼容读取（回收站预览用）
const topic = require('../../utils/topic.js'); // 话题解析（兼容历史脏格式）
const catForm = require('../../utils/catForm.js'); // 话题→猫 匹配（别名/曾用名/绰号健壮匹配）

// ============ 标题去装饰（管理员长按标题进猫咪页用） ============
// 管理员写标题常带猫头和括号（「🐱肥仔」「肥仔🐱」「肥仔（绝育记）」），
// 直接拿去和猫名比会全不命中。这里只剥「符号」——表情、空白、括号标点，
// 不拆名字本身：「肥仔的绝育记」剥完仍是「肥仔的绝育记」，不会退化成「肥仔」，
// 所以「标题就是猫名」这个严格口径不受影响。
const TITLE_DECOR = /[\s\u3000\u200B-\u200D\uFE0F]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF\u2B00-\u2BFF]/g;
const TITLE_PUNCT = /[（）()【】\[\]《》〈〉“”"'’‘·・•\-—_~～|/\\,，、;；:：.。!！?？#＃*+＋]+/g;
function stripTitleDecor(tittle) {
  return String(tittle == null ? '' : tittle)
    .replace(TITLE_DECOR, '')   // 表情/空白：直接删（「肥仔🐱」→「肥仔」）
    .replace(TITLE_PUNCT, ' ')  // 标点：换空格，保留词边界（「肥仔（绝育记）」→「肥仔 绝育记」）
    .trim();
}

/**
 * 按「可被叫的名字」找那只猫：真实名 / 别名 / 曾用名 / 昵称，独立词命中。
 * 2026-09-15：话题胶囊的 🐱（markCatTopics）、点话题跳猫（toRelative）、长按话题跳猫
 *   （editCat）共用这一个函数 —— 同一个名字在页面上必须得到同一个答案，
 *   之前这里另写过一套更严的判断（去掉 nickname），就出现「胶囊上有 🐱、
 *   长按却没反应」这种自相矛盾。
 * @param {string} name 待查名字（标题已去装饰 / 话题原文）
 * @param {boolean} [trust] true = 不再做 aliasContains 复核，直接取候选集第一只。
 *        标题自带 🐱 时用：管理员已经亲手标了「这是猫」，不要再判一次是不是猫。
 * @returns {Promise<Object|null>} 命中的猫（带 _id），没命中 null
 */
async function findCatByName(name, trust) {
  if (!name) return null;
  const filter = catForm.topicCatFilter([name]);
  if (!filter) return null;
  const cats = await db.find('BITZH', filter, { limit: 5 });
  const list = cats || [];
  if (trust) return list.find((c) => c && c._id) || null;
  return list.find((c) => c && catForm.aliasContains(
    [c.name, c.otherName, c.usedName, c.nickname].filter(Boolean).join(' '), name
  )) || null;
}

Page({
  data: {
    url: app.globalData.url + 'page/', // 推文图片目录地址
    catUrl: app.globalData.url, // 猫咪图片根地址（猫图在根目录下，与推文的 page/ 不同目录）
    // 话题行：每格 {text: 话题原文, cat: 命中那只猫 | null}。cat 有值的那格渲染成
    // 圆头像胶囊（点进猫详情），null 的那格保持原来的粉色文字胶囊（点搜同话题文章）。
    // 【为什么合成一个数组】话题文本和「它是不是猫名」必须同源同序：分成两个数组
    //   （一个存文本、一个存猫）迟早会有一处改了另一处没改，出现"头像配错名字"。
    // 【为什么是数组不是「话题→猫」的 map】图片加载失败要逐级降级
    //   （.png → 0.jpg → 占位图），降级靠 pageUtil.onImgError 的 data-list + data-index
    //   按下标读写 _thumbFallback，map 没法按下标索引，只能再绕一层把 key 拼出来。
    topicRow: [],
    listData: {},     // 当前推文
    imageUrls: [],    // 推文图片地址列表
    Comment: [],      // 评论列表
    showComment: true,// 无评论时显示占位提示
    isFeeder: false,  // 当前用户是否已注册（决定输入框提示文案；评论本身所有人都能看）
    canComment: false,// 能否发表评论：管理员 或 申请获批的用户（读 db.canPublish，与发布入口同一个答案）
    userId: '',       // 当前用户 openid
    audit: false,     // 是否开放评论（管理员后台开关）
    currentImageIndex: 0,
    recoverMode: false, // 回收站预览模式：内容来自 Delete 存档，只读，不展示评论区
    blocked: false,     // 推文已被封禁/下架：非管理入口打开 → 全屏封禁占位（禁止查看）
    titleCatId: '',     // 标题就是猫名时那只猫的 _id（空 = 标题不是猫名，标题前不画 🐱）
    titleHasCatIcon: false, // 标题里已经手写了 🐱 → 不重复画（避免出现两个猫头）
  },

  /** 页面加载：从分享链接可直接带 _id 打开；缺 _id 时兜底 */
  async onLoad(options) {
    guard.ensureNotBanned();
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
    // 管理入口（用户管理后台点被下架帖子）带 admin=1：仅该入口对「已封禁」内容放行，
    // 管理员经普通分享/直接访问打开同样显示封禁占位（2026-08-28 用户要求：封禁后分享不允许看）
    if (options.admin === '1') this._fromManage = true;
    this.getPage(options._id);                    // 加载推文内容
  },

  /** 获取当前用户状态（管理员/已注册用户/有无发布权） */
  async initUser() {
    await db.initUserState();
    this.setData({
      userId: app.globalData.userId,
      isFeeder: app.globalData.isFeeder,
      userInfo: app.globalData.userInfo,
      // 与 custom-tab-bar / someBooklet / addBooklet 读同一个判断式（db.canPublish）。
      // 自己写 isAdministrator || canPost 的话，迟早出现"加号没了但评论还能发"这种漏一处才发现的 bug。
      canComment: db.canPublish(),
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
        // 被封禁/下架的推文（软删除留存，不物理删）：普通用户一律不可查看；
        // 管理员也仅限「用户管理」后台入口（_fromManage）可查看——管理员经普通分享
        // 或直接访问打开同样显示封禁占位，确保封禁后的帖子分享出去看不到内容。
        if (data.hidden && !(app.globalData.isAdministrator && this._fromManage)) {
          this.setData({ blocked: true });
          return;
        }
        this.setData({ listData: data });
        this.setPhoto();      // 生成图片列表
        this.getRelative();   // 解析相关标签
        this.getComment();    // 加载评论
        this.matchTitleCat(); // 管理员长按标题直达猫咪编辑页：先算标题是不是猫名
      })
      .catch(err => { console.error(err); wx.showToast({ icon: 'none', title: '加载失败' }); });
  },

  /** 封禁占位：返回上一页（从分享直达时无上一页 → 回首页） */
  goBack() {
    wx.navigateBack({
      fail: function () { wx.reLaunch({ url: '/pages/index/index' }); }
    });
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
        // 官方推文：包内 logo 不占 COS 存档，按 officialLogo 标记补回首张
        const officialLogo = !!trash.pick(rec, 'officialLogo');
        if (officialLogo) imageUrls.unshift(cos.BUNDLED_LOGO);
        // 展示数据：从存档还原（新存档字段在 data 里、老存档在顶层）
        const data = {
          _id: rec._id,
          tittle: trash.pick(rec, 'tittle') || '',
          main: trash.pick(rec, 'main') || '',
          photoTime: trash.pick(rec, 'photoTime') || '',
          relative: trash.pick(rec, 'relative') || '',
          photoNum: imageUrls.length, // 预览轮播页码以实际展示图数为准（含 logo）
          officialLogo: officialLogo,
        };
        this._recoverMode = true;
        this._recoverArchiveId = rec._id;
        this.setData({ recoverMode: true, listData: data, imageUrls });
        this.getRelative(); // 解析相关标签（预览模式不加载评论）
      })
      .catch(err => { console.error(err); wx.showToast({ icon: 'none', title: '加载存档失败' }); });
  },

  /** 生成推文图片地址列表（图片路径：目录+标题+序号.jpg）。
   *  官方推文（officialLogo）：首张为包内 logo，其后是自有图（pageUrl 从 0 起）。 */
  setPhoto() {
    const imageUrls = [];
    const data = this.data.listData;
    if (data.officialLogo) imageUrls.push(cos.BUNDLED_LOGO); // 官方封面：包内 logo，不走 COS
    const tittle = data.tittle;
    for (let i = 0; i < (data.photoNum || 0); i++) {
      imageUrls.push(cos.pageUrl(tittle, i));
    }
    this.setData({ imageUrls });
  },

  /** 解析相关标签（topic.parse 兼容 "#肥仔#水晶" / "＃小梅" / "笨笨，小鸭" 等脏格式），
   *  并异步标记哪些话题是猫名（那些格子换成圆头像胶囊）。
   *  先按「全是普通话题」渲染一版，再等查询回来把猫名那几格换掉 —— 两者文字与位置
   *  完全相同，只有底色和左侧头像变，所以不会看到整行跳一下。查询失败时保持这一版。 */
  getRelative() {
    const relativeList = topic.parse(this.data.listData.relative);
    this.setData({ topicRow: relativeList.map((t) => ({ text: t, cat: null })) });
    this.markCatTopics(relativeList);
  },

  /** 标记话题里哪些是猫名（和 catDetail 一致）：真实名 name / 别名 otherName /
   *  曾用名 usedName / 昵称 nickname 任一字段含该话题独立词（支持 "肥猪/饭桶"、
   *  "猫哥 小奶猫" 这类分隔写法）。命中表必须按【话题名】做 key——胶囊上显示的是
   *  话题原文，别名话题（肥猪）要能直接命中发福那只猫。
   *  【为什么顺带产出 topicRow 而不是只给一个「是不是猫」的布尔】猫名话题要用那只猫的
   *  圆头像，光有布尔还得再查一次；而且 data-_id（长按进猫编辑页）也要那只猫的 _id。
   *  一次查询同时喂给头像、跳转和长按 —— 三处若各查一次、各判一次，迟早互相矛盾
   *  （此前正是这种"两处各判一次"导致过「胶囊有 🐱、长按却没反应」）。
   *  只读查询，失败静默（topicRow 保持 getRelative 里那版：整行按普通话题渲染）。 */
  async markCatTopics(list) {
    let matched = { topicCats: {} };
    if (list.length) {
      try {
        const filter = catForm.topicCatFilter(list);
        const found = filter ? await db.find('BITZH', filter, { limit: list.length * 5 }) : [];
        // 命中判断在 catForm.matchCatsByTopics（纯函数，有单测）
        matched = catForm.matchCatsByTopics(list, found);
      } catch (err) {
        console.error('查询话题猫失败', err);
      }
    }
    const topicCats = matched.topicCats;
    this.setData({
      topicRow: list.map((t) => {
        const cat = topicCats[t];
        if (!cat) return { text: t, cat: null };
        // 缩略图必须带照片版本号（photoVer），否则某只猫换了照片后这里仍显示微信缓存的旧图。
        // stampThumbs 是原地补字段并返回同一批对象：同一只猫被两个话题命中时传的是同一个
        // 对象，补两次结果相同，不会重复拼串。
        pageUtil.stampThumbs([cat], this.data.catUrl);
        return { text: t, cat: cat };
      }),
    });
  },

  /** 话题行圆头像加载失败 → 逐级降级 .png → 0.jpg → 占位图（逻辑在 utils/page.js，
   *  这里只做薄封装，与其余 6 个猫咪列表页写法一致）。
   *  依赖 data-list="topicRow" 与话题行同下标，见 data 里的注释。 */
  onCatImgError(e) {
    pageUtil.onImgError(this, e);
  },

  /** 点击相关标签：若对应猫咪存在则打开猫详情（真实名 / 别名 / 曾用名 / 绰号都能命中），
   *  否则按标签搜索推文 */
  toRelative(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    // 一次查询：真实名/别名/曾用名/昵称任一字段含该话题独立词 → 取第一只命中猫
    findCatByName(name)
      .then((cat) => {
        if (cat) {
          wx.navigateTo({ url: '/pages/catDetail/catDetail?_id=' + cat._id });
        } else {
          wx.navigateTo({ url: '/pages/someBooklet/someBooklet?name=' + name + '&isName=false' });
        }
      })
      .catch(err => console.error(err));
  },

  /** 标题是不是某只猫的名字？命中则记下那只猫的 _id，用来在标题前画 🐱。
   *  判断口径与话题胶囊完全一致（共用 findCatByName），标题带不带猫头都能命中。
   *  这里只负责「画不画猫头」这一件事——标题本身不响应任何手势（长按编辑猫走
   *  的是话题胶囊的 editCat），所以算出的 _id 只用于这个 🐱。
   *  只有管理员需要 → 非管理员直接跳过，省一次查询。只读查询，失败静默。 */
  async matchTitleCat() {
    if (!app.globalData.isAdministrator) return;
    const raw = String((this.data.listData || {}).tittle || '');
    const hasCatIcon = /🐱|🐈/.test(raw); // 管理员自己手写了猫头 → 不重复画
    const tittle = stripTitleDecor(raw);
    if (!tittle) { this.setData({ titleCatId: '', titleHasCatIcon: hasCatIcon }); return; }
    try {
      const cat = await findCatByName(tittle, hasCatIcon);
      this.setData({ titleCatId: cat ? cat._id : '', titleHasCatIcon: hasCatIcon });
    } catch (err) {
      console.error('查询标题猫失败', err);
    }
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
        // 软删除的评论不展示（保留在库中供取证）
        const visible = (list || []).filter((c) => !c.deleted);
        this.setData({
          Comment: visible,
          showComment: visible.length === 0,
        });
      })
      .catch(err => { console.error(err); wx.showToast({ icon: 'none', title: '加载评论失败' }); });
  },

  /** 输入评论内容 */
  inputText(e) {
    this.setData({ comment: e.detail.value });
  },

  /** 发表评论 */
  async addComment() {
    // 【这是 UX 闸门，不是安全边界】clientSecret 随小程序包发布，逆向者可以绕过本页
    //   直接 insertOne('Comment', ...)。要真堵得把评论写入搬到云函数 + 控制台集合权限规则，
    //   本期不做（与 guard.js、utils/adminManage.js 的既有立场一致）。但门槛仍然有意义：
    //   它挡住的是"正常用户随手就能发"，这覆盖了绝大多数情况。
    if (db.canPublish()) {
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
      // 内容安全审核评论（写库前拦截，自带 loading）
      const _passed = await secCheck.guardBeforePublish(content, 2);
      if (!_passed) {
        guard.resetThrottle('addComment'); // 拦截：改完可立即重提
        return;
      }
      const myCommentId = Math.floor(Math.random() * 1000000000000);
      const formattedTime = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const userInfo = app.globalData.userInfo || {};
      // 作者头像安全兜底：本地临时路径（wxfile:// / http://tmp）写进库里会立即失效，
      // 且会随评论扩散成脏数据。本地路径一律不写，自动兜底成 COS 地址（nickName 对应用户头像文件）。
      const rawAvatar = typeof userInfo.avatarUrl === 'string' ? userInfo.avatarUrl : '';
      const isLocalAvatar = rawAvatar.indexOf('wxfile://') === 0 || rawAvatar.indexOf('http://tmp') === 0;
      const authorImg = isLocalAvatar ? cos.profileUrl(userInfo.nickName) : rawAvatar;
      db.insertOne('Comment', {
        author: guard.toText(userInfo.nickName),
        authorId: app.globalData.userId || userInfo.userId || '',
        authorImg,
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
    } else if (app.globalData.isFeeder) {
      // 已注册但还没获批：别弹"请先注册"（他已经注册了），要说清楚下一步怎么做
      wx.showToast({ icon: 'none', title: '还没有发布权限，请到「我的」申请', duration: 2500 });
    } else {
      pageUtil.promptRegister(this.data.userId);
    }
  },

  /** 长按评论：弹出"修改/删除/举报"菜单 */
  choseComment(e) {
    const authorId = e.currentTarget.dataset.authorid;
    const myCommentId = e.currentTarget.dataset.mycommentid;
    const main = e.currentTarget.dataset.main;
    const authorName = e.currentTarget.dataset.author || '';
    wx.showActionSheet({
      itemList: ['修改评论', '删除评论', '举报'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.modifyComment(authorId, myCommentId, main);
        } else if (res.tapIndex === 1) {
          this.deleteComment(authorId, myCommentId);
        } else if (res.tapIndex === 2) {
          this.reportComment(authorId, myCommentId, main, authorName);
        }
      },
    });
  },

  /** 举报评论：跳举报页（带目标类型/ID/内容快照/作者） */
  reportComment(authorId, myCommentId, main, authorName) {
    wx.navigateTo({
      url: '/pages/report/report?type=comment&targetId=' + myCommentId +
        '&content=' + encodeURIComponent(String(main || '').slice(0, 200)) +
        '&targetAuthorId=' + (authorId || '') +
        '&targetAuthorName=' + encodeURIComponent(authorName || ''),
    });
  },

  /** 举报推文：跳举报页 */
  reportPage() {
    const data = this.data.listData || {};
    const content = ((data.tittle || '') + ' ' + (data.main || '')).slice(0, 200);
    wx.navigateTo({
      url: '/pages/report/report?type=page&targetId=' + (data._id || '') +
        '&content=' + encodeURIComponent(content) +
        '&targetAuthorId=' + (data.authorId || '') +
        '&targetAuthorName=' + encodeURIComponent(data.author || ''),
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
          // 软删除（不物理删，取证留存）
          db.softDeleteComment(myCommentId, app.globalData.isAdministrator ? '管理员' : '作者本人')
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
      success: async (res) => {
        if (res.confirm) {
          // 内容安全审核修改后的评论（写库前拦截，自带 loading）
          const _passed = await secCheck.guardBeforePublish(res.content, 2);
          if (!_passed) {
            guard.resetThrottle('modComment'); // 拦截：改完可立即重提
            return;
          }
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

  /** 长按话题胶囊：管理员直达那只猫的编辑页（wxml 上 bindlongpress="editCat" data-_id）。
   *  写法和 catDetail 的 editCat、长按推文图片的 editBooklet 完全一致：_id 直接来自
   *  data-_id（由 markCatTopics 那次查询一并算好），函数只做「判权限 + 跳转」两件事，
   *  不做任何异步查询 —— 越简单越不会"按了没反应"。
   *  话题不是猫名时 data-_id 为空 → 什么都不做（那种话题只有"点击搜文章"的行为）。
   *  长按触发后微信不会再补一个 tap，所以不会连带打开猫详情页。 */
  editCat(e) {
    if (!app.globalData.isAdministrator) return;
    const _id = e.currentTarget.dataset._id;
    if (!_id) return;
    wx.navigateTo({ url: '/pages/editCat/editCat?_id=' + _id });
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
    // 包内 logo（官方推文默认封面）不是网络/临时图，微信原生预览不支持包内路径：
    // 预览列表剔除 logo；当前正好是 logo 时从第一张自有图开始看
    const urls = this.data.imageUrls.filter((u) => !cos.isBundledLogo(u));
    if (!urls.length) return;
    const cur = this.data.imageUrls[this.data.currentImageIndex];
    wx.previewImage({
      urls: urls,
      current: (!cos.isBundledLogo(cur) && cur) || urls[0],
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
