// ============================================================
// components/kb-done-bar/kb-done-bar.js —— 跟随键盘的「完成」栏
// 【作用】部分输入法没有"收起键盘"的按键，用户很难一键收起键盘。
//         本组件在所有带输入框的页面里挂一行固定在键盘上方的「完成」栏：
//         - 订阅 utils/kbHeight 管理器的键盘高度（该管理器多源并收 + 轮询兜底，
//           规避 wx.onKeyboardHeightChange 在 iOS/安卓两端的已知缺陷），
//           键盘弹起 → 栏显示在键盘顶边，键盘收起 → 自动隐藏；
//         - 点「完成」→ kbHeight.reset() + wx.hideKeyboard() 一键收起，并触发 done 事件。
//         - disabled 属性：页面已有自己的键盘工具栏（如正文编辑器的"话题/完成"栏）时
//           传 true，本栏不显示，避免叠两层。
// 【注意】position:fixed 依赖无 transform 祖先（Bug-A 同款坑），页面若在根节点加了
//         transform 需留意。z-index 高于页面吸底按钮条，低于弹窗遮罩。
// ============================================================
const kbHeight = require('../../utils/kbHeight.js');

Component({
  properties: {
    /** 页面已有自己的键盘工具栏时禁用本栏（如 addBooklet/editBooklet 正文聚焦时） */
    disabled: { type: Boolean, value: false },
    /** 按钮文案（默认「完成」） */
    text: { type: String, value: '完成' },
  },

  data: {
    kbH: 0,      // 键盘高度（px）：栏的 fixed bottom 定位用
    kbUp: false, // 键盘是否弹起（决定是否显示栏）
  },

  lifetimes: {
    attached() {
      // 订阅管理器：键盘弹起/收起/高度变化都从这里拿（管理器内部已完成 0 过滤、
      // 多源合并、轮询兜底与显式清零，组件不再自己读全局事件）
      this._unsubKb = kbHeight.subscribe((h, up) => {
        if (this.data.kbH !== h || this.data.kbUp !== up) {
          this.setData({ kbH: h, kbUp: up });
        }
      });
    },
    detached() {
      if (this._unsubKb) this._unsubKb();
      this._unsubKb = null;
    },
  },

  methods: {
    /** 点「完成」：显式清零键盘状态 + 收起键盘。用 bindtap（非 catchtap）让点击冒泡到
     *  页面根节点，页面若有 onPageTap（如 addBooklet）会顺带做布局还原（收建议/收聚焦/还原图片）。 */
    done() {
      kbHeight.reset();
      this.setData({ kbUp: false });
      if (wx.hideKeyboard) wx.hideKeyboard();
      this.triggerEvent('done');
    },
  },
});
