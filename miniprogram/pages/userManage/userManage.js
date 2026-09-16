// ============================================================
// pages/userManage/userManage.js —— 用户管理 / 黑名单（仅管理员）
// 【作用】管理员在此集中管理用户与黑名单：
//   1. 按昵称（模糊）或用户ID（精确）搜索用户，展示头像、昵称、完整 openid（可复制）
//   2. 展示该用户发过的帖子（含已下架的，标注 hidden）
//   3. 一键封禁（可填原因）/ 一键解封
//   4. 一键禁言 / 解除禁言（只停发帖评论，**不动已发内容**）
//   5. 展示全部黑名单，列表内可一键解封（防误删/误封）
// 【说明】封禁/解封/禁言统一走 moderate 云函数（软删+拉黑，取证留存）。
// 【封禁与禁言的区别，界面上别混】封禁 = 拉黑 + 软删其全部内容（重）；
//   禁言 = 只掐掉发帖/评论能力，内容一条不动、也不进黑名单（轻）。
//   两者正交，可以只禁言不拉黑。判定式在 utils/publishGate.js。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const guard = require('../../utils/guard.js'); // 前端保险工具
const moderate = require('../../utils/moderate.js'); // 内容安全执行器（封禁/解封走云函数）
const adminApi = require('../../utils/adminManage.js'); // 动态词库（封禁后问到的关键词写这里）
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）
const clipboard = require('../../utils/clipboard.js'); // 复制到剪贴板（统一反馈 + 隐私授权兜底）

// 微信默认头像（用户从未上传头像时的占位，与 regist 页一致）
const DEFAULT_AVATAR = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0';

/**
 * moderate 云函数返回 ok:false 时抛异常，交给调用方的 catch 统一提示。
 * 【为什么需要】moderate.invoke 只把 res.result 解包出来，**不会因为 ok:false 而 reject** ——
 *   不检查的话，"禁言自己"这种被服务端明确拒绝（SELF_MUTE）的操作，界面照样会弹「已禁言」，
 *   管理员会以为生效了，直到对方还能发帖才发现。
 */
function ensureModOk(res) {
  if (res && res.ok === false) {
    const err = new Error(res.msg || '操作失败');
    err.code = res.code || '';
    throw err;
  }
  return res;
}

