// ============================================================
// components/privacy-popup/privacy-popup.js —— 隐私授权弹窗（合规）
// 【作用】微信「用户隐私保护指引」授权拦截：点「从聊天记录选图」前先查
//        wx.getPrivacySetting，若 needAuthorization 为 true 弹出本弹窗，
//        内含 open-type="agreePrivacyAuthorization" 按钮（微信原生授权），
//        用户点「同意并继续」后关闭弹窗并无缝继续选图；已授权/无需授权直接放行。
// 【用法】页面里 <privacy-popup id="privacyPopup" desc="需要你的授权，才能……是否同意？" />
//        const p = this.selectComponent('#privacyPopup');
//        p.checkAndRun().then(() => 继续操作);
// ============================================================
Component({
  properties: {
    desc: {
      type: String,
      value: '需要你的授权，才能继续使用该功能。是否同意？', // 各页面可传具体用途文案
    },
  },

  data: {
    show: false, // 是否显示授权弹窗
  },

  methods: {
    noop() {},

    /**
     * 隐私授权检查并（在用户同意后）继续。
     * @returns {Promise<void>}
     *   resolve() → 已授权 / 无需授权 / 检查接口不可用 → 调用方继续选图；
     *   用户点「暂不使用」→ 不 resolve，选图流程不继续（不打扰）。
     */
    checkAndRun() {
      return new Promise((resolve) => {
        // 低基础库无 getPrivacySetting → 直接放行（后续失败由 onChatFail 兜底）
        if (typeof wx.getPrivacySetting !== 'function') {
          resolve();
          return;
        }
        wx.getPrivacySetting({
          success: (res) => {
            if (!res || !res.needAuthorization) {
              resolve(); // 已授权 / 无需授权 → 直接选图
              return;
            }
            this._resolve = resolve; // 暂存，用户点「同意并继续」时再放行
            this.setData({ show: true });
          },
          fail: () => {
            resolve(); // 检查失败不阻塞：先选图，失败交给 onChatFail 兜底
          },
        });
      });
    },

    /** 用户点「同意并继续」（open-type=agreePrivacyAuthorization 原生按钮触发）→ 关闭弹窗并放行 */
    onAgree() {
      const r = this._resolve;
      this._resolve = null;
      this.setData({ show: false });
      if (r) r();
    },

    /** 用户点「暂不使用」→ 关闭弹窗，不放行（选图流程终止） */
    onCancel() {
      this._resolve = null;
      this.setData({ show: false });
    },
  },
});
