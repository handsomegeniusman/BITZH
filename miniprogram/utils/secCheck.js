/**
 * utils/secCheck.js —— 内容安全审核前端封装
 * ============================================================
 * 【作用】把「调云函数 secCheck 做文本审核」封装成两个函数：
 *   1. secCheck(content, scene)      —— 单次检测，返回 suggest/category/hitKeywords 等
 *   2. guardBeforePublish(content)   —— 写库前统一拦截：risky 拦截+存证，review 存待复核，pass 放行
 *
 * 【scene 约定】1=资料/昵称  2=评论  3=推文
 * 【降级】云函数调用失败 → 降级放行（审核挂了不能让小程序停摆），只记日志。
 *         这与云函数侧「异常返回 pass」的双重降级一致。
 * 【证据】risky 时把违规原文写进 Review 集合（type='evidence'，软删式留存取证）；
 *         review 时写进 Review 集合（type='review'，待管理员复核）。
 */
const db = require('./db.js');

/**
 * 调用云函数 secCheck 做文本审核。
 * @param {String} content 待检测文本
 * @param {Number} scene 1=资料/昵称 2=评论 3=推文
 * @returns {Promise<Object>} { suggest, category, categoryLabel, hitKeywords, label, degrade }
 */
async function secCheck(content, scene) {
  const text = String(content || '').trim();
  if (!text) return { suggest: 'pass' };
  try {
    const app = getApp();
    if (!app || !app.mpServerless || !app.mpServerless.function) {
      console.warn('[secCheck] 云函数不可用，降级放行');
      return { suggest: 'pass', degrade: true };
    }
    const res = await app.mpServerless.function.invoke('secCheck', {
      content: text,
      scene: scene || 3,
      openid: (app.globalData && app.globalData.userId) || '',
      authorName: (app.globalData && app.globalData.userInfo && app.globalData.userInfo.nickName) || '',
    });
    // 云函数返回结构在 res.result 里（与 cosSts.js 一致）
    const r = (res && res.result) || {};
    return {
      suggest: r.suggest || 'pass',
      category: r.category || '',
      categoryLabel: r.categoryLabel || '',
      hitKeywords: r.hitKeywords || [],
      label: r.label,
      degrade: !!r.degrade,
    };
  } catch (e) {
    console.error('[secCheck] 审核调用失败，降级放行', e && e.message);
    return { suggest: 'pass', degrade: true };
  }
}

/**
 * 写库前统一拦截（带 loading 反馈，防 200-800ms 审核期间用户重复点击/以为卡死）。
 * @param {String} content 待检测文本（发帖传标题+正文+话题拼接；评论传评论内容）
 * @param {Number} scene 1=资料/昵称 2=评论 3=推文
 * @returns {Promise<Boolean>} true=放行（pass/review），false=已拦截（risky）
 */
async function guardBeforePublish(content, scene) {
  const app = getApp();
  wx.showLoading({ title: '安全检测中...', mask: true });
  let r;
  try {
    r = await secCheck(content, scene);
  } finally {
    wx.hideLoading();
  }

  const base = {
    content: String(content || '').slice(0, 2000),
    scene: scene || 3,
    category: r.category || '',
    categoryLabel: r.categoryLabel || '',
    hitKeywords: r.hitKeywords || [],
    authorId: (app.globalData && app.globalData.userId) || '',
    authorName: (app.globalData && app.globalData.userInfo && app.globalData.userInfo.nickName) || '',
    time: new Date(),
  };

  if (r.suggest === 'risky') {
    // 违规证据存档（软删式留存，供监管抽查取证 + 管理员复核）
    try {
      await db.insertOne('Review', Object.assign({ type: 'evidence', status: 'handled' }, base));
    } catch (e) {
      console.error('[secCheck] 违规证据存档失败', e);
    }
    wx.showModal({
      title: '内容未通过审核',
      content: '你发布的内容涉嫌违规，已被拦截。如有疑问请联系管理员申诉。',
      showCancel: false,
      confirmText: '知道了',
    });
    return false;
  }

  if (r.suggest === 'review') {
    // 疑似内容：放行，但写入「待复核」清单，管理员可事后下架
    try {
      await db.insertOne('Review', Object.assign({ type: 'review', status: 'pending' }, base));
    } catch (e) {
      console.error('[secCheck] 待复核存档失败', e);
    }
  }
  return true;
}

module.exports = {
  secCheck: secCheck,
  guardBeforePublish: guardBeforePublish,
};
