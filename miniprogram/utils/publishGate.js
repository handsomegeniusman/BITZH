/**
 * utils/publishGate.js —— 「这个人现在能不能发帖/评论」的**唯一**判断式（纯函数）
 * ============================================================
 * 【为什么单独抽一个文件】这条判断式今天决定 8 个入口的显隐（底部加号 ×2、addBooklet 页守卫、
 *   bookletDetail ×2、mydetail、someBooklet ×2）。抽出来的真正原因是**它没法靠人工测出来**：
 *   漏掉「被禁言」这一项时，管理员账号在自己的手机上**完全看不出问题**（管理员本来就能发），
 *   而漏掉的表现是"禁言了但对方还能发帖" —— 一个只会在别人手机上出现的 bug。
 *   做成纯函数之后 tests/publishGate.test.js 能把四种组合逐一钉死。
 * 【为什么不能放在 db.js 里】db.js 依赖 wx（getApp / 云函数），node 里 require 不了，
 *   那样就只能靠人工点。本仓已有同样的先例：utils/catForm.js 也是可 node require 的纯 util
 *   （tests/catForm.test.js 还专门盯着它别引入 config.js）。
 *
 * 【两个字段的分工，别混】
 *   canPost  = 「发布权**被批准过**」——由管理员审批写入（adminManage 的 applyDecision）。
 *              它回答的是"这个人有没有资格"，是**持续状态**。
 *   mutePost = 「**当下**被禁言」——由封禁/禁言动作写入（moderate 的 mute）。
 *              它回答的是"这个人现在被不许说话"，是**临时处置**。
 *   所以禁言**不能**用把它们合并成一个字段的做法实现：把 canPost 写成 false 之后，
 *   ① 分不清"从没申请过"和"被禁言了"；② 会毁掉 canPostTime / canPostBy 的审批审计；
 *   ③ 解禁时不知道该恢复成 true 还是 false。两个字段正交，各自保留自己的历史。
 */

/**
 * @param {Object} state 形如 { isAdministrator, canPost, mutePost }
 * @returns {Boolean} 能否发布/评论
 */
function canPublish(state) {
  const s = state || {};
  // 【顺序是有意的】先算"有没有资格"，再扣掉"当下是不是被禁言"。
  //   禁言放在最后、且不参与 isAdministrator 的短路 —— 即**管理员也会被禁言**。
  //   这是刻意选的：管理员滥权时也该能被另一位管理员处置。
  //   代价是管理员被禁言后只能由**另一位**管理员解除（自己进不去禁言面板也没有意义）。
  //
  // ⚠️ 谁要改这个顺序/加条件，先跑 tests/publishGate.test.js：
  //   "管理员 + 被禁言 → 仍然禁止"这条是它的存在意义。
  return !!(s.isAdministrator || s.canPost) && !s.mutePost;
}

module.exports = { canPublish: canPublish };
