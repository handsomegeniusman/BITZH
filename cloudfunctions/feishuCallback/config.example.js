/**
 * feishuCallback 云函数配置模板（复制本文件为 config.js 后填真实值）
 * ============================================================
 * 用法：
 *   1. 复制本文件为同目录下的 config.js
 *   2. 打开 config.js，把下面的示例值替换成真实值
 *   3. 随函数一起部署到云端
 * 说明：代码优先读控制台环境变量 process.env；若平台没有环境变量入口（如 EMAS
 *       小程序云），就用 config.js 兜底。config.js 已被 .gitignore 忽略，不会提交。
 *
 * 【本目录此前没有这个模板】是补的 —— 部署卡（飞书部署-环境变量配置卡.md）一直在
 *   手工记录这些值，但仓库里没有对照表，新人容易漏配。以本文件为准。
 */
module.exports = {
  FEISHU_VERIFICATION_TOKEN: '你的飞书事件订阅 Verification Token', // 飞书开放平台 → 事件订阅 → Verification Token
  FEISHU_APP_ID: 'cli_你的飞书应用AppID',      // 飞书开放平台 → 凭证与基础信息 → App ID
  FEISHU_APP_SECRET: '你的飞书应用AppSecret',  // 飞书开放平台 → 同上页 → App Secret
  FEISHU_WEBHOOK_URL: '',                     // 可选：回退回执用的群机器人 webhook
  FEISHU_WEBHOOK_SECRET: '',                  // 可选：webhook 签名密钥

  // ---- 发布权限审批：飞书通道的内部密钥 ----
  // 【用途】群里回「同意」/「拒绝」时，本函数把审批转给 adminManage 的 decidePostApply 执行。
  //   飞书回调里没有终端用户身份，走不了 adminManage 的那两道锁，这个密钥就是那条路的凭据。
  // 【必须与 adminManage/config.js 里的同名项填同一个值】两边不一致 = 飞书审批全部失败。
  // 【不配会怎样】adminManage 侧返回 NO_INTERNAL_SECRET，飞书审批不可用（小程序里审批不受影响）。
  //   刻意做成 fail-closed：忘配置应该"哑掉"，而不是变成"谁都能批"。
  FEISHU_INTERNAL_SECRET: '',
};
