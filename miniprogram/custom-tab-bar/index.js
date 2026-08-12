// ============================================================
// custom-tab-bar/index.js —— 自定义底部导航（小红书式中间加号）
// 【作用】4 个 tab（查猫/小猫书/关于/我的）+ 中间凸起加号（发布新帖）。
//        微信原生 tabBar 不支持中间凸起按钮，故用 custom:true + 本组件。
//        每个 tab 页 onShow 里调用 getTabBar().setData({selected}) 同步高亮。
// ============================================================
const app = getApp();
const pageUtil = require('../utils/page.js'); // 未登录弹窗（与 index 页发布入口一致）

Component({
  data: {
    selected: 0,              // 当前选中 tab（渲染顺序：查猫=0 小猫书=1 关于=2 我的=3）
    color: '#888888',         // 未选中文字色
    selectedColor: '#FF405E', // 选中文字色（主粉）
    // 4 个 tab 的路径清单（WXML 按此渲染，中间加号不占 tab 项）
    list: [
      { pagePath: '/pages/catSearch/catSearch', text: '查猫', index: 0 },
      { pagePath: '/pages/index/index', text: '小猫书', index: 1 },
      { pagePath: '/pages/about/about', text: '关于', index: 2 },
      { pagePath: '/pages/mydetail/mydetail', text: '我的', index: 3 },
    ],
  },

  methods: {
    /** 切换 tab（微信要求 tab 间跳转用 switchTab） */
    switchTab(e) {
      const path = e.currentTarget.dataset.path;
      if (!path) return;
      wx.switchTab({ url: path });
    },

    /** 中间加号：发布新帖（与 index 页 addBooklet 守卫一致：已注册跳转，未注册弹注册） */
    addPost() {
      if (app.globalData.isFeeder) {
        wx.navigateTo({ url: '/pages/addBooklet/addBooklet' });
      } else {
        pageUtil.promptRegister(app.globalData.userId);
      }
    },
  },
});
