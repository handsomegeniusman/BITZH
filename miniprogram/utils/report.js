/**
 * utils/report.js —— 举报公共逻辑
 * ============================================================
 * 【作用】把「用户举报违规内容」统一收口：
 *   1. 写入 Report 集合（取证留存）
 *   2. 同用户对同目标 5 分钟内限举报 1 次（防刷举报骚扰管理员）
 *   3. 举报即下架：调 moderate 云函数（服务端按阈值软删，评论/推文都覆盖）
 *   4. 提交后复用 secCheck 云函数 notify 模式，把「被举报内容 + 下架结果」推飞书
 *
 * 【数据】Report 字段：targetType(推文/评论) / targetId / content(被举报内容快照) /
 *        reason(理由) / reporterId / targetAuthorId / status(pending) / time
 *
 * 【下架结果可见】推飞书的消息里会带上「已自动下架 / 未达阈值 / 下架失败」，
 *   避免云函数网络抖动失败时管理员误以为系统坏了而漏处理。
 */
const db = require('./db.js');
const guard = require('./guard.js');
const moderate = require('./moderate.js');

/** 调 moderate 下架，失败返回 {ok:false}（不抛，供上层判断） */
async function tryTakedown(targetType, targetId, reporterId) {
  try {
    return await moderate.takedown(targetType, targetId, reporterId);
  } catch (e) {
    console.error('[report] 自动下架失败', e && e.message);
    return { ok: false, msg: (e && e.message) || e };
  }
}

/**
 * 提交举报。
 * @param {Object} p { targetType:'page'|'comment', targetId, content, reason, targetAuthorId }
 * @returns {Promise<Object>} { ok:true } 或 { ok:false, reason:'empty'|'too_long'|'duplicate' }
 */
async function submitReport(p) {
  p = p || {};
  const reason = String(p.reason || '').trim();
  if (!reason) return { ok: false, reason: 'empty' };
  if (guard.tooLong(reason, 200)) return { ok: false, reason: 'too_long' };

  const userId = await db.getUserId();
  const targetId = String(p.targetId || '');
  const targetType = p.targetType === 'page' ? 'page' : 'comment';

  // 同一用户对同一目标 5 分钟内限举报 1 次（写库前校验，防刷举报）
  const recent = await db.find('Report', { reporterId: userId, targetId: targetId, targetType: targetType }, { limit: 20 });
  const now = Date.now();
  const dup = (recent || []).some(function (r) {
    const t = r.time ? new Date(r.time).getTime() : 0;
    return t && (now - t) < 5 * 60 * 1000;
  });
  if (dup) return { ok: false, reason: 'duplicate' };

  await db.insertOne('Report', {
    targetType: targetType,
    targetId: targetId,
    content: String(p.content || '').slice(0, 500),
    reason: reason,
    reporterId: userId,
    targetAuthorId: p.targetAuthorId || '',
    status: 'pending',
    time: new Date(),
  });

  // 举报即下架（服务端阈值判定）；网络抖动失败重试一次
  let td = await tryTakedown(targetType, targetId, userId);
  if (!td.ok) td = await tryTakedown(targetType, targetId, userId);

  // 通知管理员（复用 secCheck 云函数 notify 模式；失败不影响举报入库），附带下架结果 + 底部命令菜单
  try {
    const app = getApp();
    if (app && app.mpServerless && app.mpServerless.function) {
      const typeLabel = targetType === 'page' ? '推文' : '评论';
      const takenDown = !!(td.ok && td.takedown);
      const stateLine = takenDown ? '状态：已自动下架'
        : (td.ok ? '状态：未达阈值（暂未下架）' : '状态：⚠️ 自动下架失败，请人工在复核中心处理');
      // 帖子已自动下架 → 「封禁」只能是封用户；未下架 → 「封禁帖子」用于下架内容
      const menu = takenDown
        ? '封禁 = 封禁该帖子\n· 封禁用户 = 封禁该用户\n· 封禁举报人 = 封禁举报人（恶意举报）\n· 解封 = 解封该帖子（恢复）\n· 解封用户 = 解除黑名单\n· 全部解封 = 解除黑名单 + 恢复全部内容\n· 拉黑用户 = 永久拉黑该用户'
        : '封禁 = 封禁该帖子（下架）\n· 封禁用户 = 封禁该用户\n· 封禁举报人 = 封禁举报人（恶意举报）\n· 解封用户 = 解除黑名单\n· 全部解封 = 解除黑名单 + 恢复全部内容\n· 拉黑用户 = 永久拉黑该用户';
      const text = '【举报】' + typeLabel +
        '\n被举报内容：' + String(p.content || '').slice(0, 120) +
        '\n被举报人ID：' + (p.targetAuthorId || '') +
        '\n举报人ID：' + userId +
        '\n理由：' + reason +
        '\n目标ID：' + targetId +
        '\n' + stateLine +
        '\n——————' +
        '\n评论区回复：' +
        '\n· ' + menu;
      await app.mpServerless.function.invoke('secCheck', { action: 'notify', text: text });
    }
  } catch (e) {
    console.error('[report] 举报通知推送失败', e && e.message);
  }

  return { ok: true };
}

module.exports = {
  submitReport: submitReport,
};
