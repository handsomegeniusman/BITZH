// ============================================================
// custom-tab-bar/index.js —— 自定义底部导航（小红书式中间加号）
// 【作用】4 个 tab（查猫/小猫书/关于/我的）+ 中间凸起加号（发布新帖）。
//        微信原生 tabBar 不支持中间凸起按钮，故用 custom:true + 本组件。
//        每个 tab 页 onShow 里调用 getTabBar().setData({selected}) 同步高亮。
// ============================================================
const app = getApp();
const pageUtil = require('../utils/page.js'); // 未登录弹窗（与 index 页发布入口一致）
const db = require('../utils/db.js'); // 审核开关（audit=false 时隐藏发布加号）

Component({
  data: {
    selected: 0,              // 当前选中 tab（渲染顺序：查猫=0 小猫书=1 关于=2 我的=3）
    color: '#888888',         // 未选中文字色
    selectedColor: '#FF405E', // 选中文字色（主粉）
    // 中间加号的两个显示条件，缺一不可：
    //   audit      —— 发布开关（Administrator 集合的 audit 字段），关掉时全站停止发布
    //   canPublish —— 有没有发布权（管理员，或申请获批的普通用户）
    // 两个都默认 false：身份和开关还没取回来之前先隐藏，宁可晚一点出现也不要一闪而过。
    audit: false,
    canPublish: false,
    // 4 个 tab 的路径清单（WXML 按此渲染，中间加号不占 tab 项）
    list: [
      { pagePath: '/pages/catSearch/catSearch', text: '查猫', index: 0 },
      { pagePath: '/pages/index/index', text: '小猫书', index: 1 },
      { pagePath: '/pages/about/about', text: '关于', index: 2 },
      { pagePath: '/pages/mydetail/mydetail', text: '我的', index: 3 },
    ],
  },

  lifetimes: {
    attached() {
      this.refreshAudit();
    },
  },

  methods: {
    /**
     * 刷新中间加号的显示条件（发布开关 audit + 当前用户有没有发布权）。
     * 【为什么两件事在这里一起算】加号能不能出现，取决于"发布开关开没开"和"我有没有发布权"，
     *   分散在两处判断迟早会不一致。这里一次算完，WXML 只认最终结果。
     * 【为什么必须 await initUserState】本组件 attached 的时机早于页面 onLoad 里那次
     *   initUserState 完成，此刻 app.globalData.isAdministrator 还是初始的 false，
     *   直接读会把管理员也判成普通用户 —— 连自己的加号都看不到。
     *   initUserState 内部有 administratorChecked 缓存，页面已经查过时这里不会再查库。
     * 【方法名没改】4 个 tab 页的 onShow 都在调 refreshAudit()，改名要同步改 4 处；
     *   留着这个名字，它们这次自动跟着一起更新。
     */
    async refreshAudit() {
      try {
        await db.initUserState();
      } catch (err) {
        console.error('[tabBar] 读取用户身份失败', err);
      }
      let audit = false;
      try {
        // 【为什么用 getAuditForMe】加号也要跟着豁免走：Feeder.enable=true 的注册用户
        //   和**管理员**在审核模式下照常能发帖，否则会出现"内容看得见、加号却没了"的
        //   自相矛盾 —— 尤其管理员：canPublish() 认管理员身份（加号照常出现），
        //   这里若还读全局 audit，就正好凑成"加号在、内容看不见"那种最别扭的组合。
        //   上面那次 initUserState 已经保证 state.enable / state.isAdministrator 就绪
        //   （本函数原本就要它来算 canPublish）。
        audit = !!(await db.getAuditForMe());
      } catch (err) {
        console.error('[tabBar] 读取审核开关失败', err);
      }
      this.setData({
        audit: audit,
        // 走 db.canPublish() 而不是自己写 isAdministrator || canPost：这个判断式有 4 个入口，
        // 各写各的迟早漂移（典型症状：加号没了但评论还能发）。文件头 db 的 require 就是为它留的。
        canPublish: db.canPublish(),
      });
    },
    /** 切换 tab（微信要求 tab 间跳转用 switchTab） */
    switchTab(e) {
      const path = e.currentTarget.dataset.path;
      if (!path) return;
      console.log('[tabBar] switchTab ->', path);
      wx.switchTab({
        url: path,
        fail: (err) => console.error('[tabBar] switchTab 失败 ->', path, err),
        complete: (res) => console.log('[tabBar] switchTab complete ->', path, res),
      });
    },

    /** 中间加号：发布新帖（与 index 页 addBooklet 守卫一致：已注册跳转，未注册弹注册） */
    addPost() {
      // 加号已经用 wx:if 藏起来了，这里再兜一道：藏元素挡不住代码调用，
      // 权限判断要落在"能不能做"上，而不是"看不看得见按钮"上。
      if (!db.canPublish()) return;
      if (app.globalData.isFeeder) {
        wx.navigateTo({ url: '/pages/addBooklet/addBooklet' });
      } else {
        pageUtil.promptRegister(app.globalData.userId);
      }
    },
  },
});
