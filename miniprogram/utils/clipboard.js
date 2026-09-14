// ============================================================
// utils/clipboard.js —— 复制到剪贴板（统一的成功/失败反馈 + 隐私授权兜底）
// 【作用】`wx.setClipboardData` 是隐私接口，且真机上失败时可能完全静默；
//        本模块统一处理，调用方只管把「要复制的文本」丢进来：
//          直接复制 → 成功弹「已复制」；
//          失败若因隐私未授权（errno 112 / errMsg 含 privacy）→ 拉起微信官方隐私弹窗，
//            用户同意后**只重试一次**（retried 标志防死循环）；
//          其它失败（如 scope.clipboard 被关）→ 交给调用方的 onFail 做页面级引导，
//            没传 onFail 就弹默认失败提示。
// 【注意】**不要**再用 privacy.guard / 自定义 privacy-popup 包剪贴板：
//        那条路在真机上会静默挂起（Promise 不 resolve），表现是「点了完全没反应」。
// 【用法】const clipboard = require('../../utils/clipboard.js');
//        clipboard.copy(text, '邮箱');                    // 基础用法
//        clipboard.copy(text, '邮箱', (err) => {...});     // 自定义失败引导
// ============================================================
function copy(text, label, onFail, retried) {
  const data = String(text === undefined || text === null ? '' : text);
  if (!data.trim()) {
    wx.showToast({ icon: 'none', title: '没有可复制的内容' });
    return;
  }
  wx.setClipboardData({
    data: data,
    success: () => {
      console.log('[clipboard] 复制成功', label || '');
      // 真机上系统自带的「已复制」提示不一定显示，这里主动弹一次，保证用户有反馈
      wx.showToast({ icon: 'success', title: '已复制', duration: 1200 });
    },
    fail: (err) => {
      console.warn('[clipboard] 复制失败', label || '', err);
      // 隐私未授权：拉起官方隐私弹窗（不要用自定义弹窗，见文件头说明），同意后重试一次
      const needPrivacy = err && (err.errno === 112 || /privacy/i.test(err.errMsg || ''));
      if (!retried && needPrivacy && typeof wx.requirePrivacyAuthorize === 'function') {
        wx.requirePrivacyAuthorize({
          success: () => copy(text, label, onFail, true),
          fail: () => wx.showToast({ icon: 'none', title: '未授权，复制失败' }),
        });
        return;
      }
      if (typeof onFail === 'function') {
        onFail(err);
      } else {
        wx.showToast({ icon: 'none', title: '复制失败，请长按选择' });
      }
    },
  });
}

module.exports = {
  copy: copy,
};
