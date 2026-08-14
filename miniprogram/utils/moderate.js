/**
 * utils/moderate.js —— 内容安全执行器封装（封禁/解封/下架/恢复）
 * ============================================================
 * 【作用】统一走 moderate 云函数（服务端写库），前端不再直连数据库做这些关键操作。
 *         封禁/解封/下架/恢复的写库逻辑都在云函数里，前端只负责发起。
 *   调用方式：moderate.ban(userId, reason) 等，返回云函数的 { ok, ... } 结果。
 */
function invoke(action, params) {
  const app = getApp();
  if (!app || !app.mpServerless || !app.mpServerless.function) {
    return Promise.reject(new Error('云函数不可用'));
  }
  return app.mpServerless.function.invoke('moderate', Object.assign({ action: action }, params))
    .then(function (res) {
      // 云函数返回值包在 res.result 里，这里解包方便调用方直接用 { ok, ... }
      return (res && res.result !== undefined) ? res.result : res;
    });
}

module.exports = {
  /** 封禁用户：软删其全部推文/评论 + 拉黑（reason 写入 BlackNum 备查） */
  ban: function (userId, reason) {
    return invoke('ban', { userId: userId, reason: reason });
  },
  /** 解封用户：移出黑名单 + 恢复其内容可见 */
  unban: function (userId) {
    return invoke('unban', { userId: userId });
  },
  /** 举报即下架：≥阈值才软删（阈值在云函数里配置），reporterId 用于原子去重计数 */
  takedown: function (targetType, targetId, reporterId) {
    return invoke('takedown', { targetType: targetType, targetId: targetId, reporterId: reporterId });
  },
  /** 封禁帖子：管理员手动下架单条内容（无阈值，区别于举报 takedown） */
  hide: function (targetType, targetId) {
    return invoke('hide', { targetType: targetType, targetId: targetId });
  },
  /** 恢复单条内容（误报/误下架时恢复） */
  restore: function (targetType, targetId) {
    return invoke('restore', { targetType: targetType, targetId: targetId });
  },
};
