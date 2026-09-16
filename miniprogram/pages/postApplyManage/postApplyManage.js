// ============================================================
// pages/postApplyManage/postApplyManage.js —— 发布申请：待办队列 + 最近处理历史（仅管理员）
// 【为什么单独一页】原先这两块挤在「管理员管理」页的最下面，和"加/删管理员"混在一起，
//   一屏里既要看名单又要审申请，页面太长（用户原话："显示内容太多，超载了"）。
//   发布审批是**日常最高频**的管理动作，值得有自己的入口。
//
// 【本页只做界面，不做安全判断】同 adminManage：是不是管理员、密码对不对都在云函数里判。
//   客户端的 guard.requireAdmin() 只是为了"提前把页面关掉"，挡不住真想进来的人。
//
// 【密码从哪来】优先用 utils/adminManage.js 的会话缓存（在「管理员」页或本页填过一次就有）。
//   缓存里没有时，本页也允许现场输一次 —— 输入后先 authCheck 验证通过再存，不盲存。
//   缓存是**内存**级的：小程序被完全杀掉重进就要重填（刻意如此，明文密码不落设备）。
// ============================================================
const db = require('../../utils/db.js'); // 公共数据库方法（这里只用它的身份缓存）
const guard = require('../../utils/guard.js'); // 前端保险工具
const adminApi = require('../../utils/adminManage.js'); // 管理员接口（走云函数）
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）
const clipboard = require('../../utils/clipboard.js'); // 复制到剪贴板（统一反馈 + 隐私授权兜底）

// 微信默认头像（用户从未上传头像时的占位，与 userManage 页一致）
const DEFAULT_AVATAR = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0';

// 出错时用弹窗（而不是一闪而过的 toast）展示的错误码：提示都比较长，toast 装不下会被截断
// BLACKLISTED：审批时被黑名单一票否决 —— 必须让人看清，否则管理员会反复点「通过」不知道为什么没反应
const MODAL_CODES = ['TOO_MANY', 'BLACKLISTED', 'NOT_FEEDER', 'BAD_USER_ID', 'LOOKUP_FAILED'];

// 最近处理历史一次取多少条。服务端默认 20、封顶 50（见 adminManage/index.js 的 clampHistoryLimit）。
// 这里显式传，避免"默认值哪天被改小了，线上历史突然变短"这种无声的变化。
const HISTORY_LIMIT = 20;

// 通过发布申请后要说的话。canPost 缓存在对方**本次运行**里，只有冷启动才会读到新值 ——
// 我们这边做不到，只能把话说明白（与 adminManage 页同一段文案，改动要同步两处）。
const RESTART_HINT_POST = '对方需要完全退出小程序再重新进入（从"最近使用"里划掉，或右上角关闭），加号和评论框才会出现。\n\n只是返回上一页、或切到后台再回来，都不算重新进入。';

