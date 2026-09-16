// ============================================================
// pages/adminManage/adminManage.js —— 在线添加 / 移除管理员 + 发布申请审批（仅管理员）
// 【作用】不打开控制台就能增删管理员、审批发布权限，代价是每次操作都要输服务端密码：
//   1. 输入操作密码 → 拉取当前管理员列表 + 待审批的发布申请（密码错了会按 IP 锁定，见云函数）
//   2. 搜索用户（昵称模糊 / 用户ID精确）→ 一键设为管理员
//   3. 列表内移除管理员（服务端拒绝移除自己、拒绝移除最后一位）
//   4. 「发布申请」队列：通过 → 该用户永久获得发布权；拒绝 → 只标记这条申请，不动已有权限
//
// 【本页只做界面，不做安全判断】"是不是管理员"由云函数独立判定，"密码对不对"也在云函数里比。
//   客户端读 db.state.isAdministrator 只是为了**提前把页面关掉**（少一次白跑的调用），
//   它挡不住真想进来的人：miniprogram/config.js 的 clientSecret 随包发出，反编译即可绕过本页
//   直接写 BITZHAdministrator。真正的收口是云函数 + 集合权限规则（见 README 第六.5 节）。
//
// 【密码的存活范围】只在 this.data.password 里，页面销毁即消失。
//   绝不 wx.setStorage、绝不进 globalData —— 这两处都会落到磁盘/长生命周期对象上。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法（这里只用它的身份缓存）
const guard = require('../../utils/guard.js'); // 前端保险工具
const adminApi = require('../../utils/adminManage.js'); // 管理员增删（走云函数）
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）
const clipboard = require('../../utils/clipboard.js'); // 复制到剪贴板（统一反馈 + 隐私授权兜底）

// 微信默认头像（用户从未上传头像时的占位，与 userManage 页一致）
const DEFAULT_AVATAR = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0';

// 出错时用弹窗（而不是一闪而过的 toast）展示的错误码：这些提示都比较长，toast 装不下会被截断
// BLACKLISTED：审批时被黑名单一票否决 —— 这条必须让人看清，否则管理员会反复点"通过"不知道为什么没反应
const MODAL_CODES = ['TOO_MANY', 'SELF_REVOKE', 'LAST_ADMIN', 'NOT_FEEDER', 'BAD_USER_ID', 'LOOKUP_FAILED', 'BLACKLISTED'];

// 真实姓名长度上限。**必须与服务端 sanitizeName 的截断长度一致**（cloudfunctions/adminManage/index.js）。
// 前端先拦一道，是为了不让用户填完 30 个字、提交后被服务端**静默截成 20 个**——
// 那种"看到的和存下来的不一样"最难排查。服务端那道截断仍然留着（不能只信前端）。
const ADMIN_NAME_MAX = 20;

// 加/删管理员后要告诉操作者的话。
// 【为什么必须是"完全退出小程序"，而不是"刷新一下"】utils/db.js 的 state.administratorChecked
//   把"我是不是管理员"缓存在**本次运行**里（模块级 state，不落盘）。initUserState() 虽然很多页面
//   onLoad 都会调，但缓存为真时它直接返回，不会重查数据库。于是：
//     - 返回上一页 / 切到后台再回来 → JS 上下文还在，缓存还在，判定**不会**更新；
//     - 完全退出（从"最近使用"划掉或右上角关闭）再进来 → 冷启动，缓存清空，才会重新查。
//   这个缓存**只能由对方的客户端清**，我们这边做不到，所以只能把话说明白。
// 【文案里不要写 markdown】wx.showModal 不渲染 ** 之类，会原样显示。
const RESTART_HINT_ADD = '对方需要完全退出小程序再重新进入（从"最近使用"里划掉，或右上角关闭），管理入口才会出现。\n\n只是返回上一页、或切到后台再回来，都不算重新进入。';
const RESTART_HINT_REMOVE = '若对方此刻正开着小程序，他手上的管理入口会保留到他重新进入为止 —— 要立刻生效，让他完全退出小程序（从"最近使用"里划掉，或右上角关闭）。';
// 通过发布申请后要说的话。与上面同理：canPost 和"我是不是管理员"一样缓存在本次运行里，
// 只有对方冷启动才能读到新值 —— 我们这边做不到，只能把话说明白。
const RESTART_HINT_POST = '对方需要完全退出小程序再重新进入（从"最近使用"里划掉，或右上角关闭），加号和评论框才会出现。\n\n只是返回上一页、或切到后台再回来，都不算重新进入。';

