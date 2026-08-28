/**
 * secCheck 云函数配置模板（复制本文件为 config.js 后填真实值）
 * ============================================================
 * 用法：
 *   1. 复制本文件为同目录下的 config.js
 *   2. 打开 config.js，把下面的示例值替换成真实值
 *   3. 随函数一起部署到云端
 * 说明：代码优先读控制台环境变量 process.env；若平台没有环境变量入口（如 EMAS
 *       小程序云），就用 config.js 兜底。config.js 已被 .gitignore 忽略，不会提交。
 */
module.exports = {
  WX_APPID: 'wx你的小程序AppID',           // 微信公众平台 → 开发管理 → 开发设置 → AppID
  WX_SECRET: '你的小程序AppSecret',        // 微信公众平台 → 同上页 → AppSecret（需管理员权限）
  ADMIN_EMAIL: '你的管理员邮箱',           // 与小程序 config.js 的 adminEmail 一致
  FEISHU_APP_ID: 'cli_你的飞书应用AppID',  // 飞书开放平台 → 凭证与基础信息 → App ID
  FEISHU_APP_SECRET: '你的飞书应用AppSecret', // 飞书开放平台 → 同上页 → App Secret
  FEISHU_CHAT_ID: 'oc_你的通知群chat_id',   // 通知群 chat_id（获取方法见 README 12.3）
  FEISHU_WEBHOOK_URL: '',                  // 可选：群自定义机器人 webhook（回退通道，应用 API 失败时才用）
  FEISHU_WEBHOOK_SECRET: '',               // 可选：webhook 签名密钥
};