/** 时间格式化（Date → "YYYY-MM-DD HH:mm"），脏值返回空串 */
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
    defaultAvatar: DEFAULT_AVATAR, // 未上传头像时的占位图
    keyword: '',          // 搜索关键词（昵称 / 用户ID）
    searching: false,     // 是否正在搜索
    results: [],          // 搜索结果（用户卡片列表）
    expandedUserId: '',   // 当前展开帖子列表的用户 openid（空=收起）
    blackList: [],        // 黑名单列表（含昵称/头像/原因）
    blackLoaded: false,   // 黑名单是否已加载（用于空态/加载态）
  },

  /** 页面加载：校验管理员身份 + 自动加载黑名单；支持 index 入口带 userId 直达 */
  async onLoad(options) {
    guard.ensureNotBanned();
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    this.loadBlackList();
    // 从 index 搜索入口点进来：优先用 index 已查好的用户数据（含帖子），免重复搜索，跳转更快
    const seed = app.globalData.userManageSeed || null;
    app.globalData.userManageSeed = null; // 用完即清，防脏数据残留
    if (seed && seed.userId && options && options.userId === seed.userId) {
      this.applySeed(seed);
      return;
    }
    if (options && options.userId) {
      this.setData({ keyword: options.userId });
      this.searchUsers(options.userId);
    }
  },

  /** 用 index 传来的已查数据直接渲染用户卡片（帖子已带，直接展开），并补查黑名单状态 */
  applySeed(seed) {
    const user = Object.assign({}, seed, {
      isBlack: false,
      // seed 是整篇 Feeder 文档（index 那边查出来的），mutePost 就在里面，不必额外查一次
      isMuted: !!seed.mutePost,
      postsLoaded: true,  // 帖子已查好，无需再拉
      postsLoading: false,
    });
    this.setData({
      keyword: seed.nickName || seed.userId,
      results: [user],
      expandedUserId: seed.userId, // 进页即展开帖子列表
    });
    // 补查黑名单状态（seed 来自 index，未带 isBlack）
    db.find('BlackNum', { id: seed.userId }).then((bs) => {
      if (bs && bs.length && this.data.results[0] && this.data.results[0].userId === seed.userId) {
        setField(this, 'results[0].isBlack', true);
      }
    }).catch((err) => console.error('[userManage] 黑名单状态查询失败', err));
  },

  /** 搜索框输入 */
  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  /** 搜索（按钮 / 回车） */
  onSearchTap() {
    const kw = (this.data.keyword || '').trim();
    if (!kw) {
      wx.showToast({ title: '请输入昵称或ID', icon: 'none' });
      return;
    }
    this.searchUsers(kw);
  },

  /** 搜索用户：昵称模糊 + 用户ID精确，结果按 _id 去重合并 */
  async searchUsers(kw) {
    const keyword = (kw || '').trim();
    if (!keyword) return;
    this.setData({ searching: true, results: [], expandedUserId: '' });
    try {
      const re = guard.escapeRegExp(keyword);
      const [byId, byName] = await Promise.all([
        // 精确匹配 openid（ID 搜索）
        db.find('Feeder', { userId: keyword }, { limit: 5 }),
        // 昵称模糊匹配（防正则注入：escapeRegExp）
        db.find('Feeder', { nickName: { $regex: re, $options: 'i' } }, { limit: 20 }),
      ]);
      // 按 _id 去重合并
      const map = {};
      (byId || []).concat(byName || []).forEach((u) => {
        if (u && u._id && !map[u._id]) map[u._id] = u;
      });
      const users = Object.keys(map).map((k) => map[k]);
      // 批量查黑名单状态（BlackNum.id = 用户 openid）
      const ids = users.map((u) => u.userId).filter(Boolean);
      let blackMap = {};
      if (ids.length) {
        const blacks = await db.find('BlackNum', { id: { $in: ids } }, { limit: 100 });
        (blacks || []).forEach((b) => { if (b && b.id) blackMap[b.id] = true; });
      }
      users.forEach((u) => {
        u.isBlack = !!blackMap[u.userId];
        // 禁言状态直接读 Feeder.mutePost —— 搜索结果本身就是 Feeder 文档，零额外查询。
        // （黑名单要额外查 BlackNum，因为它是另一个集合；禁言不是。）
        u.isMuted = !!u.mutePost;
        u.posts = [];
        u.postsLoaded = false;
        u.postsLoading = false;
      });
      this.setData({ results: users });
      if (!users.length) {
        wx.showToast({ title: '未找到该用户', icon: 'none' });
      }
    } catch (err) {
      console.error('[userManage] 搜索失败', err);
      wx.showToast({ title: '搜索失败', icon: 'none' });
    }
    this.setData({ searching: false });
  },

  /** 展开 / 收起某用户的帖子列表（含已下架的，标注 hidden） */
  async toggleExpand(e) {
    const userId = e.currentTarget.dataset.userid;
    if (this.data.expandedUserId === userId) {
      this.setData({ expandedUserId: '' });
      return;
    }
    this.setData({ expandedUserId: userId });
    const idx = this.data.results.findIndex((u) => u.userId === userId);
    if (idx < 0) return;
    const user = this.data.results[idx];
    if (user.postsLoaded || user.postsLoading) return;
    setField(this, 'results[' + idx + '].postsLoading', true);
    try {
      // 注意：不过滤 hidden，管理员要能看被封禁用户被下架的帖子
      const posts = await db.find('Page', { authorId: userId }, { sort: { pageTime: -1 }, limit: 10 });
      const rows = (posts || []).map((p) => ({
        _id: p._id,
        tittle: p.tittle || '（无标题）',
        timeText: fmtTime(p.pageTime || p.photoTime),
        hidden: !!p.hidden,
      }));
      setField(this, 'results[' + idx + '].posts', rows);
      setField(this, 'results[' + idx + '].postsLoaded', true);
      setField(this, 'results[' + idx + '].postsLoading', false);
    } catch (err) {
      console.error('[userManage] 加载发帖失败', err);
      setField(this, 'results[' + idx + '].postsLoading', false);
      wx.showToast({ title: '加载发帖失败', icon: 'none' });
    }
  },

  /** 点击帖子行 → 跳转推文详情页看原文（带 admin=1：管理入口可查看已封禁内容，普通分享则被拦截） */
  toPostDetail(e) {
    const _id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/bookletDetail/bookletDetail?_id=' + _id + '&admin=1' });
  },

  /** 复制用户 openid / ID（统一走 utils/clipboard.js：成功/失败都有提示 + 隐私授权兜底） */
  copyId(e) {
    clipboard.copy(e.currentTarget.dataset.userid, '用户ID');
  },

  /** 用户头像加载失败 → 回退微信默认头像（COS 头像可能失效/被删） */
  onAvatarError(e) {
    const idx = e.currentTarget.dataset.index;
    const list = e.currentTarget.dataset.list; // 'results' | 'blackList'
    if (!list || idx === undefined) return;
    setField(this, list + '[' + idx + '].avatarUrl', DEFAULT_AVATAR);
  },

  /** 一键封禁（带原因弹窗，原因写入 BlackNum 备查） */
  async banUser(e) {
    const userId = e.currentTarget.dataset.userid;
    const name = e.currentTarget.dataset.name || '';
    if (!guard.throttle('userManage.ban', 2000)) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '确认封禁',
        content: '封禁用户：' + (name || userId) + '\n将软删其全部推文/评论并拉黑。',
        editable: true,
        placeholderText: '封禁原因（可选）',
        confirmColor: 'red',
        success: (r) => resolve({ ok: !!r.confirm, reason: (r.content || '').trim() }),
        fail: () => resolve({ ok: false }),
      });
    });
    if (!confirmed.ok) return;
    try {
      ensureModOk(await moderate.ban(userId, confirmed.reason || '管理员手动封禁'));
      wx.showToast({ title: '已封禁', icon: 'success' });
      // 刷新搜索结果的黑名单状态 + 刷新黑名单列表
      this.searchUsers(this.data.keyword);
      this.loadBlackList();
    } catch (err) {
      console.error('[userManage] 封禁失败', err);
      wx.showToast({ title: (err && err.message) || '封禁失败', icon: 'none' });
      return; // 🔴 封禁没成功就**不要**再问关键词：词是从这次违规里来的，动作没落地就不该入库
    }
    // 封禁已生效，之后才问关键词（顺序刻意，见 askKeyword 注释）
    await this.askKeyword();
  },

  /**
   * 一键禁言：只停发帖 / 评论，**已发内容一条不动**，也不进黑名单。
   * 与「封禁」是两个独立按钮 —— 刷屏/吵架用这个，恶意/违法才用封禁。
   */
  async muteUser(e) {
    const userId = e.currentTarget.dataset.userid;
    const name = e.currentTarget.dataset.name || '';
    if (!guard.throttle('userManage.mute', 2000)) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '确认禁言',
        // 【文案里不要写 markdown】wx.showModal 不渲染 ** 之类，会原样显示出来
        content: '禁言用户：' + (name || userId) + '\n他将不能再发帖 / 评论，已发的内容全部保留，也不进黑名单。',
        editable: true,
        placeholderText: '禁言原因（可选）',
        success: (r) => resolve({ ok: !!r.confirm, reason: (r.content || '').trim() }),
        fail: () => resolve({ ok: false }),
      });
    });
    if (!confirmed.ok) return;
    try {
      ensureModOk(await moderate.mute(userId, confirmed.reason || '管理员手动禁言'));
      wx.showToast({ title: '已禁言', icon: 'success' });
      this.searchUsers(this.data.keyword);
    } catch (err) {
      console.error('[userManage] 禁言失败', err);
      // SELF_MUTE 是服务端刻意的守卫（否则管理员能把自己永久锁死），它的 msg 已经写清楚了
      wx.showToast({ title: (err && err.message) || '禁言失败', icon: 'none', duration: 2500 });
      return;
    }
    await this.askKeyword();
  },

  /** 解除禁言：只把 mutePost 拿掉，不恢复也不授予任何发布权（canPost 全程没被动过） */
  async unmuteUser(e) {
    const userId = e.currentTarget.dataset.userid;
    const name = e.currentTarget.dataset.name || '';
    if (!guard.throttle('userManage.unmute', 2000)) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '解除禁言',
        content: '解除对 ' + (name || userId) + ' 的禁言？\n\n解除后他可以重新发帖 / 评论（前提是他本来就有发布权限）。',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    try {
      ensureModOk(await moderate.unmute(userId));
      wx.showToast({ title: '已解除禁言', icon: 'success' });
      this.searchUsers(this.data.keyword);
    } catch (err) {
      console.error('[userManage] 解除禁言失败', err);
      wx.showToast({ title: (err && err.message) || '解除禁言失败', icon: 'none' });
    }
  },

  /**
   * 问一句「这次的违规关键词是什么」，答了就把词加进动态词库（立刻生效）。
   * 🔴 **调用时机是刻意的：必须在封禁/禁言已经落地之后。**
   *    关键词是可选的（用户明确要求「不回答也继续封禁」），如果先问，
   *    "不答"就变成了"动作卡住"。所以本函数自己的任何失败 —— 包括没填密码 ——
   *    最多让关键词没入库，**绝不能影响已经生效的封禁**，因此它只 toast 不抛。
   * 【为什么要问】事后管理员在词库里想不起来该加什么词：违规现场就在眼前时问，最省事。
   */
  async askKeyword() {
    const typed = await new Promise((resolve) => {
      wx.showModal({
        title: '加入敏感词库？',
        content: '如果这次是因为某个词 / 说法违规（如「网络虐猫」），填在这里就一并入库，'
          + '以后含它的内容会被直接拒绝发布。\n\n留空跳过也行，封禁 / 禁言已经生效了。',
        editable: true,
        placeholderText: '违规关键词（可留空跳过）',
        confirmText: '确定',
        success: (r) => resolve(r.confirm ? (r.content || '').trim() : ''),
        fail: () => resolve(''),
      });
    });
    if (!typed) return; // 留空或取消：什么都不做，动作照旧
    try {
      const res = await adminApi.addWord(typed, 'block');
      adminApi.ensureOk(res);
      // res.added=false 表示这个词本来就在（服务端是幂等的），措辞要区分开
      wx.showToast({
        title: res.added ? ('已入库：' + typed) : ('词库已有「' + typed + '」'),
        icon: 'none',
        duration: 2500,
      });
    } catch (err) {
      const code = (err && err.code) || '';
      console.warn('[userManage] 关键词入库失败', code, (err && err.message) || err);
      // 最可能的情况是**管理员还没在「管理员」页填过操作密码**（词库写入是密码门禁的）。
      // 这里要把"动作成功、只有词没进去"说清楚，否则管理员会以为封禁也失败了。
      const tip = (code === 'NEED_PASSWORD' || code === 'BAD_PASSWORD')
        ? '关键词未入库：请先在「管理员」页填写操作密码'
        : ('关键词未入库：' + ((err && err.message) || '可在「管理员」→「敏感词库」里手动添加'));
      wx.showToast({ title: tip, icon: 'none', duration: 3000 });
    }
  },

  /** 一键解封 */
  async unbanUser(e) {
    const userId = e.currentTarget.dataset.userid;
    const name = e.currentTarget.dataset.name || '';
    if (!guard.throttle('userManage.unban', 2000)) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '确认解封',
        content: '解封用户：' + (name || userId) + '\n将恢复其推文/评论可见并移出黑名单。',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    try {
      ensureModOk(await moderate.unban(userId));
      wx.showToast({ title: '已解封', icon: 'success' });
      this.searchUsers(this.data.keyword);
      this.loadBlackList();
    } catch (err) {
      console.error('[userManage] 解封失败', err);
      wx.showToast({ title: (err && err.message) || '解封失败', icon: 'none' });
    }
  },

  /** 加载全部黑名单（含昵称/头像），供列表内一键解封 */
  async loadBlackList() {
    try {
      const list = await db.find('BlackNum', {}, { sort: { time: -1 }, limit: 100 });
      const ids = (list || []).map((b) => b.id).filter(Boolean);
      let fmap = {};
      if (ids.length) {
        const feeders = await db.find('Feeder', { userId: { $in: ids } }, { limit: 100 });
        (feeders || []).forEach((f) => { if (f && f.userId) fmap[f.userId] = f; });
      }
      const rows = (list || []).map((b) => {
        const f = fmap[b.id] || {};
        return {
          id: b.id,
          nickName: f.nickName || '（无资料）',
          avatarUrl: f.avatarUrl || '',
          timeText: fmtTime(b.time),
          reason: b.reason || '',
          permanent: !!b.permanent,
        };
      });
      this.setData({ blackList: rows, blackLoaded: true });
    } catch (err) {
      console.error('[userManage] 加载黑名单失败', err);
      this.setData({ blackLoaded: true });
    }
  },
});
