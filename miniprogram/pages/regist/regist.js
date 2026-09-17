// ============================================================
// pages/regist/regist.js —— 注册 / 修改用户资料
// 【作用】新用户填写昵称、头像（可填手机号）后注册；
//        已注册用户在此修改自己的昵称、头像。头像会上传到 COS。
//        数据库增删改查与头像路径统一走公共模块。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const cos = require('../../utils/cos.js'); // COS 图片上传/删除/路径公共方法
const guard = require('../../utils/guard.js'); // 前端保险工具（文件名清洗/限频/限长）
const secCheck = require('../../utils/secCheck.js'); // 内容安全审核（昵称，写库前拦截）

// 默认头像（微信官方默认头像）
const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0';

Page({
  data: {
    url: app.globalData.url,
    theme: 'light',
    audit: false, // 是否开放注册（管理员后台开关）
    userInfo: {
      userId: '',
      nickName: '',
      avatarUrl: defaultAvatarUrl,
    },
    usedName: '',    // 进入页面时原来的昵称（用于判断是否改名）
    sameName: false, // 昵称是否与其他用户重名
    forbidWord: '',  // 昵称是否命中禁用词（官方/北理珠关爱部等仿冒词），命中的词原样回显
  },

  /** 页面加载 */
  async onLoad(options) {
    guard.ensureNotBanned();
    // 本页整页被 `wx:if="{{audit}}"` 包着（regist.wxml 第 1 行），所以这个 audit 决定
    // "看不看得见注册 / 改资料的表单"。
    // 【为什么用 getAuditForMyPage 而不是 getAuditForMe —— 这两个必须对齐】
    //   本页的入口只有一个：「我的」页的「注册用户资料」按钮和头像（mydetail 的 editMessage），
    //   而那一块显示的判据正是 myPageOpen。两处口径一旦不一致，就会出现
    //   **「按钮看得见、点进去是白页」** —— 这在改用本函数之前是真实存在的 bug：
    //   审核模式下已注册的人（没有 enable 字段，是绝大多数）点自己的头像进来，整页空白。
    //   同理，未注册者在「关于」页连点五次临时开放注册入口时，myPageOpen 第 4 项
    //   unlocked 一开，按钮和本页**同时**可见（不会只开一半）。
    // 【不会让谁多注册出一个账号】本页注册用的是当前登录者的 openid（下面 initUserState 之后取，
    //   不信任链接参数），管理员在这里注册的只是他自己那条 Feeder 记录。
    this.setData({ audit: await db.getAuditForMyPage() });
    // 身份一律以服务端登录态为准（不信任分享链接里的 userId 参数，
    // 防止带入他人 openid 后注册/修改时覆盖别人的资料）
    await db.initUserState();
    const userId = app.globalData.userId || '';
    this.setData({ 'userInfo.userId': userId });

    // 若已注册，回填原有资料
    if (userId) {
      try {
        const info = await db.findOne('Feeder', { userId });
        if (info) {
          this._originalPhone = info.phoneNum || ''; // 记录原始手机号，提交时判断是否修改
          this._originalAvatar = info.avatarUrl || ''; // 记录原始头像，改名时判断是否有旧 COS 头像要删
          this.setData({
            userInfo: info,
            usedName: info.nickName,
          });
        }
      } catch (e) {
        console.error('读取用户资料失败', e);
      }
    }

    // 跟随系统深浅色模式
    try {
      this.setData({ theme: wx.getAppBaseInfo().theme || 'light' });
    } catch (e) { /* 忽略 */ }
    this._themeListener = (result) => {
      this.setData({ theme: result.theme });
    };
    wx.onThemeChange(this._themeListener);
  },

  /** 页面卸载时清理主题监听器，防止内存泄漏 */
  onUnload() {
    if (this._themeListener) {
      wx.offThemeChange(this._themeListener);
      this._themeListener = null;
    }
  },

  /** 输入昵称：清洗后实时检查禁用词 + 是否与其他用户重名（重名防抖 300ms，避免每次按键都打数据库） */
  onInput(e) {
    // 先清洗（昵称会用作头像文件名，去掉危险字符并限长 20 字）
    const nickName = guard.sanitizeFileName(e.detail.value, 20);
    // 禁用词（官方/北理珠关爱部等仿冒词）实时拦截：命中就不再做重名查询
    const forbid = guard.forbiddenName(nickName);
    this.setData({ 'userInfo.nickName': nickName, forbidWord: forbid });
    if (forbid) {
      clearTimeout(this._nameTimer);
      this.setData({ sameName: false });
      return;
    }
    // 防抖：停止输入 300ms 后才真正查询
    clearTimeout(this._nameTimer);
    this._nameTimer = setTimeout(() => {
      this._nameSeq = (this._nameSeq || 0) + 1;
      const seq = this._nameSeq;
      const userId = this.data.userInfo.userId;
      db.find('Feeder', { nickName })
        .then((list) => {
          if (seq !== this._nameSeq) return; // 输入又变了，丢弃过期响应
          const first = list[0];
          const exists = !!first && first.userId !== undefined && first.userId !== userId;
          this.setData({ sameName: exists });
        })
        .catch(() => {
          if (seq === this._nameSeq) this.setData({ sameName: false });
        });
    }, 300);
  },

  /** 输入手机号 */
  onInput1(e) {
    this.setData({ 'userInfo.phoneNum': e.detail.value });
  },

  /** 点头像按钮：选头像必须由微信官方的 open-type="chooseAvatar" 按钮原生触发（唯一合规入口），
   *  这里只做隐私授权前置——用户此前拒绝过隐私指引时，原生入口会静默失效（点了完全没反应），
   *  同步调用 requirePrivacyAuthorize 拉起官方隐私弹窗即可恢复；已授权 / 无此接口时什么也不做。 */
  onAvatarTap() {
    try {
      if (typeof wx.requirePrivacyAuthorize === 'function') {
        wx.requirePrivacyAuthorize({
          fail: (err) => console.warn('[regist] 隐私授权未通过', err),
        });
      }
    } catch (e) {
      console.warn('[regist] 拉起隐私授权失败', e);
    }
  },

  /** 用户选完头像（微信原生 chooseavatar 回调）：拿到的是临时路径（wxfile://），提交时再上传到 COS */
  onChooseAvatar(e) {
    const url = e && e.detail && e.detail.avatarUrl;
    if (!url) return;
    this.setData({ 'userInfo.avatarUrl': url });
  },

  /** 点击"提交" */
  upload() {
    wx.showModal({
      title: '提示',
      content: '确定提交吗？',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._submitting) return; // 防止异步流程中重复提交
        // 昵称再兜底清洗一次（防历史数据带入危险字符，昵称会用作头像文件名）
        const nickName = guard.sanitizeFileName(this.data.userInfo.nickName || '', 20);
        this.setData({ 'userInfo.nickName': nickName });
        // 必填项：昵称。头像改为**选填**（2026-08-29）——未选头像就存默认头像地址，
        // 不再硬拦「请选择头像」：头像选择接口在部分机型 / 隐私未授权时会静默失效，
        // 硬拦会把用户永久卡死在注册这一步。
        if (guard.isEmpty(nickName)) {
          wx.showToast({ icon: 'error', title: '请输入昵称' });
        } else if (guard.forbiddenName(nickName)) {
          // 仿冒官方/误导性词兜底拦截（onInput 已实时提示，这里是提交前最后一关）
          this.setData({ forbidWord: guard.forbiddenName(nickName), sameName: false });
          wx.showToast({ icon: 'error', title: '昵称含仿冒/误导词汇，请更换' });
        } else if (this.data.sameName) {
          wx.showToast({ icon: 'error', title: '请更换名字' });
        } else if (!this.data.userInfo.userId) {
          wx.showToast({ icon: 'error', title: '登录异常，请重试' });
        } else if (!this.checkPhone()) {
          // 手机号格式不合法时 checkPhone 内部已提示
        } else {
          // 提交前强制查重（防抖窗口内提交 / 过期响应会漏过重名，这里兜底）
          // 与 onInput 口径一致：排除自己（改名的老用户），防止两个账号共用同名头像文件
          try {
            const dup = await db.find('Feeder', { nickName });
            const userId = this.data.userInfo.userId;
            const exists = dup.some(function (r) {
              return r.userId !== undefined && r.userId !== userId;
            });
            if (exists) {
              this.setData({ sameName: true });
              wx.showToast({ icon: 'error', title: '该昵称已被使用，请更换' });
              return; // 查重失败（重名）不消耗限频，改完可立即重提
            }
          } catch (err) {
            console.error('提交前查重失败', err);
            // 查重失败不阻断（与线上宽松行为一致，避免网络抖动卡死注册）
          }
          // 校验/查重都通过后才限频（防连点）：失败路径不占限频窗口
          if (!guard.throttle('regist_submit', 1500)) return;
          // 内容安全审核昵称（写库前拦截，自带 loading；注册/改资料共用）
          const _passed = await secCheck.guardBeforePublish(nickName, 1);
          if (!_passed) {
            guard.resetThrottle('regist_submit'); // 拦截：改完可立即重提
            return;
          }
          this._submitting = true;
          try {
            if (app.globalData.isFeeder) {
              await this.updateFeeder(); // 已注册 → 修改资料
            } else {
              await this.registFeeder(); // 未注册 → 注册
            }
          } catch (err) {
            this._submitting = false;
            guard.resetThrottle('regist_submit'); // 异常失败：重试不等待
            wx.hideLoading();
            console.error(err);
            wx.showToast({ icon: 'error', title: '操作失败' });
          }
        }
      },
    });
  },

  /** 是否「没选过头像」（保持默认头像 / 空）→ 提交时存默认头像地址，不上传 COS（头像选填的备用方案） */
  isDefaultAvatar(url) {
    return !url || url === defaultAvatarUrl;
  },

  /** 手机号格式校验（选填；填了就要大致像个手机号） */
  checkPhone() {
    const phone = (this.data.userInfo.phoneNum || '').trim();
    if (phone === '') return true; // 选填，不填直接通过
    if (guard.tooLong(phone, 20) || !/^[+\d][\d\- ]{2,19}$/.test(phone)) {
      wx.showToast({ icon: 'error', title: '手机号格式不正确' });
      return false;
    }
    return true;
  },

  /** 修改已注册用户的资料（更新 Feeder + 同步他的历史推文作者信息） */
  async updateFeeder() {
    wx.showLoading({ title: '更新中...', mask: true });
    const userInfo = this.data.userInfo;
    const nickName = userInfo.nickName;
    // 未选头像 → 存默认头像地址（不再依赖 COS 头像文件）；选了 → 存 COS 地址
    const avatarUrl = this.isDefaultAvatar(userInfo.avatarUrl) ? defaultAvatarUrl : cos.profileUrl(nickName);
    const phoneNum = userInfo.phoneNum;
    const userId = userInfo.userId;
    const oldName = this.data.usedName;

    // 无任何改动 → 跳过 DB 写入和头像上传，避免无意义的网络请求
    const avatarChanged = typeof userInfo.avatarUrl === 'string' &&
      (userInfo.avatarUrl.indexOf('wxfile://') === 0 || userInfo.avatarUrl.indexOf('http://tmp') === 0);
    const nameChanged = oldName && oldName !== nickName;
    const phoneChanged = String(phoneNum || '') !== String(this._originalPhone || '');
    if (!avatarChanged && !nameChanged && !phoneChanged) {
      this._submitting = false;
      guard.resetThrottle('regist_submit'); // 无改动 = 未真正提交，不占限频
      wx.hideLoading();
      wx.showToast({ icon: 'none', title: '未做修改' });
      return;
    }

    await this.uploadImg(); // 上传头像（若改名还会删除旧头像）

    // 【这里刻意**不**写 enable】`enable` 是"审核模式豁免"的身份标记，只由两条路授予：
    //   ① 管理员审批通过发布权申请（adminManage 的 applyDecision）；
    //   ② 用户在「关于」页连点 logo 五次（about.js 的 staffTap → postApply 云函数的 selfEnable）。
    //   注册页只是改个昵称/头像，不该顺手把这个身份发出去 —— 早先这行里带着
    //   `enable: true`，等于"随便改一次资料就自己拿到豁免"，与本期口径相反。
    //   注意：本次改动**不会**抹掉已有的 enable=true（$set 不含它就是不碰它）。
    const setData = { nickName: guard.toText(nickName), avatarUrl };
    if (phoneNum !== undefined && phoneNum !== null && String(phoneNum).trim() !== '') {
      setData.phoneNum = guard.toText(phoneNum);
    }
    db.updateOne(
      'Feeder',
      { userId },
      { $set: setData }
    ).then(() => {
      this.setData({ 'userInfo.nickName': nickName, 'userInfo.avatarUrl': avatarUrl });
      // 昵称变了 → 同步更新该用户历史推文的作者名和头像
      if (this.data.usedName && this.data.usedName !== nickName) {
        this.uploadPage();
        // DB 写成功后再删旧头像（COS 不会自动删旧文件），避免 DB 失败时旧头像已被删 → 头像 404。
        // 仅当原来确实有 COS 头像时才删：一直用默认头像的用户没有旧文件可删
        if (this._originalAvatar && this._originalAvatar !== defaultAvatarUrl) {
          cos.deleteList([cos.profilePng(this.data.usedName)]);
        }
      }
      // 刷新全局状态，并通知其他页面
      this.updateGlobalState({ nickName, avatarUrl, phoneNum });
      wx.hideLoading();
      wx.showToast({ icon: 'success', title: '操作成功' });
      setTimeout(() => wx.reLaunch({ url: '/pages/mydetail/mydetail' }), 500);
    }).catch((err) => {
      this._submitting = false;
      guard.resetThrottle('regist_submit'); // 写库失败：重试不等待
      wx.hideLoading();
      console.error(err);
      wx.showToast({ icon: 'error', title: '操作失败' });
    });
  },

  /** 新用户注册 */
  async registFeeder() {
    wx.showLoading({ title: '更新中...', mask: true });
    const userInfo = this.data.userInfo;
    const nickName = userInfo.nickName;
    // 未选头像 → 存默认头像地址（不再依赖 COS 头像文件）；选了 → 存 COS 地址
    const avatarUrl = this.isDefaultAvatar(userInfo.avatarUrl) ? defaultAvatarUrl : cos.profileUrl(nickName);
    const phoneNum = userInfo.phoneNum;
    const userId = userInfo.userId;

    await this.uploadImg(); // 上传头像

    const insertData = {
      userId,
      nickName: guard.toText(nickName),
      avatarUrl,
    };
    if (phoneNum !== undefined && phoneNum !== null && String(phoneNum).trim() !== '') {
      insertData.phoneNum = guard.toText(phoneNum);
    }
    db.insertOne('Feeder', insertData).then(() => {
      this.updateGlobalState({ nickName, avatarUrl, phoneNum });
      wx.hideLoading();
      wx.showToast({ icon: 'success', title: '操作成功' });
      setTimeout(() => wx.reLaunch({ url: '/pages/mydetail/mydetail' }), 500);
    }).catch((err) => {
      this._submitting = false;
      guard.resetThrottle('regist_submit'); // 写库失败：重试不等待
      wx.hideLoading();
      console.error(err);
      wx.showToast({ icon: 'error', title: '操作失败' });
    });
  },

  /** 同步修改历史推文的作者信息（author / authorImg） */
  uploadPage() {
    db.updateMany(
      'Page',
      { authorId: this.data.userInfo.userId },
      {
        $set: {
          author: this.data.userInfo.nickName,
          // 头像：未上传头像的用户用默认头像地址，避免历史推文头像 404 回退到占位图
          authorImg: this.data.userInfo.avatarUrl || defaultAvatarUrl,
        },
      }
    ).catch((err) => console.error(err));
  },

  /** 上传头像到 COS（目录 main/images/profile/，文件名 = 昵称.png）。
   *  选了新头像 → 直接上传；仅改名 → COS 服务端复制（不重新传图，快且省流量）。 */
  async uploadImg() {
    const userInfo = this.data.userInfo;
    const nickName = userInfo.nickName;
    const avatarUrl = userInfo.avatarUrl;
    // 未选头像（默认头像 / 空）→ 既不上传也不复制，直接存默认头像地址（头像选填）
    if (this.isDefaultAvatar(avatarUrl)) return;
    const isLocal = typeof avatarUrl === 'string' && (avatarUrl.indexOf('wxfile://') === 0 || avatarUrl.indexOf('http://tmp') === 0);
    const renamed = this.data.usedName && this.data.usedName !== nickName;
    // 选了新头像（本地文件）→ 上传到新文件名下
    if (isLocal) {
      const ok = await cos.uploadList([{ Key: cos.profilePng(nickName), FilePath: avatarUrl }]);
      if (ok < 1) {
        wx.showModal({ title: '提示', content: '头像上传失败，请重试', showCancel: false });
        throw new Error('头像上传失败');
      }
    } else if (renamed) {
      // 仅改名未换头像：COS 服务端复制旧头像到新 key，避免下载再上传
      const oldKey = cos.profilePng(this.data.usedName);
      const newKey = cos.profilePng(nickName);
      try {
        await cos.copyObject(oldKey, newKey);
      } catch (e) {
        // 服务端复制失败（旧头像可能不存在）→ 回退到下载再上传
        console.error('头像复制失败，回退到下载上传', e);
        const ok = await cos.uploadList([{ Key: newKey, FilePath: avatarUrl }]);
        if (ok < 1) {
          wx.showModal({ title: '提示', content: '头像上传失败，请重试', showCancel: false });
          throw new Error('头像上传失败');
        }
      }
    }
    // 注意：删除旧头像移到 updateFeeder 的 DB 写成功之后再执行（见 updateFeeder），
    // 避免 DB 更新失败时旧头像已被删 → 头像永久 404
  },

  /** 更新全局用户状态并清除缓存，通知所有页面刷新 */
  updateGlobalState({ nickName, avatarUrl, phoneNum }) {
    app.globalData.isFeeder = true;
    app.globalData.userInfo.nickName = nickName;
    app.globalData.userInfo.avatarUrl = avatarUrl;
    app.globalData.userInfo.phoneNum = phoneNum;
    db.resetUserState(); // 清掉缓存，让其他页面重新查询最新状态
    app.notifyPageDataListeners(app.globalData.userInfo);
  },
});
