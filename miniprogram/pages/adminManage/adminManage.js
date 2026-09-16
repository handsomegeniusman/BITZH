// ============================================================
// pages/adminManage/adminManage.js —— 在线添加 / 移除管理员（仅管理员）
// 【作用】不打开控制台就能增删管理员：
//   1. 操作密码 → 拉取当前管理员列表（密码错了会按 IP 锁定，见云函数）
//   2. 搜索用户（昵称模糊 / 用户ID精确）→ 一键设为管理员
//   3. 列表内移除管理员（服务端拒绝移除自己、拒绝移除最后一位）
//   4. **只留一张「发布申请」入口卡**（显示待审批条数）—— 申请列表本身搬到了独立页面
//      pages/postApplyManage，因为两块内容挤在一页里"显示内容太多，超载了"（用户原话）。
//
// 【本页只做界面，不做安全判断】"是不是管理员"由云函数独立判定，"密码对不对"也在云函数里比。
//   客户端读 db.state.isAdministrator 只是为了**提前把页面关掉**（少一次白跑的调用），
//   它挡不住真想进来的人：miniprogram/config.js 的 clientSecret 随包发出，反编译即可绕过本页
//   直接写 BITZHAdministrator。真正的收口是云函数 + 集合权限规则（见 README 第六.5 节）。
//
// 【密码的存活范围：改了，见 utils/adminManage.js 文件头】
//   旧约定是"只在页面 data 里存活，离开本页即失效"。现在改为**内存里的会话缓存**：
//   在「管理员」页或「发布申请」页填一次并验证通过后，本次使用期间不再重复追问。
//   ⚠️ 两条硬约束没变：**只存内存**（绝不 wx.setStorage / globalData），
//      且**不主动清**（不清是设计，管理员明确要求"输一次共享"）。
//   代价：小程序被完全杀掉重进要重填一次，这是刻意接受的。
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
// 【发布申请相关的文案已随审批功能一起搬到 pages/postApplyManage】

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
    // needsPassword=true 表示"要显示密码输入框"。会话缓存里已经有密码时它是 false，
    // 页面直接静默加载 —— 用户感觉不到"密码"这回事（这是本次改动的主要收益）。
    needsPassword: false,
    password: '',        // 现场输入、尚未验证的密码（只在内存里，见文件头说明）
    unlocked: false,     // 是否已成功拉取过一次列表
    adminsLoading: false,

    // ---- 身份模式（如实展示：可信=两道锁，不可信=只有密码一道锁）----
    identityMode: '',    // 'trusted' | 'untrusted' | ''（未取到）
    trusted: false,      // identityMode === 'trusted'

    // ---- 管理员列表 ----
    admins: [],          // [{userId, name, nickName, avatarUrl, isSelf, grantedTimeText, displayName}]

    // ---- 发布申请入口卡 ----
    // 本页只显示**条数**，列表与审批都在 pages/postApplyManage。
    // null = 还没取到（可能是没密码、也可能是查挂了），界面上显示"—"而不是 0 ——
    // 显示 0 会让人以为"真的没有待办"，而实际只是没查到。
    applyCount: null,
    applyCountLoading: false,

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

  /**
   * 每次显示都刷新一遍。
   * 【有缓存密码就静默加载】这是"输一次、处处复用"的兑现点 —— 从「发布申请」页返回时，
   *   列表和待审批条数都该是最新的，而用户不该再被问一次密码。
   */
  async onShow() {
    if (!this.data.ready) return;
    if (!adminApi.getSessionPassword()) {
      // 没缓存过：显示密码输入框，等用户填（填完由 onUnlockTap 验证）
      this.setData({ needsPassword: true });
      return;
    }
    this.setData({ needsPassword: false, password: '' });
    const ok = await this.loadAdmins();
    if (ok) await this.loadApplyCount();
  },

  /** 密码输入（现场输入，尚未验证） */
  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  /**
   * 点「确定 / 刷新」。
   * 【只有现场输入的密码才需要 authCheck】缓存里的密码是**验证通过之后**才存进去的
   *   （adminApi.verifyAndCache 保证），再验一次只会白耗一次"失败计数"额度。
   * 【为什么不用 list 来验密码】list 是**免密动作**：服务端能独立确认身份时它根本不校验密码，
   *   拿它验等于永远通过 —— 错密码会被存下来，直到某次审批才炸。所以必须走 authCheck。
   */
  async onUnlockTap() {
    const typed = (this.data.password || '').trim();
    if (typed) {
      this.setData({ adminsLoading: true });
      const r = await adminApi.verifyAndCache(typed);
      this.setData({ adminsLoading: false });
      if (!r.ok) {
        this.handleError(r.err);
        return;
      }
      this.setData({ needsPassword: false, password: '' });
    } else if (this.data.needsPassword) {
      wx.showToast({ title: '请先输入操作密码', icon: 'none' });
      return;
    }
    // 串行：列表先成，再取条数。密码不对时两个请求会双双失败、
    // 弹出两个内容一样的弹窗（第二个盖掉第一个，看起来像卡住了）。
    const ok = await this.loadAdmins();
    if (!ok) return; // 失败原因 loadAdmins 已经弹过了
    await this.loadApplyCount();
  },

  /** 拉取管理员列表 */
  async loadAdmins() {
    if (this.data.adminsLoading) return false;
    this.setData({ adminsLoading: true });
    try {
      const res = await adminApi.list();
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

  // ============ 发布申请入口卡 ============

  /**
   * 只取待审批**条数**（列表和审批都在 pages/postApplyManage）。
   * 【为什么复用 listApplies 而不是新加一个 action】它返回的 total 就是 pending 的条数，
   *   传 historyLimit=1 让"最近处理"那半只取 1 条 —— 代价是查库时多带了一个 limit:1，
   *   换来的是不必为一个数字新增一个云函数动作（也就没有新的鉴权面要维护）。
   * 【失败不打扰用户】这里只是个数字，查不到就让它显示"—" ——
   *   为它弹一个错误弹窗会把「解锁」这个主流程的反馈冲掉，得不偿失。
   */
  async loadApplyCount() {
    if (this.data.applyCountLoading) return;
    this.setData({ applyCountLoading: true });
    try {
      const res = await adminApi.listApplies(undefined, 1);
      adminApi.ensureOk(res);
      this.setData({ applyCount: (res.applies || []).length });
    } catch (err) {
      console.warn('[adminManage] 取待审批条数失败（不影响本页其它功能）', (err && err.code) || '', (err && err.message) || err);
      this.setData({ applyCount: null });
    }
    this.setData({ applyCountLoading: false });
  },

  /** 进「发布申请」页。密码已经在会话缓存里，那边不会再问一次 */
  goApplies() {
    wx.navigateTo({
      url: '/pages/postApplyManage/postApplyManage',
      fail: (e) => {
        console.error('[adminManage] 跳转发布申请页失败', e);
        wx.showToast({ title: '页面跳转失败', icon: 'none' });
      },
    });
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
    if (!adminApi.getSessionPassword()) {
      wx.showToast({ title: '请先输入操作密码', icon: 'none' });
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
      // 密码不传：utils/adminManage.js 的 invoke() 会自动挂上会话缓存里的那份。
      const res = await adminApi.grant(userId, realName);
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
    if (!adminApi.getSessionPassword()) {
      wx.showToast({ title: '请先输入操作密码', icon: 'none' });
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
      const res = await adminApi.revoke(userId);
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
    if (code === 'NEED_PASSWORD' || code === 'BAD_PASSWORD') {
      // 缓存失效（服务端密码被改过）→ 清掉缓存并把输入框显示出来。
      // 只改界面状态而**不真清缓存**是不行的：下次进页面时 onShow 会看到缓存还有值、
      // 又静默地去加载、又失败，用户会卡在一个只报错、没有输入框的页面上。
      adminApi.clearSessionPassword();
      this.setData({ needsPassword: true, unlocked: false, admins: [], applyCount: null });
      wx.showToast({
        title: code === 'BAD_PASSWORD' ? '密码已失效，请重新输入' : '请先输入操作密码',
        icon: 'none',
        duration: 2500,
      });
      return;
    }
    if (MODAL_CODES.indexOf(code) >= 0) {
      wx.showModal({ title: '无法完成', content: msg, showCancel: false, confirmText: '知道了' });
      return;
    }
    // 各种未预料到的失败：短提示即可
    wx.showToast({ title: msg, icon: 'none', duration: 2500 });
  },
});
