// ============================================================
// pages/about/about.js —— 关于页
// 【作用】展示社团介绍、联系方式、二维码、外部链接；
//        提供"看广告赚猫粮"的激励视频广告；管理员可进入后台。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const config = require('../../config.js'); // 全局配置（广告位 ID 等）
const clipboard = require('../../utils/clipboard.js'); // 复制到剪贴板（统一反馈 + 隐私授权兜底）

let videoAd = null; // 激励视频广告实例（首次点击时才创建）

Page({
  data: {
    url: app.globalData.url,
    blackNum: false, // 是否在黑名单中（黑名单用户显示"请离开"弹窗）
    popupAnimation: {}, // 弹窗动画对象（blackNumPopup 模板需要）
    screenWidth: 0,
    screenHeight: 0,
    imgwidth: 0,
    imgheight: 0,
    // 联系方式默认值：数据库（Administrator 集合）查询失败时兜底显示
    phone: '18122371332',
    email: '1758906597@qq.com',
  },

  /** 页面加载：初始化用户状态（保证管理员能进入后台），并检查黑名单 */
  async onLoad() {
    console.log('[about] onLoad 开始');
    // 用户状态查询失败不能阻塞页面加载（否则 switchTab 超时、页面灰屏）
    try {
      await db.initUserState();
      console.log('[about] initUserState OK, isAdministrator=', app.globalData.isAdministrator, 'isFeeder=', app.globalData.isFeeder);
    } catch (e) {
      console.error('[about] initUserState 失败（不影响页面显示）', e);
    }
    try {
      const blackNum = await db.isBlacklisted(); // 黑名单用户禁止访问任何页面，直接清退
      console.log('[about] isBlacklisted =', blackNum);
      if (blackNum) wx.reLaunch({ url: '/pages/banned/banned' });
    } catch (e) {
      console.error('[about] isBlacklisted 失败（不影响页面显示）', e);
    }
    console.log('[about] onLoad 完成');
  },

  /** 页面显示：同步底部自定义 tabBar 选中态（关于=2），并刷新联系方式 */
  onShow() {
    console.log('[about] onShow 触发');
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
      if (typeof this.getTabBar().refreshAudit === 'function') this.getTabBar().refreshAudit();
    }
    this.loadContact(); // onShow 每次都会触发，管理员改完联系方式回来即可看到新值
  },

  /** 离开页面：清掉连点计数（点的是顶部 logo，见 staffTap 的计数口径） */
  onHide() {
    this._staffTaps = 0;
  },

  onUnload() {
    this._staffTaps = 0;
  },

  /**
   * 从数据库读取联系方式（Administrator 集合的 phone / email 字段）。
   * 查询失败或字段为空时保持默认值，不阻塞页面显示。
   */
  loadContact() {
    const self = this;
    db.getContact().then(function (c) {
      const patch = {};
      if (c && c.phone) patch.phone = c.phone;
      if (c && c.email) patch.email = c.email;
      if (Object.keys(patch).length) self.setData(patch);
    }).catch(function (e) {
      console.error('[about.loadContact] 查询联系方式失败，显示默认值', e);
    });
  },

  /** 按需创建激励视频广告实例（避免页面加载时触发广告组件报错） */
  createVideoAd() {
    if (!wx.createRewardedVideoAd) return null;
    const ad = wx.createRewardedVideoAd({ adUnitId: config.adUnitIds.video });
    ad.onError((err) => console.log('激励视频广告错误', err));
    // 看完广告后把结果同步给用户：完整观看才算数，中途退出不给奖励，两种结果都要明确提示
    ad.onClose((res) => {
      const isEnded = !!(res && res.isEnded);
      console.log('[about.videoAd.onClose] 是否完整观看 isEnded=', isEnded, res);
      if (isEnded) {
        wx.showToast({ title: '观看完成，赞助收益已计入', icon: 'success', duration: 2000 });
      } else {
        wx.showToast({ title: '未完整观看，本次不计入赞助', icon: 'none', duration: 2000 });
      }
    });
    return ad;
  },

  /** 点击"看广告赚猫粮" */
  showVideo() {
    wx.showModal({
      title: '观看广告赚猫粮',
      content: '完整观看广告后，赞助收益将计入流浪猫救助经费',
      success: (res) => {
        if (!res.confirm) return;
        if (!videoAd) videoAd = this.createVideoAd();
        if (!videoAd) return;
        videoAd.show().catch(() => {
          // 首次可能未加载好，加载后再展示
          videoAd.load()
            .then(() => videoAd.show())
            .catch((err) => {
              console.log('激励视频广告显示失败', err);
              wx.showToast({ title: '广告暂不可用，请稍后再试', icon: 'none' });
            });
        });
      },
    });
  },

  /** 关闭黑名单"请离开"弹窗 */
  hidePopup() {
    this.setData({ blackNum: false });
  },
  closePopup() {
    this.setData({ blackNum: false });
  },

  /** 黑名单弹窗兜底：去申诉页（正常情况下黑名单用户会被 reLaunch 到 banned 页） */
  goAppeal() {
    wx.navigateTo({ url: '/pages/appeal/appeal' });
  },

  // ============ 复制联系方式（about 页内容，按需求保留） ============
  // 统一封装：成功/失败都明确反馈（真机上系统自带的"已复制"提示可能不显示，
  // 所以这里主动 showToast，并打日志方便排查真机点击无反应的问题）。
  // 失败时（尤其 iOS 报 setClipboardData:fail:system permission denied / errno 3）：
  // 先查 scope.clipboard 授权状态 → 引导用户去小程序设置里打开剪贴板权限，或重试。
  _copy(data, label) {
    console.log('[about._copy] 点击复制', label, data);
    // 2026-09-14：不再用 privacy.guard 包一层（自定义弹窗那条路真机会静默挂起，点了没反应）。
    // 统一走 utils/clipboard.js：成功弹「已复制」；隐私未授权自动拉官方弹窗重试；
    // 仍失败（如 scope.clipboard 被关）才交给 _copyFail 引导去设置。
    clipboard.copy(data, label, () => this._copyFail(data, label));
  },

  /** 复制失败后的引导：判断剪贴板权限状态，给出可操作路径（去设置 / 重试） */
  _copyFail(data, label) {
    // 1) 查权限：authSetting['scope.clipboard'] === false 表示用户在小程序设置里关掉了剪贴板
    wx.getSetting({
      success: (res) => {
        const denied = !!(res.authSetting && res.authSetting['scope.clipboard'] === false);
        console.log('[about._copyFail] 剪贴板权限状态 authSetting=', res.authSetting, 'denied=', denied);
        wx.showModal({
          title: '复制失败',
          content: denied
            ? '剪贴板权限被关闭了，点击「去设置」打开后即可正常复制。'
            : '系统未允许写入剪贴板（iOS 首次复制会弹系统授权，需点「允许粘贴」）。点击「去设置」开启，或点「重试」再试一次。',
          confirmText: '去设置',
          cancelText: '重试',
          success: (r) => {
            if (r.confirm) {
              // 2) 打开小程序设置页，用户手动打开"剪贴板"开关
              wx.openSetting({
                success: (s) => {
                  console.log('[about._copyFail] openSetting 返回', s.authSetting);
                  // 用户回来时剪贴板已允许 → 自动重试复制，省得再点一次
                  const allowed = !!(s.authSetting && s.authSetting['scope.clipboard'] !== false);
                  if (allowed) {
                    console.log('[about._copyFail] 权限已开启，自动重试复制', label);
                    this._copy(data, label);
                  } else {
                    wx.showToast({ title: '剪贴板权限未开启', icon: 'none' });
                  }
                },
                fail: (e) => console.error('[about._copyFail] openSetting 失败', e),
              });
            } else {
              // 3) 重试：用户刚点了系统"允许粘贴"后再复制一次
              console.log('[about._copyFail] 用户选择重试', label);
              this._copy(data, label);
            }
          },
        });
      },
      // 连 getSetting 都失败（极端情况）：兜底提示，不阻塞
      fail: () => {
        console.error('[about._copyFail] getSetting 失败');
        wx.showToast({ title: '复制失败，请长按手动复制', icon: 'none' });
      },
    });
  },
  copyTBL() {
    this._copy(this.data.phone, '联系电话'); // 联系电话（数据库 Administrator 集合，查询失败显示默认值）
  },
  copyTBL1() {
    this._copy(this.data.email, '邮箱'); // 邮箱（数据库 Administrator 集合，查询失败显示默认值）
  },
  copyWechat() {
    this._copy('北大猫协', '公众号名'); // 公众号名
  },
  copyTBL4() {
    this._copy('https://gitee.com/circlelq/SCCAPKU-miniprogram', '原项目 Gitee 链接'); // 原项目（北大猫协）开源链接
  },
  copyGithub() {
    this._copy('https://github.com/handsomegeniusman/BITZH', 'GitHub 开源仓库'); // 作者 GitHub 仓库
  },
  copyGitee() {
    this._copy('https://gitee.com/handsomejenius2', 'Gitee 开源仓库'); // 作者 Gitee 仓库
  },
  previewQR2() {
    wx.previewImage({ urls: ['/pages/images/twoweima.jpg'] }); // 二维码2
  },
  copyTBL6() {
    wx.previewImage({ urls: ['/pages/images/店铺.jpg'] }); // 店铺图片
  },

  /** 跳转合作小程序 */
  naviToMini() {
    wx.navigateToMiniProgram({
      appId: 'wx0fb7b06a5065be09',
      envVersion: 'release',
      success(res) {
        // 打开成功
      },
    });
  },

  /** 管理员进入后台（长按 logo 触发） */
  edit() {
    // 【第一件事是记时间戳，再干别的】它是 staffTap 用来"吃掉这次 tap"的依据，
    //   所以必须在 wx.navigateTo **之前**写 —— 跳转是异步的，放后面可能还没写就切页了。
    //   无论是不是管理员都要记：非管理员长按不做任何事，但那次手势同样不该算连点。
    this._lastLongPressAt = Date.now();
    if (app.globalData.isAdministrator) {
      wx.navigateTo({ url: '/pages/Administrator/Administrator' });
    }
  },

  /**
   * 「关于」页**顶部 logo** 的点击计数。连点 **5 次** → 按「**注册没注册**」分流成两条完全不同的路。
   *
   * 【连点对象是 logo，不是底部那四行 —— 2026-09-17 改的】
   *   原先挂在底部四行（小程序开发 / 信息整理 / logo制作 / 版本号）上，需求方口径是
   *   「连点关于页面里的 logo」，所以挪到了 logo。四行现在**只是署名**、没有任何点击行为。
   *   ⚠️ **同一个 logo 上还挂着长按**（wxml 的 `bindlongpress="edit"` → 管理员进后台）。
   *      两者共存，但"不冲突"**不是靠平台语义保证的**，见下面那条。
   *   ⚠️ 计数只在**本页停留期间**累计（onHide / onUnload 清零），所以它天然是"在某一次
   *      打开关于页的过程中点满 5 下"。改成 logo 不改变这个口径。
   *
   * 【长按与连点为什么会冲突，以及为什么不用赌平台行为】
   *   微信文档里写着 longpress 触发后 tap 不再触发（原文这句是针对 longtap 说的，
   *   longpress 是它的替代品）。但这条**没在真机上验过**，而两个绑定挂在同一个元素上，
   *   一旦语义不是那样，表现是**管理员每次长按进后台都白 +1** —— 攒够 5 次就弹一个
   *   他根本不需要的"已开通"（管理员本来就在豁免名册里）。
   *   一个每次进后台都发生的、无声的副作用，不值得拿文档去赌。
   *   → 所以本函数开头用 `_lastLongPressAt` 时间戳自己吃掉紧跟在长按后的那次 tap。
   *     用**时间戳**而不是布尔标志：布尔标志在"平台确实抑制了 tap"时会永远留着 true，
   *     反把下一次**真的连点**吃掉（那才是更难查的 bug）。时间戳会自己过期。
   *     ⚠️ 与 edit() 是一对：那边写、这边读，字段名改了两处一起改。
   *
   *
   * 【两条路 —— 需求方原话】「连点五次是在用户已经注册的情况下才可以使用，
   *   否则连点五次是暂时授权开放注册页面」：
   *   ┌ 已注册（有 Feeder 记录）→ grantSelfEnable：云函数写 `Feeder.enable = true`，
   *   │    并推一条通知到飞书申请群。**换的是"审核模式下看得见内容"**。
   *   └ 未注册（没有 Feeder 记录）→ unlockRegist：只临时开放**注册入口**，
   *        纯内存态、不写库、不走云函数、也没有飞书通知。
   *
   * 【它给的是什么、不给什么 —— 说在最前面】
   *   给（已注册）：**审核模式下能看见内容**（首页瀑布流、评论区、底部加号）。
   *   给（未注册）：**注册页的可见性**（以及「我的」页里那个注册按钮）。
   *   不给（两种都不给）：**发帖权**。发帖/评论权是另一个字段（`Feeder.canPost`），
   *   只有 adminManage 云函数能写（管理员审批通过）。所以连点五次**换不来**发帖权限
   *   —— 别把它当成自助审批。
   *   ⚠️ 未注册那条**不会**让人看见任何社区内容：它只开注册页。公共内容走的是
   *      `auditOpen`，那个判断式根本不收这个开关（见 utils/auditGate.js）。
   *
   * 【为什么有这个自助口子】`enable` 只有两条来路：管理员审批通过、或这里连点五次。
   *   社团成员十几个人，逐个等管理员批太慢，这条让本人自助。
   * 【计数口径】同一次停留内累计，离开页面（onHide / onUnload）清零。**刻意不设时间窗** ——
   *   设了会让手速慢的人以为功能坏了，而它本来就不是防人的机制。
   * 【已注册那条为什么走云函数而不再直接写库】原来这里是
   *   `db.updateOne('Feeder', {userId}, ...)`，而 `userId` 取自客户端 —— 小程序当然传自己，
   *   但改过的客户端可以传**别人的**，那就是"替别人开通"。改走云函数后 userId 由服务端
   *   `getInfo` 派生，这个 action 在结构上就没有"开通别人"这个参数。
   *   详见 cloudfunctions/postApply/index.js 的 selfEnable。
   *   ⚠️ 这防的是"改客户端替别人开"，**不防"绕开小程序直写库"**（那种人本来就能写）：
   *      `Feeder` 目前仍是客户端可写的（注册页就在写），真正的收口是集合权限规则。
   */
  staffTap() {
    // 【长按后的那次 tap 不算数 —— 让"长按进后台"与"连点五次"真正不冲突】
    //   见上方 edit() 的说明：不赌微信"longpress 后不触发 tap"的语义。
    //   800ms 的窗口：长按在 350ms 触发，手指抬起后若有 tap 也在几百毫秒内，
    //   而人**故意**连点的间隔通常远小于 800ms —— 所以窗口只吃掉长按那一次，
    //   不会误伤连点（连点本身根本不经过 edit()，_lastLongPressAt 一直是旧的）。
    if (Date.now() - (this._lastLongPressAt || 0) < 800) {
      console.log('[about] 刚长按过 logo，这次点击不计入连点');
      return;
    }
    this._staffTaps = (this._staffTaps || 0) + 1;
    console.log('[about] logo 连点', this._staffTaps, '/ 5');
    if (this._staffTaps < 5) return;
    this._staffTaps = 0;
    // 【分流判据是 isFeeder 而不是"注册按钮点没点过"】initUserState 已经把真实状态写进
    //   globalData.isFeeder（about 的 onLoad 也跑过一次），所以这里读到的是库里的实情。
    //   两条路的判据必须和 service 端一致：云函数那条也会自己再查一遍 Feeder 存不存在。
    if (app.globalData.isFeeder) this.grantSelfEnable();
    else this.unlockRegist();
  },

  /**
   * 未注册者连点五次：临时开放**注册入口**，并把人送到「我的」页。
   * 【为什么这条不走云函数、也没有飞书通知】没有任何东西需要写库 —— 未注册的人
   *   没有 `Feeder` 文档，而这正是"未注册"的定义；也没有身份需要服务端派生、
   *   没有权限需要鉴权：它只是一次本机会话内的许可（见 db.unlockRegist）。
   *   所以它是唯一一条**不经过云函数**的连点分支，别以为这里漏了。
   * 【为什么要弹窗而不是直接 toast】点的人多半不知道自己触发了什么，得告诉他
   *   「现在能注册了 / 去哪儿注册 / 这个状态能维持多久」。toast 一闪而过，装不下三句话。
   * 【为什么顺手 switchTab 到「我的」】注册按钮在那一页；不开的话用户得自己找，
   *   而他不一定知道"注册"这件事在「我的」页里。
   */
  unlockRegist() {
    db.unlockRegist();
    wx.showModal({
      title: '已开放注册入口',
      content: '现在可以注册用户资料了，去「我的」页点「注册用户资料」即可。\n'
        + '此状态只保留到本次退出小程序为止。',
      showCancel: false,
      confirmText: '去注册',
      success: () => {
        wx.switchTab({
          url: '/pages/mydetail/mydetail',
          fail: (e) => console.error('[about] 跳转「我的」页失败（用户可自己点底部标签过去）', e),
        });
      },
    });
  },

  /**
   * 连点五次后真正执行：调 postApply 云函数给自己开通豁免，成功后刷新缓存让内容立刻可见。
   * 【错误文案为什么直接用云函数返回的 msg】与 mydetail 的 invokeApply 同一约定：云函数给的
   *   就是中文人话（NOT_FEEDER / BLACKLISTED / ENABLE_FAILED …），客户端不再重写一套 ——
   *   两套文案迟早漂移，而漂移的那套会让用户看到"登录异常"其实是无处可写。
   */
  async grantSelfEnable() {
    if (!app.globalData.isFeeder) {
      // 【正常到不了这里】staffTap 已经按 isFeeder 分流，未注册的走 unlockRegist。
      //   留着是安全网：万一将来有人改了分流条件（或本方法被别处调用），
      //   至少不会拿一个没有 Feeder 文档的人去调云函数换回一句 NOT_FEEDER。
      wx.showToast({ icon: 'none', title: '请先在「我的」注册用户资料' });
      return;
    }
    // 【这里刻意不再检查 app.globalData.userId】身份由云函数从 getInfo 派生，客户端这份
    //   可能是空的（还没跑完 initUserState），拿它拦人会把本来能开通的用户误挡住。
    // 防连点重复提交（第 5 次之后再点会立刻又凑满一轮）
    if (this._granting) return;
    this._granting = true;
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const mp = app && app.mpServerless;
      if (!mp || !mp.function) throw new Error('云函数不可用 (app.mpServerless.function 为空)');
      const res = await mp.function.invoke('postApply', { action: 'selfEnable' });
      const r = (res && res.result !== undefined) ? res.result : res;
      if (!r || !r.ok) {
        wx.hideLoading();
        // 【UNKNOWN_ACTION 是唯一一条不属于"用户能看懂的中文"的错误】其余失败码
        //   （NOT_FEEDER / BLACKLISTED / ENABLE_REVOKED / LOOKUP_FAILED）说的都是
        //   当事人自己的处境，照原样显示没问题。而 `未知 action: selfEnable` 说的是
        //   **线上云函数的版本** —— 用户既看不懂也无从处理，把开发者字符串糊到他脸上
        //   只会让人以为是自己操作错了。所以翻译成人话，同时把原文留在 console 里：
        //   这是"postApply-deploy.zip 没传/传了旧的"的唯一现场证据，别一起吞掉。
        if (r && r.code === 'UNKNOWN_ACTION') {
          console.error('[about] postApply 返回 UNKNOWN_ACTION —— 线上云函数是旧版，'
            + '请重新上传 cloudfunctions/postApply-deploy.zip。原文：' + r.msg);
          wx.showToast({ icon: 'none', title: '开通功能暂未生效，请稍后再试' });
          return;
        }
        wx.showToast({ icon: 'none', title: (r && r.msg) || '开通失败，请重试' });
        return;
      }
      // 【必须让新状态立刻可见，但**不要**用 resetUserState 那把大扫帚】
      //   清了 userId / administratorChecked / feederChecked / audit 之后，紧接着
      //   switchTab 到首页时闸门得连着跑 4 次网络往返（getInfo → 名册 → Feeder → 全局开关）
      //   才能给出答案 —— 这就是"跳过去有点慢"的来源。而这里真正变的只有 Feeder.enable
      //   一个字段（身份没变、名册没变、全局开关没变），所以精准写那一个。
      //   详见 db.markSelfEnable 的注释。
      db.markSelfEnable();
      wx.hideLoading();
      // 【为什么用弹窗而不是 toast，以及为什么写两句话】需求方口径：「提示请重新进入小程序」。
      //   但上面那行已经把新状态写进内存了（见 db.markSelfEnable），
      //   正常情况下**当场就生效、不需要重进** —— 只写"请重新进入"会让每个用户白重进一次。
      //   反过来只写"已开通"又不够稳：**首页的瀑布流只在 onLoad 读一次闸门**，若首页
      //   已经加载过（用户就是从首页切过来的），切回去时它不会自己重新判断 —— 那时
      //   用户需要知道该做什么。所以两句都写：先给当场生效的说法，再给兜底动作。
      //   （首页那次 stale 的闸门由 index.js 的 onShow 重算处理；这句话是它失效时的兜底。）
      //   用 showModal 是因为 toast 装不下两句（会截断），且这里需要"去首页"这个动作入口。
      wx.showModal({
        title: '已开通',
        content: '审核模式下现在可以看见内容了。\n若首页还是进不去，请完全退出小程序后重新进入。',
        showCancel: false,
        confirmText: '去首页',
        success: () => {
          wx.switchTab({
            url: '/pages/index/index',
            fail: (e) => console.error('[about] 跳转首页失败（用户可自己点底部标签过去）', e),
          });
        },
      });
    } catch (e) {
      wx.hideLoading();
      console.error('[about] 开通审核模式豁免失败', e);
      wx.showToast({ icon: 'none', title: '开通失败，请重试' });
    } finally {
      // 【必须两种结果都解锁】只在 catch 里解锁的话，成功一次之后 `_granting` 永远是 true，
      //   再想连点五次就没反应了 —— 而"再点一次"是很自然的动作（想确认有没有生效）。
      //   注意上面那条 `return` 是在 try 里，finally 照样会跑，解锁不会漏。
      this._granting = false;
    }
  },

  /** 预览二维码大图 */
  previewImage() {
    wx.previewImage({
      urls: ['/pages/images/2weima.jpg'],
      current: '/pages/images/2weima.jpg',
    });
  },

  /** 转发给好友/群 */
  onShareAppMessage() {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/about/about',
    };
  },

  /** 转发到朋友圈 */
  onShareTimeline() {
    return {
      title: '北理珠流浪猫关爱部',
      path: 'pages/about/about',
    };
  },

});
