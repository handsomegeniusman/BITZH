/**
 * tests/feishuCommands.test.js —— 飞书评论区命令解析本地测试
 * ============================================================
 * 不依赖飞书/微信网络，只测 feishuCallback 里导出的纯解析逻辑：
 *   parseCommand（评论文字 → 命令）
 *   resolveAction（命令 × 推送场景 → moderate 云函数入参）
 *   detectContext / extractTarget / extractOpenid
 *   以及 HTTP 入口对飞书「URL 验证」的应答
 *
 * 运行：node tests/feishuCommands.test.js   （Node 自带，无第三方依赖）
 */
'use strict';
const assert = require('assert');
const path = require('path');
const cb = require(path.resolve(__dirname, '..', 'cloudfunctions', 'feishuCallback', 'index.js'));

// —— 入口必须是函数（EMAS 云函数约定），且附带了纯解析函数 ——
assert.strictEqual(typeof cb, 'function', 'module.exports 应为云函数入口');
['parseCommand', 'resolveAction', 'detectContext', 'extractTarget', 'extractOpenid', 'extractReporterId', 'extractApplicantId', 'extractExemptUserId'].forEach(function (fn) {
  assert.strictEqual(typeof cb[fn], 'function', '应导出 ' + fn);
});

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + '\n    期望: ' + e + '\n    实际: ' + a); }
}