/**
 * 确认弹窗（Promise 版）。
 * 写法抄自 pages/reviewCenter/reviewCenter.js：**先弹窗、再限频**，
 * 取消弹窗不消耗节流窗口 —— 用户点了「取消」等于什么都没做，不该被限频。
 * （本仓库里两种顺序都有：userManage.banUser / Administrator 是先限频后弹窗，
 *   对破坏性操作采用 reviewCenter 这种更合理的顺序。）
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

Page({
  data: {
    defaultAvatar: DEFAULT_AVATAR,
    ready: false,        // 管理员校验通过后才渲染内容（避免非管理员看到一闪而过的界面）

    // ---- 密码与解锁状态 ----
    password: '',        // 操作密码（只在内存里，见文件头说明）
    unlocked: false,     // 是否已成功拉取过一次列表
    adminsLoading: false,

    // ---- 身份模式（如实展示：可信=两道锁，不可信=只有密码一道锁）----
    identityMode: '',    // 'trusted' | 'untrusted' | ''（未取到）
    trusted: false,      // identityMode === 'trusted'

    // ---- 管理员列表 ----
    admins: [],          // [{userId, name, nickName, avatarUrl, isSelf, grantedTimeText, displayName}]

    // ---- 发布申请（待审批队列）----
    applies: [],         // [{applyId, userId, nickName, avatarUrl, appliedAtText}]
    appliesLoading: false,
    actingApply: '',     // 正在审批的 applyId（两个按钮都显示"提交中…"并置灰）

    // ---- 搜索添加 ----
    keyword: '',
    searching: false,
    results: [],         // [{userId, nickName, avatarUrl, isAdmin, isSelf}]（不含 displayName：搜索结果只显示昵称，不再带进弹窗）
    searched: false,     // 是否搜过（空态的显示依据）

    acting: '',          // 正在提交的用户ID（按钮显示"提交中…"并置灰）
  },

  /** 页面加载：黑名单拦截 → 载入身份缓存 → 非管理员直接挡回 */
  async onLoad() {
    guard.ensureNotBanned();
    await db.initUserState();
    // requireAdmin 只读客户端的缓存判断，作用是"提前关页面"，不是安全边界（见文件头）
    if (!guard.requireAdmin()) return;
    this.setData({ ready: true });
  },

  /** 密码输入 */
  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  /**
   * 点「解锁 / 刷新」：先拉管理员列表，成功了再拉发布申请。
   * 【为什么是串行而不是 Promise.all】两个请求带的是同一个密码，密码错时会**双双失败**，
   *   于是弹出两个内容一样的错误弹窗，第二个还把第一个盖掉、看起来像卡了。
   *   串行则只有先失败的那个会弹，另一路直接不发 —— 密码是这一切的前置条件，本来也该串行。
   */
  async onUnlockTap() {
    const ok = await this.loadAdmins();
    if (!ok) return; // 失败原因 loadAdmins 已经弹过了
    await this.loadApplies();
  },

  /**
   * 拉取管理员列表（同时充当"验证密码是否正确"的动作）。
   * @returns {Promise<boolean>} 是否成功 —— 调用方靠它决定要不要继续做后续请求
   */
  async loadAdmins() {
    const pw = this.data.password || '';
    if (!pw) {
      wx.showToast({ title: '请先输入操作密码', icon: 'none' });
      return false;
    }
    if (this.data.adminsLoading) return false;
    this.setData({ adminsLoading: true });
    try {
      const res = await adminApi.list(pw);
      adminApi.ensureOk(res);
      // 服务端返回 nickname/avatar 是为了页面直接渲染；这里补齐展示用字段
      const admins = (res.admins || []).map((a) => Object.assign({}, a, {
        avatarUrl: a.avatarUrl || DEFAULT_AVATAR,
        displayName: a.name || a.nickName || '（未命名管理员）',
      }));
      this.setData({
        admins: admins,
        unlocked: true,
        identityMode: res.identityMode || 'untrusted',
        trusted: res.identityMode === 'trusted',
      });
      // 列表已经拿到了，把搜索结果里的"已是管理员"标记同步一遍
      this.markResultsAdmin();
      this.setData({ adminsLoading: false });
      return true;
    } catch (err) {
      this.handleError(err);
      this.setData({ adminsLoading: false });
      return false;
    }
  },

  // ============ 发布申请（待审批队列）============

  /**
   * 拉取待审批的发布申请。
   * 【只拉 pending】已通过/已拒绝的不再展示 —— 这个区块是待办队列，不是历史记录。
   *   做完一条它就消失，管理员不用猜"这条我处理过没有"。
   */
  async loadApplies() {
    if (!this.data.unlocked) return; // 密码还没验过，查了也是白查（且会白弹一个错误）
    if (this.data.appliesLoading) return;
    this.setData({ appliesLoading: true });
    try {
      const res = await adminApi.listApplies(this.data.password || '');
      adminApi.ensureOk(res);
      const applies = (res.applies || []).map((a) => Object.assign({}, a, {
        avatarUrl: a.avatarUrl || DEFAULT_AVATAR,
      }));
      this.setData({ applies: applies });
    } catch (err) {
      this.handleError(err);
    }
    this.setData({ appliesLoading: false });
  },

  /** 通过发布申请 → 该用户永久获得发布权（写入在云函数，这里只发起） */
  async approvePost(e) {
    const d = e.currentTarget.dataset;
    const userId = d.userid;
    const applyId = d.applyid;
    const name = d.name || userId;
    const pw = this.data.password || '';
    if (!pw) {
      wx.showToast({ title: '请先输入操作密码并解锁', icon: 'none' });
      return;
    }
    if (this.data.actingApply) return;

    const confirmed = await confirmAction(
      '通过发布申请',
      '通过「' + name + '」的发布申请？\n\n通过后对方永久获得发布帖子和评论的权限。',
      '确认通过'
    );
    if (!confirmed) return; // 取消：不做任何操作，也不消耗节流窗口
    if (!guard.throttle('adminManage.approvePost', 2000)) return;

    this.setData({ actingApply: applyId });
    try {
      const res = await adminApi.approvePost(userId, applyId, pw);
      adminApi.ensureOk(res);
      guard.resetThrottle('adminManage.approvePost');
      await this.loadApplies();
      // 提示放在列表刷新之后：关掉弹窗时这条申请已经从队列里消失了，能立刻看到效果。
      // 【弹窗文案里不要写 markdown】wx.showModal 不渲染 ** 之类，会原样显示。
      wx.showModal({
        title: '已通过',
        content: '已通过「' + (res.nickName || name) + '」的发布申请。\n\n' + RESTART_HINT_POST,
        showCancel: false,
        confirmText: '知道了',
      });
    } catch (err) {
      this.handleError(err);
    }
    this.setData({ actingApply: '' });
  },

  /** 拒绝发布申请 → 只标记这条申请，不收回对方已有的任何权限 */
  async rejectPost(e) {
    const d = e.currentTarget.dataset;
    const userId = d.userid;
    const applyId = d.applyid;
    const name = d.name || userId;
    const pw = this.data.password || '';
    if (!pw) {
      wx.showToast({ title: '请先输入操作密码并解锁', icon: 'none' });
      return;
    }
    if (this.data.actingApply) return;

    const confirmed = await confirmAction(
      '拒绝发布申请',
      '拒绝「' + name + '」的发布申请？\n\n只会把这条申请标为已拒绝，不会收回对方已有的任何权限。对方今天不能再申请，明天起可以重新申请。',
      '确认拒绝',
      '#c0392b'
    );
    if (!confirmed) return; // 取消：不做任何操作，也不消耗节流窗口
    if (!guard.throttle('adminManage.rejectPost', 2000)) return;

    this.setData({ actingApply: applyId });
    try {
      const res = await adminApi.rejectPost(userId, applyId, pw);
      adminApi.ensureOk(res);
      guard.resetThrottle('adminManage.rejectPost');
      await this.loadApplies();
      // 拒绝是非破坏性操作（没动对方任何已有权限），一句 toast 就够，不用弹窗打断
      wx.showToast({ title: '已拒绝', icon: 'success' });
    } catch (err) {
      this.handleError(err);
    }
    this.setData({ actingApply: '' });
  },

  /**
   * 问「真实姓名」的可编辑弹窗。
   * 【没有 content 是故意的】wx.showModal 在 editable:true 时，content 有可能被当成输入框的
   *   初始值（各版本行为不一致）。写说明文字进去，用户就得先删掉那段话才能填名字。
   *   所以这里只留 title + 输入框：要加人被点的那个搜索结果卡片就在眼前，是谁不需要再说一遍。
   * 【取值为什么两个字段都读】输入值的返回字段，官方文档与各版本实践里 res.content / res.value
   *   两种说法都有。两个都读，避免某一端拿到 undefined 而把空名字静默提交上去。
   */
  askAdminName() {
    return new Promise((resolve) => {
      wx.showModal({
        title: '设为管理员',
        editable: true,
        placeholderText: '真实姓名',
        confirmText: '确认添加',
        confirmColor: '#FF405E',
        success: (r) => resolve({
          ok: !!r.confirm,
          typed: String((r && (r.content != null ? r.content : r.value)) || ''),
        }),
        fail: () => resolve({ ok: false, typed: '' }),
      });
    });
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

  /** 搜索用户：昵称模糊 + 用户ID精确，结果按 _id 去重合并（查询形状与 userManage 一致） */
  async searchUsers(kw) {
    const keyword = (kw || '').trim();
    if (!keyword) return;
    this.setData({ searching: true, results: [], searched: false });
    try {
      const re = guard.escapeRegExp(keyword);
      const [byId, byName] = await Promise.all([
        db.find('Feeder', { userId: keyword }, { limit: 5 }),
        // 昵称模糊匹配（防正则注入：escapeRegExp）
        db.find('Feeder', { nickName: { $regex: re, $options: 'i' } }, { limit: 20 }),
      ]);
      const map = {};
      (byId || []).concat(byName || []).forEach((u) => {
        if (u && u._id && !map[u._id]) map[u._id] = u;
      });
      const myId = db.state.userId || '';
      const results = Object.keys(map).map((k) => {
        const u = map[k];
        return {
          userId: u.userId || '',
          nickName: u.nickName || '',
          avatarUrl: u.avatarUrl || DEFAULT_AVATAR,
          isSelf: !!myId && u.userId === myId,
          isAdmin: this.isAdminId(u.userId),
        };
      });
      this.setData({ results: results, searched: true });
      if (!results.length) {
        wx.showToast({ title: '未找到该用户', icon: 'none' });
      }
    } catch (err) {
      console.error('[adminManage] 搜索失败', err);
      wx.showToast({ title: '搜索失败', icon: 'none' });
    }
    this.setData({ searching: false });
  },

  /** 某个 userId 是否已在当前管理员列表里 */
  isAdminId(userId) {
    const id = String(userId || '');
    if (!id) return false;
    return this.data.admins.some((a) => a && a.userId === id);
  },

  /** 用最新的管理员列表刷新搜索结果里的 isAdmin 标记 */
  markResultsAdmin() {
    const results = this.data.results || [];
    if (!results.length) return;
    results.forEach((r, i) => {
      const v = this.isAdminId(r.userId);
      if (r.isAdmin !== v) setField(this, 'results[' + i + '].isAdmin', v);
    });
  },

  /** 头像加载失败 → 回退微信默认头像（COS 头像可能失效/被删） */
  onAvatarError(e) {
    const idx = e.currentTarget.dataset.index;
    const list = e.currentTarget.dataset.list; // 'results' | 'admins'
    if (!list || idx === undefined) return;
    setField(this, list + '[' + idx + '].avatarUrl', DEFAULT_AVATAR);
  },

  /** 复制用户ID（统一走 utils/clipboard.js：成功/失败都有提示 + 隐私授权兜底） */
  copyId(e) {
    clipboard.copy(e.currentTarget.dataset.userid, '用户ID');
  },

  /** 设为管理员（弹窗里同时收「真实姓名」） */
  async grant(e) {
    const userId = e.currentTarget.dataset.userid;
    const pw = this.data.password || '';
    if (!pw) {
      wx.showToast({ title: '请先输入操作密码并解锁', icon: 'none' });
      return;
    }
    if (this.data.acting) return;

    const asked = await this.askAdminName();
    if (!asked.ok) return; // 取消：不做任何操作，也不消耗节流窗口

    const realName = asked.typed.trim();
    // 姓名必填：它就是管理员列表里显示的东西，留空会退化成昵称甚至「管理员」，
    // 而"这个人到底是谁"恰恰是这份名单唯一的用处。
    if (!realName) {
      wx.showToast({ title: '请填写真实姓名', icon: 'none' });
      return;
    }
    // 按码点数（与服务端 Array.from 的算法一致），否则 emoji 会被两边算出不同长度
    if (Array.from(realName).length > ADMIN_NAME_MAX) {
      wx.showToast({ title: '姓名最多 ' + ADMIN_NAME_MAX + ' 个字', icon: 'none' });
      return;
    }
    if (!guard.throttle('adminManage.grant', 2000)) return;

    this.setData({ acting: userId });
    try {
      // 姓名由管理员人工填写并传给服务端；服务端仍会再清洗一遍（去空白/控制字符、按码点截断），
      // 前端这道校验只是"提前告知"，不是权威。
      const res = await adminApi.grant(userId, realName, pw);
      adminApi.ensureOk(res);
      guard.resetThrottle('adminManage.grant');
      await this.refreshIdentity();
      await this.loadAdmins();
      // 提示放在列表刷新之后：关掉弹窗时下面的列表已经是新的，能立刻看到刚加的人。
      if (res.already) {
        wx.showToast({ title: '对方已是管理员', icon: 'success' });
      } else {
        // res.name 是服务端清洗后真正存进库的名字 —— 回显它而不是回显用户输入，
        // 这样万一超长被截断、或空白被去掉，一眼就能看出来。
        // 【弹窗文案里不要写 markdown】wx.showModal 不渲染 ** 之类，会原样显示出来。
        wx.showModal({
          title: '已添加',
          content: '「' + (res.name || realName) + '」已设为管理员。\n\n' + RESTART_HINT_ADD,
          showCancel: false,
          confirmText: '知道了',
        });
      }
    } catch (err) {
      this.handleError(err);
    }
    this.setData({ acting: '' });
  },

  /** 移除管理员 */
  async revoke(e) {
    const userId = e.currentTarget.dataset.userid;
    const name = e.currentTarget.dataset.name || '';
    const pw = this.data.password || '';
    if (!pw) {
      wx.showToast({ title: '请先输入操作密码并解锁', icon: 'none' });
      return;
    }
    if (this.data.acting) return;

    const confirmed = await confirmAction(
      '确认移除管理员',
      '移除「' + (name || userId) + '」的管理员身份？\n\n对方登录后将无法再进入管理页面，已发布的内容不受影响。',
      '确认移除',
      '#c0392b'
    );
    if (!confirmed) return; // 取消：不做任何操作，也不消耗节流窗口
    if (!guard.throttle('adminManage.revoke', 2000)) return;

    this.setData({ acting: userId });
    try {
      const res = await adminApi.revoke(userId, pw);
      adminApi.ensureOk(res);
      guard.resetThrottle('adminManage.revoke');
      await this.refreshIdentity();
      await this.loadAdmins();
      if (res.already) {
        wx.showToast({ title: '对方已不是管理员', icon: 'success' });
      } else {
        wx.showModal({
          title: '已移除',
          content: '「' + (name || userId) + '」已不再是管理员。\n\n' + RESTART_HINT_REMOVE,
          showCancel: false,
          confirmText: '知道了',
        });
      }
    } catch (err) {
      this.handleError(err);
    }
    this.setData({ acting: '' });
  },

  /**
   * 改完管理员名单必须刷新身份缓存。
   * 【为什么无条件做】utils/db.js 的 state.administratorChecked 把"我是不是管理员"缓存了
   *   整个 app 生命周期，不刷新的话：把自己移除之后，本人还能带着管理员权限逛完所有管理页。
   *   这里不去推理"这次改动是否涉及自己"—— 那种推理一旦漏了一种情况就是权限残留。
   * 【代价】resetUserState 会把 state.userId 一起清空，因此要多一次 getInfo() 往返，可接受。
   */
  async refreshIdentity() {
    try {
      db.resetUserState();
      await db.initUserState();
    } catch (err) {
      // 刷新失败不影响已经写库的结果；下次冷启动也会重新查
      console.error('[adminManage] 刷新身份缓存失败', err);
    }
  },

  /** 错误分流：按云函数返回的 code 决定弹窗还是 toast，并给出可操作的下一步 */
  handleError(err) {
    const code = (err && err.code) || '';
    const msg = (err && err.message) || '操作失败，请重试';
    console.warn('[adminManage] 操作失败', code, msg);

    if (code === 'NO_PASSWORD_CONFIG') {
      wx.showModal({
        title: '服务端没配密码',
        content: '云函数 adminManage 还没有配置 ADMIN_PASSWORD，在配置好之前所有操作都会被拒绝（这是刻意设计：忘配置应该让功能哑掉，而不是变成"空密码就能进"）。\n\n配置位置二选一：\n① 控制台的环境变量；\n② 同目录下的 config.js（你的控制台没有环境变量入口时用这个，改完要连同它一起重新上传函数）。\n\n详见 README 第七节。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    if (code === 'LOCKED') {
      wx.showModal({ title: '已暂时锁定', content: msg, showCancel: false, confirmText: '知道了' });
      return;
    }
    if (code === 'NOT_ADMIN' || code === 'NO_IDENTITY') {
      wx.showModal({
        title: '无权操作',
        content: msg,
        showCancel: false,
        confirmText: '返回',
        success: () => wx.navigateBack(),
      });
      return;
    }
    if (MODAL_CODES.indexOf(code) >= 0) {
      wx.showModal({ title: '无法完成', content: msg, showCancel: false, confirmText: '知道了' });
      return;
    }
    // BAD_PASSWORD 及各种未预料到的失败：短提示即可
    wx.showToast({ title: msg, icon: 'none', duration: 2500 });
  },
});
