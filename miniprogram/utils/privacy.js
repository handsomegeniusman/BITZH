// ============================================================
// utils/privacy.js —— 隐私授权通用拦截（合规）
// 【作用】微信「用户隐私保护指引」的统一授权入口：页面里放了
//        <privacy-popup id="privacyPopup"> 的前提下，调用 guard(page, fn)：
//          未授权 → 弹合规授权弹窗（open-type="agreePrivacyAuthorization"），
//                   用户点「同意并继续」后执行 fn；点「暂不使用」则不执行；
//          已授权 / 无 getPrivacySetting 接口 / 页面没放弹窗 → 直接执行 fn。
// 【用法】const privacy = require('../../utils/privacy.js');
//        privacy.guard(this, () => wx.setClipboardData({...}));
// ============================================================
function guard(page, fn) {
  const popup = page.selectComponent && page.selectComponent('#privacyPopup');
  if (popup && typeof popup.checkAndRun === 'function') {
    popup.checkAndRun().then(fn); // 同意/已授权 → 继续；「暂不使用」→ 不继续
  } else if (typeof fn === 'function') {
    fn();
  }
}

module.exports = {
  guard: guard,
};