/**
 * 确认弹窗（Promise 版）。写法抄自 pages/reviewCenter/reviewCenter.js：
 * **先弹窗、再限频**，取消弹窗不消耗节流窗口 —— 用户点了「取消」等于什么都没做，不该被限频。
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
    // needsPassword=true 表示"要显示密码输入框"。缓存里有密码时它是 false，
    // 页面直接静默加载，用户感觉不到"密码"这回事。
    needsPassword: false,
    password: '',        // 现场输入、尚未验证的密码（只在内存里）
    unlocked: false,     // 是否已成功拉取过一次数据
    loading: false,

    // ---- 身份模式（如实展示：可信=两道锁，不可信=只有密码一道锁）----
    identityMode: '',
    trusted: false,

    // ---- 待审批队列（status='pending'）----
    applies: [],         // [{applyId, userId, nickName, avatarUrl, appliedAtText}]
    actingApply: '',     // 正在审批的 applyId（两个按钮都显示"提交中…"并置灰）

    // ---- 最近处理（status='approved'|'rejected'）----
    history: [],         // [{applyId, userId, nickName, avatarUrl, approved, handledAtText, handledByName, ...}]
    // 取回的条数上限（展示用：列表正好取满时说明"更早的没显示"）。
    // ⚠️ 服务端返回的 historyTotal 是**本页取回的条数**，不是全库总数 —— 别拿它当"共处理过 N 条"。
    historyLimit: HISTORY_LIMIT,
  },

  /**
   * 页面加载：黑名单拦截 → 载入身份缓存 → 非管理员直接挡回。
   * 【不在 onLoad 里直接拉数据】放 onShow —— 免得"从别处返回本页"时列表还是旧的。
   */
  async onLoad() {
    guard.ensureNotBanned();
    await db.initUserState();
    // requireAdmin 只读客户端的缓存判断，作用是"提前关页面"，不是安全边界（见文件头）
    if (!guard.requireAdmin()) return;
    this.setData({ ready: true });
  },

  /**
   * 每次显示都重新拉一遍：从（比如）用户管理页处理完一个人返回本页时，队列应该已经变了。
   * 【有缓存密码就静默加载】这是"输一次、处处复用"的兑现点 —— 用户不会再被问第二次。
   */
  async onShow() {
    if (!this.data.ready) return;
    const cached = adminApi.getSessionPassword();
    if (!cached) {
      // 没缓存过：显示密码输入框，等用户填（填完由 onUnlockTap 验证）
      this.setData({ needsPassword: true });
      return;
    }
    this.setData({ needsPassword: false, password: '' });
    await this.load();
  },

  /** 密码输入（现场输入，尚未验证） */
  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  /**
   * 点「确定 / 刷新」。
   * 【只有现场输入的密码才需要 authCheck】缓存里的密码是**验证通过之后**才存进去的
   *   （verifyAndCache 保证），再验一次纯属浪费一次"失败计数"额度。
   *   反过来说：缓存密码失效（比如管理员在别处改过密码）时，load() 会拿到 BAD_PASSWORD，
   *   那时把它清掉、重新要求输入 —— 见 handleError。
   */
  async onUnlockTap() {
    const typed = (this.data.password || '').trim();
    if (typed) {
      this.setData({ loading: true });
      const r = await adminApi.verifyAndCache(typed);
      this.setData({ loading: false });
      if (!r.ok) {
        this.handleError(r.err);
        return;
      }
      this.setData({ needsPassword: false, password: '' });
    } else if (this.data.needsPassword) {
      // 输入框显示着但没填：别静默什么都不做
      wx.showToast({ title: '请输入操作密码', icon: 'none' });
      return;
    }
    await this.load();
  },

  /**
   * 拉取待办队列 + 最近处理历史（一次请求取回，服务端在同一个调用里查两张结果）。
   * 【为什么合并成一次】页面上下两块永远要同时刷新（刚处理完一条，它就该从上面消失、从下面出现），
   *   发两个请求只会让两块数据在时间上错开一瞬，看起来像"点了没反应"。
   */
  async load() {
    if (this.data.loading) return false;
    this.setData({ loading: true });
    try {
      const res = await adminApi.listApplies(adminApi.getSessionPassword(), HISTORY_LIMIT);
      adminApi.ensureOk(res);
      const applies = (res.applies || []).map((a) => Object.assign({}, a, {
        avatarUrl: a.avatarUrl || DEFAULT_AVATAR,
      }));
      const history = (res.history || []).map((h) => Object.assign({}, h, {
        avatarUrl: h.avatarUrl || DEFAULT_AVATAR,
      }));
      this.setData({
        applies: applies,
        history: history,
        unlocked: true,
        identityMode: res.identityMode || 'untrusted',
        trusted: res.identityMode === 'trusted',
        loading: false,
      });
      return true;
    } catch (err) {
      this.setData({ loading: false });
      this.handleError(err);
      return false;
    }
  },

  /** 通过发布申请 → 该用户永久获得发布权（写入在云函数，这里只发起） */
  async approvePost(e) {
    const d = e.currentTarget.dataset;
    const userId = d.userid;
    const applyId = d.applyid;
    const name = d.name || userId;
    if (this.data.actingApply) return;

    const confirmed = await confirmAction(
      '通过发布申请',
      '通过「' + name + '」的发布申请？\n\n通过后对方永久获得发布帖子和评论的权限。',
      '确认通过'
    );
    if (!confirmed) return; // 取消：不做任何操作，也不消耗节流窗口
    if (!guard.throttle('postApplyManage.approvePost', 2000)) return;

    this.setData({ actingApply: applyId });
    try {
      const res = await adminApi.approvePost(userId, applyId);
      adminApi.ensureOk(res);
      guard.resetThrottle('postApplyManage.approvePost');
      await this.load();
      // 提示放在列表刷新之后：关掉弹窗时这条申请已经挪到下面的"最近处理"里了，能立刻看到效果。
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
    if (this.data.actingApply) return;

    const confirmed = await confirmAction(
      '拒绝发布申请',
      '拒绝「' + name + '」的发布申请？\n\n只会把这条申请标为已拒绝，不会收回对方已有的任何权限。对方今天不能再申请，明天起可以重新申请。',
      '确认拒绝',
      '#c0392b'
    );
    if (!confirmed) return; // 取消：不做任何操作，也不消耗节流窗口
    if (!guard.throttle('postApplyManage.rejectPost', 2000)) return;

    this.setData({ actingApply: applyId });
    try {
      const res = await adminApi.rejectPost(userId, applyId);
      adminApi.ensureOk(res);
      guard.resetThrottle('postApplyManage.rejectPost');
      await this.load();
      // 拒绝是非破坏性操作（没动对方任何已有权限），一句 toast 就够，不用弹窗打断
      wx.showToast({ title: '已拒绝', icon: 'success' });
    } catch (err) {
      this.handleError(err);
    }
    this.setData({ actingApply: '' });
  },

  /** 查看某条历史申请的用户ID（长按复制用；列表里已经显示，这里只负责复制） */
  copyId(e) {
    clipboard.copy(e.currentTarget.dataset.userid, '用户ID');
  },

  /** 头像加载失败 → 回退微信默认头像（COS 头像可能失效/被删） */
  onAvatarError(e) {
    const idx = e.currentTarget.dataset.index;
    const list = e.currentTarget.dataset.list; // 'applies' | 'history'
    if (!list || idx === undefined) return;
    setField(this, list + '[' + idx + '].avatarUrl', DEFAULT_AVATAR);
  },

  /**
   * 错误分流：按云函数返回的 code 决定弹窗还是 toast，并给出可操作的下一步。
   * 【与 adminManage 页的差异就一处】这里要处理 NEED_PASSWORD / BAD_PASSWORD：
   *   本页可能在"缓存密码已失效"的情况下被打开（管理员改过密码、或服务端密码换了），
   *   此时必须把缓存清掉并把输入框重新显示出来，否则用户会卡在一个只报错、没有输入框的页面上。
   */
  handleError(err) {
    const code = (err && err.code) || '';
    const msg = (err && err.message) || '操作失败，请重试';
    console.warn('[postApplyManage] 操作失败', code, msg);

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
    if (code === 'NEED_PASSWORD' || code === 'BAD_PASSWORD') {
      // 缓存的那份不作数了 → 清掉并要求重新输入（不只改界面状态，缓存也要真清）
      adminApi.clearSessionPassword();
      this.setData({ needsPassword: true, unlocked: false, applies: [], history: [] });
      if (code === 'BAD_PASSWORD') {
        wx.showToast({ title: '密码已失效，请重新输入', icon: 'none', duration: 2500 });
      } else {
        wx.showToast({ title: '请先输入操作密码', icon: 'none' });
      }
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
    wx.showToast({ title: msg, icon: 'none', duration: 2500 });
  },
});
