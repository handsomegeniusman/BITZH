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
['parseCommand', 'resolveAction', 'detectContext', 'extractTarget', 'extractOpenid', 'extractReporterId', 'extractApplicantId'].forEach(function (fn) {
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
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常', e);
  process.exit(1);
});