(async function main() {

  // ============================================================
  // 场景一：举报推送（用户给的样例，已自动下架）
  // ============================================================
  const reportText = '【举报】推文\n' +
    '被举报内容：11 \n' +
    '被举报人ID：6475a94bf43e605f713f2ce1\n' +
    '举报人ID：aabbccddeeff001122334455\n' +
    '理由：赌博/诱导\n' +
    '目标ID：6a86b6e7eef9cb0f2d49102f\n' +
    '状态：已自动下架\n' +
    '——————\n' +
    '评论区回复：\n' +
    '· 封禁 = 封禁该帖子\n' +
    '· 封禁用户 = 封禁该用户\n' +
    '· 解封 = 解封该帖子（恢复）\n' +
    '· 解封用户 = 解封该用户\n' +
    '· 拉黑用户 = 永久拉黑该用户';

  console.log('[举报场景] context =', cb.detectContext(reportText));

  const reportCases = [
    // 评论命令 | 期望 parseCommand | 期望 resolveAction（moderate 入参）
    ['封禁',
      { verb: 'ban', object: null },
      { action: 'hide', targetType: 'page', targetId: '6a86b6e7eef9cb0f2d49102f' }],
    ['封禁帖子',
      { verb: 'ban', object: 'post' },
      { action: 'hide', targetType: 'page', targetId: '6a86b6e7eef9cb0f2d49102f' }],
    ['封禁用户',
      { verb: 'ban', object: 'user' },
      { action: 'ban', userId: '6475a94bf43e605f713f2ce1' }],
    ['解封',
      { verb: 'unban', object: null },
      { action: 'restore', targetType: 'page', targetId: '6a86b6e7eef9cb0f2d49102f' }],
    ['解封帖子',
      { verb: 'unban', object: 'post' },
      { action: 'restore', targetType: 'page', targetId: '6a86b6e7eef9cb0f2d49102f' }],
    ['解封用户',
      { verb: 'unban', object: 'user' },
      { action: 'unblacklist', userId: '6475a94bf43e605f713f2ce1' }],
    ['全部解封',
      { verb: 'unban', object: 'all' },
      { action: 'unban', userId: '6475a94bf43e605f713f2ce1' }],
    ['拉黑用户',
      { verb: 'reject', object: 'user' },
      { action: 'reject', userId: '6475a94bf43e605f713f2ce1', reason: '永久拉黑' }],
    ['封禁举报人',
      { verb: 'ban', object: 'reporter' },
      { action: 'ban', userId: 'aabbccddeeff001122334455', reason: '举报人滥用举报被封禁' }],
    ['解封举报人',
      { verb: 'unban', object: 'reporter' },
      { action: 'unblacklist', userId: 'aabbccddeeff001122334455' }],
    // 本空间用户 ID 是 24 位 hex（非 openid），带 ID 命令必须能解析
    ['封禁 64fa07d6a09a9bd68b13a8a0',
      { verb: 'ban', object: 'user', userId: '64fa07d6a09a9bd68b13a8a0' },
      { action: 'ban', userId: '64fa07d6a09a9bd68b13a8a0' }],
    ['解封 64fa07d6a09a9bd68b13a8a0',
      { verb: 'unban', object: 'user', userId: '64fa07d6a09a9bd68b13a8a0' },
      { action: 'unblacklist', userId: '64fa07d6a09a9bd68b13a8a0' }],
    ['拉黑用户 64fa07d6a09a9bd68b13a8a0',
      { verb: 'reject', object: 'user', userId: '64fa07d6a09a9bd68b13a8a0' },
      { action: 'reject', userId: '64fa07d6a09a9bd68b13a8a0', reason: '永久拉黑' }],
    // 私聊旧用法：封禁 <openid> / 解封 <openid> / 拉黑用户 <openid>
    ['封禁 oAbCdEfGhIjKlMnOpQrS1',
      { verb: 'ban', object: 'user', userId: 'oAbCdEfGhIjKlMnOpQrS1' },
      { action: 'ban', userId: 'oAbCdEfGhIjKlMnOpQrS1' }],
    ['解封 oAbCdEfGhIjKlMnOpQrS1',
      { verb: 'unban', object: 'user', userId: 'oAbCdEfGhIjKlMnOpQrS1' },
      { action: 'unblacklist', userId: 'oAbCdEfGhIjKlMnOpQrS1' }],
    ['全部解封 oAbCdEfGhIjKlMnOpQrS1',
      { verb: 'unban', object: 'all', userId: 'oAbCdEfGhIjKlMnOpQrS1' },
      { action: 'unban', userId: 'oAbCdEfGhIjKlMnOpQrS1' }],
    ['拉黑用户 oAbCdEfGhIjKlMnOpQrS1',
      { verb: 'reject', object: 'user', userId: 'oAbCdEfGhIjKlMnOpQrS1' },
      { action: 'reject', userId: 'oAbCdEfGhIjKlMnOpQrS1', reason: '永久拉黑' }],
    // 禁言 / 解除禁言（2026-09-16）：比拉黑轻一档 —— 只停发帖评论，**保留既有内容**、不进黑名单。
    // 🔴 期望的 action 是 'mute'/'unmute' 而**不是** 'ban'：写成 ban 会在群里打「禁言用户」时
    //    顺手把对方的历史推文/评论全部软删 —— 症状是静默的，行为看起来还"成功"了。
    ['禁言用户',
      { verb: 'mute', object: 'user' },
      { action: 'mute', userId: '6475a94bf43e605f713f2ce1', reason: '飞书指令' }],
    ['解除禁言',
      { verb: 'unmute', object: 'user' },
      { action: 'unmute', userId: '6475a94bf43e605f713f2ce1', reason: '飞书指令' }],
    ['禁言用户 64fa07d6a09a9bd68b13a8a0',
      { verb: 'mute', object: 'user', userId: '64fa07d6a09a9bd68b13a8a0' },
      { action: 'mute', userId: '64fa07d6a09a9bd68b13a8a0', reason: '飞书指令' }],
    ['解除禁言 oAbCdEfGhIjKlMnOpQrS1',
      { verb: 'unmute', object: 'user', userId: 'oAbCdEfGhIjKlMnOpQrS1' },
      { action: 'unmute', userId: 'oAbCdEfGhIjKlMnOpQrS1', reason: '飞书指令' }],
  ];
  reportCases.forEach(function (c) {
    const cmd = c[0];
    const parsed = cb.parseCommand(cmd);
    check('parseCommand(' + cmd + ')', parsed, c[1]);
    check('resolveAction(' + cmd + ')', cb.resolveAction(parsed, 'report', reportText), c[2]);
  });

  // 「封禁举报人」专用解析：取「举报人ID」行，与「被举报人ID」相互独立（两者不同才能验证）
  check('extractReporterId(举报推送) → 举报人ID', cb.extractReporterId(reportText), 'aabbccddeeff001122334455');
  check('extractReporterId(无举报人行) → 空', cb.extractReporterId('【内容违规】xxx\n用户ID：oAbCdEfGhIjKlMnOpQrS1\n'), '');

  // 未识别命令 → null（机器人会回复「未识别」提示）
  check('parseCommand(随机文字) → null', cb.parseCommand('这是乱写的评论'), null);
  check('parseCommand(空串) → null', cb.parseCommand(''), null);

  // ============================================================
  // 场景二：申诉推送
  // ============================================================
  const appealText = '【申诉】用户申请解封\n' +
    '用户ID：oAbCdEfGhIjKlMnOpQrS1\n' +
    '联系方式：xxx\n' +
    '说明：误封\n' +
    '——————\n' +
    '评论区回复：\n' +
    '· 解封用户 = 允许解封（恢复该用户）\n' +
    '· 拉黑用户 = 永久拉黑（不再受理）';
  console.log('\n[申诉场景] context =', cb.detectContext(appealText));

  check('申诉: 解封用户 → 只解除黑名单', cb.resolveAction(cb.parseCommand('解封用户'), 'appeal', appealText),
    { action: 'unblacklist', userId: 'oAbCdEfGhIjKlMnOpQrS1' });
  check('申诉: 全部解封 → 解除黑名单+恢复全部', cb.resolveAction(cb.parseCommand('全部解封'), 'appeal', appealText),
    { action: 'unban', userId: 'oAbCdEfGhIjKlMnOpQrS1' });
  check('申诉: 裸解封 → 拒绝并提示',
    cb.resolveAction(cb.parseCommand('解封'), 'appeal', appealText),
    { error: '❌ 该帖子已被删除，解封失败（申诉请回复「解封用户」或「全部解封」）' });
  check('申诉: 拉黑用户', cb.resolveAction(cb.parseCommand('拉黑用户'), 'appeal', appealText),
    { action: 'reject', userId: 'oAbCdEfGhIjKlMnOpQrS1', reason: '永久拉黑' });
  check('申诉: 裸封禁（该帖已封）',
    cb.resolveAction(cb.parseCommand('封禁'), 'appeal', appealText),
    { error: '❌ 该帖子已被封禁' });
  check('申诉: 封禁用户 → 直接封禁（不再拒绝）',
    cb.resolveAction(cb.parseCommand('封禁用户'), 'appeal', appealText),
    { action: 'ban', userId: 'oAbCdEfGhIjKlMnOpQrS1' });
  check('申诉: 封禁举报人 → 无举报人信息报错',
    cb.resolveAction(cb.parseCommand('封禁举报人'), 'appeal', appealText),
    { error: '❌ 未能解析出举报人ID（仅举报推送可回复「封禁举报人」）' });
  check('申诉: 解封举报人 → 无举报人信息报错',
    cb.resolveAction(cb.parseCommand('解封举报人'), 'appeal', appealText),
    { error: '❌ 未能解析出举报人ID（仅举报推送可回复「解封举报人」）' });

  // ============================================================
  // 场景三：URL 验证（飞书保存「事件订阅请求地址」时先发这个）
  // ============================================================
  console.log('\n[URL 验证]');
  const res1 = await cb({ args: { body: JSON.stringify({
    challenge: 'challenge_abcdefg',
    token: 'verification_token_xxx',
    type: 'url_verification',
  }) } });
  check('url_verification → 原样返回 challenge', res1, { challenge: 'challenge_abcdefg' });

  // schema 2.0 事件里混入 url_verification 的兼容性（Feishu v2 也走 header）
  const res2 = await cb({ args: { body: JSON.stringify({
    challenge: 'ch2',
    token: 'verification_token_xxx',
    type: 'url_verification',
  }) } });
  check('url_verification（重复） → 仍返回 challenge', res2, { challenge: 'ch2' });

  // 非 JSON body → 拒绝
  const res3 = await cb({ args: { body: 'not json' } });
  check('非 JSON body → code 1', res3, { code: 1 });

  // ============================================================
  // 场景四：内容审核推送（无目标ID，只有用户ID）
  // ============================================================
  const reviewText = '【内容违规(本地词库)】赌博\n' +
    '内容：xxx\n' +
    '用户ID：oAbCdEfGhIjKlMnOpQrS1\n' +
    '命中词：xx\n' +
    '状态：内容已拦截（未发布）\n' +
    '——————\n' +
    '评论区回复：\n' +
    '· 封禁用户 = 封禁该用户\n' +
    '· 解封用户 = 解封该用户\n' +
    '· 拉黑用户 = 永久拉黑该用户';
  console.log('\n[审核场景] context =', cb.detectContext(reviewText));

  check('审核: 封禁用户', cb.resolveAction(cb.parseCommand('封禁用户'), 'review', reviewText),
    { action: 'ban', userId: 'oAbCdEfGhIjKlMnOpQrS1' });
  check('审核: 裸封禁（无目标ID → 提示已删除）',
    cb.resolveAction(cb.parseCommand('封禁'), 'review', reviewText),
    { error: '❌ 该帖子已被删除' });

  // ============================================================
  // 场景五：发布申请推送（同意 / 拒绝）
  // ============================================================
  // 与 postApply 云函数 buildCard 的输出逐字一致（改格式要两边一起改）
  const applyText = '【发布申请】\n' +
    '有用户申请发布权限，回复「同意」或「拒绝」。\n' +
    '\n' +
    '申请人ID：64fa07d6a09a9bd68b13a8a2\n' +
    '昵称：小明\n' +
    '申请时间：2026-09-16 09:00';
  console.log('\n[发布申请场景] context =', cb.detectContext(applyText));

  check('detectContext(发布申请) → apply', cb.detectContext(applyText), 'apply');
  check('extractApplicantId → 申请人ID', cb.extractApplicantId(applyText), '64fa07d6a09a9bd68b13a8a2');
  check('parseCommand(同意)', cb.parseCommand('同意'), { verb: 'grantPost', object: 'user' });
  check('parseCommand(拒绝)', cb.parseCommand('拒绝'), { verb: 'denyPost', object: 'user' });

  check('apply: 同意 → applyDecision(approve)',
    cb.resolveAction(cb.parseCommand('同意'), 'apply', applyText),
    { action: 'applyDecision', decision: 'approve', userId: '64fa07d6a09a9bd68b13a8a2' });
  check('apply: 拒绝 → applyDecision(reject)',
    cb.resolveAction(cb.parseCommand('拒绝'), 'apply', applyText),
    { action: 'applyDecision', decision: 'reject', userId: '64fa07d6a09a9bd68b13a8a2' });

  // 逃生口：卡片是 webhook 发的（回读不到父消息）时只能手打 ID
  const noIdText = '【发布申请】\n有用户申请发布权限。';
  check('parseCommand(同意 <ID>) 带 ID',
    cb.parseCommand('同意 64fa07d6a09a9bd68b13a8a2'),
    { verb: 'grantPost', object: 'user', userId: '64fa07d6a09a9bd68b13a8a2' });
  check('apply: 读不到父消息时手打 ID 仍能批',
    cb.resolveAction(cb.parseCommand('同意 64fa07d6a09a9bd68b13a8a2'), 'apply', noIdText),
    { action: 'applyDecision', decision: 'approve', userId: '64fa07d6a09a9bd68b13a8a2' });
  check('apply: 既没有 ID 也读不到父消息 → 明确报错',
    cb.resolveAction(cb.parseCommand('同意'), 'apply', noIdText),
    { error: '❌ 未能解析出申请人ID（可回复「同意 <申请人ID>」）' });

  // —— 安全负例：本方案最需要看懂的一处 ——
  // 「同意」「拒绝」是两个极短极泛的词，群里聊别的事打「同意」完全正常。
  // 场景守卫是唯一防止误批的东西：不限定 context 的话，在举报推送下打「同意」
  // 会去解析**被举报人**的 ID 并给他开发布权 —— 给一个刚被举报的人开权限。
  console.log('\n[发布申请 · 安全负例]');
  // 先证明这个陷阱是真的存在：extractOpenid 在举报推送里解析出的正是「被举报人ID」
  check('（陷阱验证）extractOpenid(举报推送) 取到的是被举报人ID',
    cb.extractOpenid(reportText), '6475a94bf43e605f713f2ce1');
  check('extractApplicantId(举报推送) → 绝不误取被举报人', cb.extractApplicantId(reportText), '');

  ['report', 'review', 'appeal'].forEach(function (ctx) {
    const text = ctx === 'report' ? reportText : (ctx === 'appeal' ? appealText : reviewText);
    const r = cb.resolveAction(cb.parseCommand('同意'), ctx, text);
    check('「同意」在【' + ctx + '】场景下被拒（并说明只能用于发布申请）',
      r.error, '❌ 「同意」/「拒绝」只能在【发布申请】推送下回复（当前是【' + ctx + '】场景）');
    check('  ↑ 且没有解析出任何 userId 去动权限', r.action, undefined);
    // 带 ID 的形式同样受场景守卫约束 —— 否则就成了绕过守卫的后门
    check('  「同意 <ID>」在【' + ctx + '】场景下同样被拒',
      cb.resolveAction(cb.parseCommand('同意 64fa07d6a09a9bd68b13a8a2'), ctx, text).error,
      '❌ 「同意」/「拒绝」只能在【发布申请】推送下回复（当前是【' + ctx + '】场景）');
  });

  // 举报正文里出现「【发布申请】」字样，不得把场景判成 apply（只看第一行）
  const reportWithApplyWord = reportText + '\n【发布申请】这是正文里的一句闲聊';
  check('正文含【发布申请】的举报推送，场景仍是 report',
    cb.detectContext(reportWithApplyWord), 'report');
  check('  ↑ 该场景下「同意」依旧被拒',
    cb.resolveAction(cb.parseCommand('同意'), cb.detectContext(reportWithApplyWord), reportWithApplyWord).error,
    '❌ 「同意」/「拒绝」只能在【发布申请】推送下回复（当前是【report】场景）');

  // 行首锚定：申请人ID 不在行首时不予识别
  check('「申请人ID」不在行首 → 不识别（锚定生效）',
    cb.extractApplicantId('说明：申请人ID：64fa07d6a09a9bd68b13a8a2'), '');

  // —— 回归：新命令不得挤掉任何旧命令 ——
  // 上面对照表已逐条跑过 reportCases，这里再钉一次"新旧不是同一个 verb"
  console.log('\n[回归]');
  check('「同意」与「拉黑用户」不是同一个 verb（否则拒绝会变成拉黑）',
    [cb.parseCommand('同意').verb, cb.parseCommand('拉黑用户').verb], ['grantPost', 'reject']);
  check('裸「封禁」未被新命令挤掉', cb.parseCommand('封禁'), { verb: 'ban', object: null });
  check('裸「解封」未被新命令挤掉', cb.parseCommand('解封'), { verb: 'unban', object: null });
  check('「全部解封」未被新命令挤掉', cb.parseCommand('全部解封'), { verb: 'unban', object: 'all' });

  // ============================================================
  // 禁言 / 解除禁言（2026-09-16）
  // ============================================================
  console.log('\n[禁言命令]');

  // 解析层：不撞任何既有命令（撞了会让「封禁用户」变成轻处置、或反之）
  check('「禁言用户」不撞「封禁用户」/「拉黑用户」',
    [cb.parseCommand('禁言用户').verb, cb.parseCommand('封禁用户').verb, cb.parseCommand('拉黑用户').verb],
    ['mute', 'ban', 'reject']);
  check('「解除禁言」不撞「解封用户」/「全部解封」',
    [cb.parseCommand('解除禁言').verb, cb.parseCommand('解封用户').verb, cb.parseCommand('全部解封').verb],
    ['unmute', 'unban', 'unban']);
  // 带 ID 形式与裸命令必须是同一个 verb，否则同一条命令在"有 ID"和"没 ID"时行为不同
  check('带 ID 与裸命令同 verb',
    [cb.parseCommand('禁言用户 64fa07d6a09a9bd68b13a8a0').verb, cb.parseCommand('解除禁言 64fa07d6a09a9bd68b13a8a0').verb],
    ['mute', 'unmute']);
  // 用户的 ID 形态不止 24 位 hex（还有 openid），短 ID 一律不认 —— 防止把「禁言用户了」当命令
  check('「禁言用户了」不被当命令（ID 形态校验生效）', cb.parseCommand('禁言用户了'), null);

  // 推送里没有用户 ID 时，必须给带 ID 写法的提示，而不是静默失败
  const noUserText = '【内容违规】推文\n内容：xx\n——————\n评论区回复：\n· 封禁 = 封禁该帖子';
  check('无用户ID的推送下「禁言用户」→ 提示带 ID 的写法',
    cb.resolveAction(cb.parseCommand('禁言用户'), 'review', noUserText),
    { error: '❌ 未能解析出用户ID（可回复「禁言用户 <用户ID>」）' });
  check('无用户ID的推送下「解除禁言」→ 提示带 ID 的写法',
    cb.resolveAction(cb.parseCommand('解除禁言'), 'review', noUserText),
    { error: '❌ 未能解析出用户ID（可回复「解除禁言 <用户ID>」）' });

  // 🔴 跨文件契约：入口函数里 `if (cmd.userId)` 那条分支会把 cmd.verb **原样当 action**
  //    丢给 moderate 云函数。所以两边的名字必须逐字一致 —— 名字漂开的表现是
  //    群里回「禁言用户 <ID>」得到「未知 action: mute」，而且本地测不出（解析层是对的）。
  //    这里直接把 verb 当 action 调一次真实的 moderate 来钉住它。
  const mod = require(path.resolve(__dirname, '..', 'cloudfunctions', 'moderate', 'index.js'));
  function miniDb() {
    return { collection: function () {
      return {
        find: async function () { return { result: [] }; },
        updateMany: async function () { return { modifiedCount: 1 }; },
        updateOne: async function () { return {}; },
        insertOne: async function () { return {}; },
        deleteOne: async function () { return {}; },
      };
    } };
  }
  const onlyWrites = [];
  const watchDb = { collection: function (name) {
    return {
      find: async function () { return { result: [] }; },
      updateMany: async function (f, u) { onlyWrites.push({ name: name, update: u }); return { modifiedCount: 1 }; },
      updateOne: async function () { return {}; },
      insertOne: async function () { return {}; },
      deleteOne: async function () { return {}; },
    };
  } };

  const rMute = await mod({ args: { action: cb.parseCommand('禁言用户').verb, userId: 'u1' }, mpserverless: { db: miniDb() } });
  check('verb 当 action 直接调 moderate → 能执行（名称逐字一致）',
    { ok: rMute.ok, action: rMute.action }, { ok: true, action: 'mute' });
  const rUnmute = await mod({ args: { action: cb.parseCommand('解除禁言').verb, userId: 'u1' }, mpserverless: { db: miniDb() } });
  check('unmute 同理', { ok: rUnmute.ok, action: rUnmute.action }, { ok: true, action: 'unmute' });

  // 走一遍完整的「群里回禁言用户 <ID>」路径：解析 → 当 action → moderate。
  // 断言的是**只有 Feeder 被写** —— 这是"禁言不动内容"在命令链路上的最后一道保障。
  const parsedMute = cb.parseCommand('禁言用户 64fa07d6a09a9bd68b13a8a0');
  await mod({ args: { action: parsedMute.verb, userId: parsedMute.userId }, mpserverless: { db: watchDb } });
  check('群命令路径只写 Feeder（不软删对方内容）',
    [onlyWrites.length, onlyWrites[0] && onlyWrites[0].name, onlyWrites[0] && onlyWrites[0].update.$set.mutePost],
    [1, 'Feeder', true]);

  // ============================================================
  // 撤销「审核模式豁免」（2026-09-17；同日的「恢复豁免」已按需求方口径删除）
  // ============================================================
  console.log('\n[撤销豁免 命令]');
  {
    check('「撤销豁免」不被任何既有命令抢走',
      [cb.parseCommand('撤销豁免').verb, cb.parseCommand('撤销豁免').object],
      ['revokeEnable', 'user']);
    check('带 ID 的写法能解析出 ID',
      [cb.parseCommand('撤销豁免 64fa07d6a09a9bd68b13a8a0').verb,
        cb.parseCommand('撤销豁免 64fa07d6a09a9bd68b13a8a0').userId],
      ['revokeEnable', '64fa07d6a09a9bd68b13a8a0']);
    check('openid 形态也认',
      cb.parseCommand('撤销豁免 oAbCdEfGhIjKlMnOpQrS1').userId, 'oAbCdEfGhIjKlMnOpQrS1');
    // 【与「禁言用户了」同一类保护】不校验 ID 形态的话，「撤销豁免了」会被当成裸命令，
    //   而在【自助开通】卡片下它就会真的撤销——用户只是打了句话，不是下命令。
    check('「撤销豁免了」不被当命令', cb.parseCommand('撤销豁免了'), null);
    // 【命名纪律】「权限」在本项目指发布权（canPost），这条命令**不碰** canPost。
    //   叫「撤销权限」会让管理员以为能收回发帖权 —— 那是个会让人做错决定的歧义。
    check('命令词里刻意不含「权限 / 封禁 / 解封」',
      ['撤销权限', '封禁豁免', '解封豁免'].map(function (s) { return cb.parseCommand(s); }),
      [null, null, null]);
    // 走的是 adminManage，不是 moderate —— 所以 verb 名必须与 adminManage 的 action 名逐字一致
    check('verb 名与 adminManage 的 action 名逐字一致（走的是那条线，不是 moderate）',
      cb.parseCommand('撤销豁免').verb, 'revokeEnable');
    // 【被删掉的命令必须真的解析不出来】删除两半里最容易漏的是"入口函数的分流"：
    //   parseCommand 不再认识它，自然也就到不了那条分支 —— 所以这里断言 null 就够，
    //   真正防的是"将来有人把「恢复豁免」当成一条新命令又加回来"。
    //   （adminManage 那边还有一个同名反例，钉的是"云函数不认这个 action"。）
    check('  ⚠️ 「恢复豁免」已不是命令（裸的 / 带 ID 的都不认）',
      [cb.parseCommand('恢复豁免'), cb.parseCommand('恢复豁免 64fa07d6a09a9bd68b13a8a0')],
      [null, null]);
  }

  console.log('\n[撤销豁免：只能认【自助开通】卡片 —— 撤错人不报错，所以必须收窄]');
  {
    // 【为什么这条是本组最要紧的】撤销是**粘性状态**：撤了要管理员再解一次，
    //   而撤错人**不会报错、当场也看不出来**（对方只是忽然在审核模式下看不见内容了）。
    //   而带「用户ID：」行的卡片不止【自助开通】一张 —— secCheck 的推送也有。
    const selfEnableText = '【自助开通】审核模式豁免\n' +
      '有同学在小程序「关于」页连点 logo 五次，自助开通了豁免。\n' +
      '（无需回复本卡；要收回豁免就在本卡下回复「撤销豁免」。撤错了让对方重新申请即可 —— 审批通过会解锁）\n' +
      '\n' +
      '用户ID：64fa07d6a09a9bd68b13a8a0\n' +
      '昵称：小明\n' +
      '时间：2026-09-17 21:00';
    const uid = '64fa07d6a09a9bd68b13a8a0';

    check('场景自成一类（不再落进默认档 review）', cb.detectContext(selfEnableText), 'selfenable');
    check('extractExemptUserId 取到「用户ID：」那行', cb.extractExemptUserId(selfEnableText), uid);

    // 【上面这类断言对「行首锚定」是没有牙齿的 —— 这条是被变异测试逼出来的】
    //   把 extractExemptUserId 整个换成宽口径的 extractOpenid，上面所有断言**一条都不红**。
    //   原因有二：本卡里「用户ID：」既是行首、又是全文唯一一处，两个口径结果重合；
    //   而下面那两条负例（【待复核】/ 举报推送）**根本走不到这个解析器** ——
    //   它们是被 resolveAction 里的场景守卫先拦掉的，与解析器宽窄无关。
    //   所以锚定真正防的是**格式漂移**：这张卡将来只要多一行引用（把「昵称」挪到 ID 行之前、
    //   或加一行「引用：…用户ID：xxx」），宽口径就会取到**正文里被引用的那一个**，
    //   而撤销是粘性的、撤错人当场看不出来 —— 正是本组开头的失效模式。
    //   ⚠️ 下面第二条断言把 extractOpenid 当**反例**来写，是刻意的：它让"两个口径不同"这件事
    //   变成一条会红的断言，而不是注释里的一个说法。
    const spoofed = '【自助开通】审核模式豁免\n' +
      '昵称：他自称「用户ID：ou_fake000000000000」\n' +
      '用户ID：' + uid + '\n' +
      '时间：2026-09-17 21:00';
    check('  ⚠️ 行首锚定：正文里被引用的「用户ID：」必须跳过，取行首那一个',
      cb.extractExemptUserId(spoofed), uid);
    check('     （同一条文本喂给宽口径 extractOpenid 就会取错人 —— 这就是不能复用它做撤销的原因）',
      cb.extractOpenid(spoofed) === uid, false);
    check('解析成 revokeEnable',
      cb.resolveAction(cb.parseCommand('撤销豁免'), 'selfenable', selfEnableText),
      { action: 'revokeEnable', userId: uid });
    // 反例一：secCheck 的【待复核】推送（真的带「用户ID：」行，格式照 buildPush 抄的）
    const reviewPush = '【待复核】引流广告\n' +
      '内容：加群领养猫咪\n' +
      '作者：某同学\n' +
      '用户ID：64fa07d6a09a9bd68b13a8a0\n' +
      '命中词：加群\n' +
      '状态：内容已发布（待复核）';
    check('  【待复核】推送里同样能抠出「用户ID：」',
      cb.extractExemptUserId(reviewPush), uid);
    check('  ⚠️ 但在那里裸「撤销豁免」必须被拒（否则撤的是被复核的作者）',
      typeof cb.resolveAction(cb.parseCommand('撤销豁免'), cb.detectContext(reviewPush), reviewPush).error,
      'string');

    // 反例二：举报推送（extractOpenid 会捞「被举报人ID：」—— 这正是不能复用它做撤销的原因）
    check('  ⚠️ 举报推送下也必须被拒（extractOpenid 会捞到被举报人）',
      typeof cb.resolveAction(cb.parseCommand('撤销豁免'), cb.detectContext(reportText), reportText).error,
      'string');
    check('     而「禁言用户」在举报推送下仍然照常可用（宽窄是分开定的，没被一起改窄）',
      cb.resolveAction(cb.parseCommand('禁言用户'), cb.detectContext(reportText), reportText),
      { action: 'mute', userId: '6475a94bf43e605f713f2ce1', reason: '飞书指令' });

    // 反例三：发布申请卡片，且**绝不能**把「同意」那条线搅乱
    check('  发布申请卡片上「撤销豁免」也被拒（那上面没有「用户ID：」行）',
      typeof cb.resolveAction(cb.parseCommand('撤销豁免'), cb.detectContext(applyText), applyText).error,
      'string');
    check('    且「同意」仍然只在发布申请卡片下有效（本功能没动到它）',
      cb.resolveAction(cb.parseCommand('同意'), cb.detectContext(applyText), applyText).action,
      'applyDecision');
    check('    「同意」在【自助开通】下仍然被拒（它的首行守卫没被放宽）',
      typeof cb.resolveAction(cb.parseCommand('同意'), cb.detectContext(selfEnableText), selfEnableText).error,
      'string');

    // 带 ID 的写法不受场景限制：这是回读不到父消息时（卡片由 webhook 发出）唯一的出路
    check('带 ID 时不受场景限制（【待复核】下也能用）',
      cb.resolveAction(cb.parseCommand('撤销豁免 ' + uid), cb.detectContext(reviewPush), reviewPush),
      { action: 'revokeEnable', userId: uid });
  }

  // ============================================================
  // 撤销豁免**必须走 adminManage，不能走 moderate**（2026-09-17）
  // ============================================================
  // 🔴 与上面那条「verb 当 action 直接调 moderate」的断言**方向相反**，所以必须另写一组：
  //    那条证明「禁言」两边的名字是对的；这条证明「撤销豁免」**根本不该出现在那边**。
  //    两条放在一起才完整 —— 单看名字逐字一致会让人以为"放进 moderate 也行"。
  //
  // 为什么不能放 moderate：它的头注释把契约写死了 ——「契约上任何人都能调」，
  //   因此**只许剥夺/恢复（ban/unban/mute/unmute），严禁授予（grantPost 就是被这条挡在外面的）」。
  //   「撤销豁免」本身够格进 moderate（剥夺），但它**配套写一个 enableRevoked 锁**，
  //   而唯一能解这把锁的是 adminManage 的 applyDecision（审批通过）—— 写入逻辑拆在
  //   两个函数里迟早对不上。再加上原先与该锁配对的「恢复豁免」（授予类，moderate 明令禁止），
  //   撤销与恢复是同一枚硬币的两面，拆开必漂，所以一起放在 adminManage，
  //   靠 FEISHU_INTERNAL_SECRET 验签（fail-closed）。
  //   【2026-09-17】「恢复豁免」已删（退路改成"让对方重新申请"），这条理由只剩前半段 ——
  //   但结论不变：revokeEnable 仍然**必须**是 moderate 的未知 action。
  //
  // ⚠️ 这条断言真正保护的是**将来**：若有人为了省事把 revokeEnable 塞进 moderate 的 switch，
  //   它会变红 —— 因为下面这个调用**必须**是未知 action。
  {
    // ⚠️ 用本块自己的 id：上面那组的 uid 是块级作用域，出块即失效
    //   （初版直接引用了它，报 ReferenceError: uid is not defined —— 整脚本硬挂，不是断言红）
    const uid = '64fa07d6a09a9bd68b13a8a0';
    const mod2 = require(path.resolve(__dirname, '..', 'cloudfunctions', 'moderate', 'index.js'));
    const seen = [];
    const spyDb = { collection: function (name) {
      return {
        find: async function () { return { result: [] }; },
        updateMany: async function (f, u) { seen.push({ name: name, update: u }); return { modifiedCount: 1 }; },
        updateOne: async function () { seen.push({ name: name }); return {}; },
        insertOne: async function () { seen.push({ name: name }); return {}; },
        deleteOne: async function () { seen.push({ name: name }); return {}; },
      };
    } };
    // 注意返回值形状：moderate 的 default 分支只回 { ok:false, msg }，**没有 code 字段**
    //   （不是 adminManage 那种带错误码的风格）。所以这里锚在 msg 上。
    const rRev = await mod2({ args: { action: 'revokeEnable', userId: uid }, mpserverless: { db: spyDb } });
    check('  ⚠️ 把 revokeEnable 当 action 调 moderate → 必须是未知 action（它不是 moderate 的动作）',
      rRev, { ok: false, msg: '未知 action: revokeEnable' });
    check('     且这次调用**一次写都没有发生**（没有降级成"不认识的 action 就顺手封禁"）',
      seen.length, 0);

    // 正面：同名动作在 adminManage 里才是存在的（否则上面那条就只是"两边都没有"，没证明力）
    const am = require(path.resolve(__dirname, '..', 'cloudfunctions', 'adminManage', 'index.js'));
    check('     而 adminManage 才导出 revokeEnable（撤销的唯一执行点）',
      typeof am.revokeEnable, 'function');
    // 逆操作不该以任何名字留在导出面上：留一个 revokeEnable 的同族函数在那儿，
    //   等于给"把恢复命令加回来"铺了半条路（那个函数就是现成的执行器）。
    check('     且**没有**任何"请恢复豁免"的执行器被导出（setEnable / restoreEnable 都不在）',
      ['setEnable', 'restoreEnable', 'restoreExempt'].filter(function (k) { return k in am; }),
      []);
  }

  // ============================================================
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常', e);
  process.exit(1);
});
