// ============================================================
// pages/Administrator/Administrator.js —— 管理员后台
// 【作用】管理员可在此：
//        1. 填一次「操作密码」（本次使用期间通用，后面所有管理操作都不再问）
//        2. 进用户管理 / 管理员管理 / 发布申请审批
//        3. 复核中心 + 维护敏感词库（动态那部分，加完立刻生效）
//        4. 内容管理（公告 / 官方推文 / 回收站）
//        5. 基础设置（审核开关 + 联系方式）
//        页面仅管理员可用，其他人直接打开会被拦下。
// 【版块顺序按"多久用一次"排，不按"当初怎么加的"排】：基础设置沉到最下面。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const config = require('../../config.js'); // 全局配置
const guard = require('../../utils/guard.js'); // 前端保险工具（限频）
const adminApi = require('../../utils/adminManage.js'); // 操作密码 + 敏感词库（走云函数）

// 词库只提示用，长度上限以服务端为准（adminManage/index.js 的 WORD_MIN_LEN / WORD_MAX_LEN）。
// 前端先拦一道是为了不让用户填完 30 个字、提交后被服务端**静默截断**。
const WORD_MIN_LEN = 2;
const WORD_MAX_LEN = 20;

Page({
  data: {
    audit: false, // 当前是否开放注册/发布
    phone: '', // 联系方式（手机号），从 Administrator 集合读取
    email: '', // 联系方式（邮箱），从 Administrator 集合读取
    contactOpen: false, // 联系方式填写区是否展开（默认收起）

    // ---- 操作密码（顶部，可选填）----
    pwOpen: false,      // 密码填写区是否展开
    pwInput: '',        // 正在输入的密码（**未验证**，不进缓存）
    pwReady: false,     // 缓存里是否已经有一份**验证通过**的密码
    pwChecking: false,  // 正在 authCheck

    // ---- 敏感词库（动态那部分）----
    wordsOpen: false,   // 词库区是否展开（默认收起：它是一个"需要时才用"的工具）
    words: [],          // [{word, tier, ...}]
    newWord: '',        // 正在输入的新词
    newTier: 'block',   // 'block' = 拦下（默认，因为禁言时收集的多是硬拦词）| 'review' = 只标记
    wordActing: false,
    wordHint: '',       // 词库区的一行提示（成功/失败的原因，就地显示比弹窗轻）
  },

  /** 展开/收起联系方式填写区（输入值保留在 data，不会丢） */
  toggleContact() {
    this.setData({ contactOpen: !this.data.contactOpen });
  },

  /**
   * 页面加载：校验管理员身份并读取当前审核开关、联系方式。
   * 【密码区与词库区放在 onShow】它们要反映"现在缓存里有没有密码"，
   *   而用户可能刚从别的页面回来（那边可能填过、也可能把密码清掉了）。
   */
  async onLoad() {
    guard.ensureNotBanned();
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    this.setData({ audit: await db.getAudit() });
    this.loadContact();
  },

  onShow() {
    this.syncPasswordState();
    // 密码就绪时顺手把词库拉出来 —— 管理员打开这个折叠区时不该再等一次网络
    if (adminApi.getSessionPassword()) this.loadWords();
  },

  /** 同步"密码有没有就绪"到界面。**只读缓存，不发请求** */
  syncPasswordState() {
    const ready = !!adminApi.getSessionPassword();
    this.setData({ pwReady: ready, pwOpen: false, pwInput: '' });
  },

  // ============ 操作密码 ============

  /** 展开密码填写区（展开时清空上次的输入，免得把旧密码不小心提交上去） */
  togglePw() {
    this.setData({ pwOpen: !this.data.pwOpen, pwInput: '' });
  },

  onPwInput(e) {
    this.setData({ pwInput: e.detail.value });
  },

  /**
   * 「验证并保存」。
   * 【必须真验证，不能盲存】这里有个坑：门禁规则是"身份可信时免密"，而实测本机 trusted=true，
   *   所以 list / listApplies 这类**免密动作拿它验密码会永远通过** —— 于是错密码被存进缓存，
   *   直到某次真正需要密码的写操作才炸，而那时用户完全不知道错在哪。
   *   authCheck 是专门为此加的：它永远要密码、且不返回任何业务数据。
   * 【失败会消耗失败计数】与所有密码校验共用一套计数（连续错会 LOCKED），提示里要说明。
   */
  async savePassword() {
    const pw = (this.data.pwInput || '').trim();
    if (!pw) {
      wx.showToast({ title: '请输入操作密码', icon: 'none' });
      return;
    }
    if (this.data.pwChecking) return;
    this.setData({ pwChecking: true });
    const r = await adminApi.verifyAndCache(pw);
    this.setData({ pwChecking: false });
    if (!r.ok) {
      const code = (r.err && r.err.code) || '';
      const msg = (r.err && r.err.message) || '验证失败';
      if (code === 'LOCKED') {
        wx.showModal({ title: '已暂时锁定', content: msg, showCancel: false, confirmText: '知道了' });
      } else if (code === 'NO_PASSWORD_CONFIG') {
        wx.showModal({
          title: '服务端没配密码',
          content: '云函数 adminManage 还没有配置 ADMIN_PASSWORD，在配置好之前所有管理操作都会被拒绝。\n\n配置位置二选一：\n① 控制台的环境变量；\n② 同目录下的 config.js（你的控制台没有环境变量入口时用这个，改完要连同它一起重新上传函数）。\n\n详见 README 第七节。',
          showCancel: false,
          confirmText: '知道了',
        });
      } else {
        // 说清"会消耗失败次数"这件事，否则用户会以为可以无限试
        wx.showToast({ title: '密码不对（多次错误会被暂时锁定）', icon: 'none', duration: 2500 });
      }
      return;
    }
    this.syncPasswordState();
    wx.showToast({ title: '已保存，本次不再重复输入', icon: 'none', duration: 2000 });
    this.loadWords();
  },

  // ============ 敏感词库（动态部分）============

  toggleWords() {
    const open = !this.data.wordsOpen;
    this.setData({ wordsOpen: open, wordHint: '' });
    if (open) this.loadWords();
  },

  /** 拉词库。服务端能独立确认身份时免密；否则用缓存里的密码 */
  async loadWords() {
    try {
      const res = await adminApi.listWords();
      adminApi.ensureOk(res);
      this.setData({ words: res.words || [] });
    } catch (err) {
      // 读不到不弹窗：词库是个工具区，报错弹窗会把主流程的反馈冲掉。就地写一行提示。
      console.warn('[Administrator] 读词库失败', (err && err.code) || '', (err && err.message) || err);
      const code = (err && err.code) || '';
      this.setData({
        wordHint: (code === 'NEED_PASSWORD' || code === 'BAD_PASSWORD')
          ? '需要操作密码：请在上方「操作密码」里填写后再试'
          : '词库读取失败，请稍后重试',
      });
    }
  },

  onWordInput(e) {
    this.setData({ newWord: e.detail.value, wordHint: '' });
  },

  onTierTap(e) {
    this.setData({ newTier: e.currentTarget.dataset.tier === 'review' ? 'review' : 'block' });
  },

  /**
   * 加入词库。**先弹确认**：这是全局生效的改动（会影响所有人的发布），值得一次确认。
   * 档位的差别也再说一遍 —— 它是唯一能让人"选错了才发现"的地方。
   */
  async addWord() {
    const word = (this.data.newWord || '').trim();
    if (word.length < WORD_MIN_LEN) {
      wx.showToast({ title: '至少 ' + WORD_MIN_LEN + ' 个字', icon: 'none' });
      return;
    }
    if (Array.from(word).length > WORD_MAX_LEN) {
      wx.showToast({ title: '最多 ' + WORD_MAX_LEN + ' 个字', icon: 'none' });
      return;
    }
    if (this.data.wordActing) return;

    const isBlock = this.data.newTier !== 'review';
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '加入敏感词库',
        // 【文案里不要写 markdown】wx.showModal 不渲染 ** 之类，会原样显示出来
        content: '把「' + word + '」加入词库？\n\n' + (isBlock
          ? '档位：拦下 —— 含这个词的内容会被直接拒绝发布，对所有人生效。'
          : '档位：只标记 —— 含这个词的内容照常发布，但会推给管理员复核。'),
        confirmText: '确认加入',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    if (!guard.throttle('Administrator.addWord', 2000)) return;

    this.setData({ wordActing: true, wordHint: '' });
    try {
      const res = await adminApi.addWord(word, this.data.newTier);
      adminApi.ensureOk(res);
      guard.resetThrottle('Administrator.addWord');
      this.setData({ newWord: '' });
      await this.loadWords();
      // res.added=false 表示这个词本来就在（服务端幂等），此时还要再分两种：
      //   res.updated=true  → 真的改了档位
      //   res.updated 缺失  → 档位和原来一样，**什么都没动**
      // 【为什么必须区分】原来不分，两种情况都提示"已把档位改为…"。同一个人加两次同一个词
      //   就会看到"已把档位改为拦下"——而它本来就是拦下，用户会以为哪里出了问题。
      const tierText = res.tier === 'review' ? '只标记' : '拦下';
      this.setData({
        wordHint: res.added
          ? '已加入「' + res.word + '」（' + tierText + '）。已生效，无需重新发布版本。'
          : (res.updated
            ? '「' + res.word + '」本来就在词库里，已把档位改为「' + tierText + '」。'
            : '「' + res.word + '」本来就在词库里，档位就是「' + tierText + '」，没有改动。'),
      });
    } catch (err) {
      const code = (err && err.code) || '';
      const msg = (err && err.message) || '加入失败，请重试';
      const hint = (code === 'NEED_PASSWORD' || code === 'BAD_PASSWORD')
        ? '需要操作密码：请在上方「操作密码」里填写'
        : msg;
      this.setData({ wordHint: hint });
      wx.showToast({ title: hint, icon: 'none', duration: 2500 });
    }
    this.setData({ wordActing: false });
  },

  /**
   * 一键导入内置推荐词表（词表在**服务端**，这里只发一个空请求）。
   * 【为什么值得一个按钮】手动一条条加四十几条太慢，且输错一个字就不生效（子串匹配下
   *   错一个字等于没加）。幂等，所以重复点只补缺的那些，中途失败再点一次就行。
   */
  async seedWords() {
    if (this.data.wordActing) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '导入推荐词表',
        content: '导入内置的推荐词表？\n\n内容是虐猫圈的黑话与手段词（拦下档），以及若干条"有正当用法、只标记"的词（复核档）。\n\n已有的词不会重复添加，导入后可以逐条删除或改档。',
        confirmText: '导入',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    if (!guard.throttle('Administrator.seedWords', 3000)) return;

    this.setData({ wordActing: true, wordHint: '导入中，请稍候…' });
    try {
      const res = await adminApi.seedWords();
      adminApi.ensureOk(res);
      guard.resetThrottle('Administrator.seedWords');
      await this.loadWords();
      const failN = (res.failed || []).length;
      this.setData({
        wordHint: '已导入 ' + res.listTotal + ' 条：新增 ' + res.added + '、改档 ' + res.updated
          + '、本来就有 ' + res.kept
          + (failN ? '、失败 ' + failN + ' 条（' + res.failed[0].code + '）' : ''),
      });
      wx.showToast({ title: failN ? '部分导入成功' : '已导入推荐词表', icon: 'none', duration: 2000 });
    } catch (err) {
      const code = (err && err.code) || '';
      const msg = (err && err.message) || '导入失败，请重试';
      const hint = (code === 'NEED_PASSWORD' || code === 'BAD_PASSWORD')
        ? '需要操作密码：请在上方「操作密码」里填写'
        : msg;
      this.setData({ wordHint: hint });
      wx.showToast({ title: hint, icon: 'none', duration: 2500 });
    }
    this.setData({ wordActing: false });
  },

  /** 从词库删掉一个词（手滑加错时的补救入口；没有它就只能去控制台改库） */
  async delWord(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '移出词库',
        content: '把「' + word + '」移出词库？\n\n移出后含这个词的内容不再被拦（或不再被标记）。',
        confirmText: '确认移出',
        confirmColor: '#c0392b',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    if (!guard.throttle('Administrator.delWord', 2000)) return;
    try {
      const res = await adminApi.delWord(word);
      adminApi.ensureOk(res);
      guard.resetThrottle('Administrator.delWord');
      await this.loadWords();
      wx.showToast({ title: '已移出', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '移出失败，请重试', icon: 'none', duration: 2500 });
    }
  },

  /** 读取联系方式并回填输入框（from Administrator 集合） */
  loadContact() {
    const self = this;
    db.getContact().then(function (c) {
      self.setData({ phone: c.phone || '', email: c.email || '' });
    }).catch(function (e) {
      console.error('读取联系方式失败', e);
    });
  },

  /** 手机号输入框 */
  onPhoneInput(e) {
    this.setData({ phone: e.detail.value });
  },

  /** 邮箱输入框 */
  onEmailInput(e) {
    this.setData({ email: e.detail.value });
  },

  /** 保存联系方式到数据库（about 页展示即生效，无需重新发布版本；写联系方式记录，非审核开关记录） */
  saveContact() {
    if (!guard.throttle('saveContact', 3000)) return;
    const phone = (this.data.phone || '').trim();
    const email = (this.data.email || '').trim();
    const self = this;
    db.updateOne('Administrator', { _id: config.contactRecordId }, { $set: { phone: phone, email: email } })
      .then(function () {
        self.setData({ phone: phone, email: email });
        wx.showToast({ icon: 'success', title: '保存成功' });
      }).catch(err => { console.error(err); wx.showToast({ icon: 'error', title: '保存失败，请重试' }); });
  },

  /** 一键开关审核（带确认弹窗，防止误操作） */
  manage() {
    // 前端限频（保险）：3 秒内只能切换一次
    if (!guard.throttle('manageAudit', 3000)) return;
    var newVal = !this.data.audit;
    var label = newVal ? '开启' : '关闭';
    var self = this;
    wx.showModal({
      title: '确认操作',
      content: '确定' + label + '注册/发布审核吗？',
      confirmText: label,
      success: function (res) {
        if (!res.confirm) return;
        db.updateOne('Administrator', { _id: config.administratorRecordId }, { $set: { audit: newVal } })
          .then(function () {
            self.setData({ audit: newVal });
            db.resetAuditCache(); // 清掉审核缓存，让其他页面拿到最新值
            wx.showToast({ icon: 'success', title: '操作成功' });
          }).catch(err => { console.error(err); wx.showToast({ icon: 'error', title: '操作失败，请重试' }); });
      },
    });
  },

  /** 管理公告板 */
  manageNotice() {
    wx.navigateTo({ url: '/pages/editAnnouncement/editAnnouncement' });
  },

  /** 回收站（合并入口）：先弹选择，再去猫回收站或帖子回收站 */
  manageTrashMenu() {
    wx.showActionSheet({
      itemList: ['被删除的猫（可恢复）', '被删除的帖子（可恢复）'],
      success: (res) => {
        const url = res.tapIndex === 0 ? '/pages/catTrash/catTrash'
          : (res.tapIndex === 1 ? '/pages/pageTrash/pageTrash' : '');
        if (!url) return;
        // 等 actionSheet 收起动画结束再跳转，避免原生面板与路由交叠触发
        // "routeDone with a webviewId XX is not found"（框架层路由噪音，通常无害）
        setTimeout(() => wx.navigateTo({ url: url }), 300);
      },
      fail: () => {}, // 用户取消选择，不处理
    });
  },

  /** 回收站（被删除的猫，可看照片并恢复） */
  manageTrash() {
    wx.navigateTo({ url: '/pages/catTrash/catTrash' });
  },

  /** 帖子回收站（被删除的推文，可看照片并恢复） */
  managePageTrash() {
    wx.navigateTo({ url: '/pages/pageTrash/pageTrash' });
  },

  /** 内容安全复核中心（举报 / 申诉 / 待复核内容，含下架、封禁、解封） */
  manageReview() {
    wx.navigateTo({ url: '/pages/reviewCenter/reviewCenter' });
  },

  /** 用户管理 / 黑名单（搜索用户 / 封禁解封 / 查看黑名单） */
  manageUsers() {
    wx.navigateTo({ url: '/pages/userManage/userManage' });
  },

  /** 管理员管理（在线添加 / 移除管理员；密码在本页填过就不用再输） */
  manageAdmins() {
    wx.navigateTo({ url: '/pages/adminManage/adminManage' });
  },

  /** 发布申请（审批待办 + 最近处理记录；密码同上，能复用就复用） */
  manageApplies() {
    wx.navigateTo({ url: '/pages/postApplyManage/postApplyManage' });
  },

  /** 官方推文管理列表（含"发布新推文"入口） */
  manageOfficial() {
    wx.navigateTo({ url: '/pages/manageOfficial/manageOfficial' });
  },
});
