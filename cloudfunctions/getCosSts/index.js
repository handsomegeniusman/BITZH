/**
 * 云函数 getCosSts —— 为小程序签发腾讯云 COS 临时密钥（STS）
 * ============================================================
 * 【作用】COS 的固定 SecretId / SecretKey 只存在于本云函数的服务端环境变量里，
 *        小程序端通过 app.mpServerless.function.invoke('getCosSts', {})
 *        获取 30 分钟有效的临时密钥，从而不再需要把永久密钥放进小程序包。
 *
 * 【部署到阿里云 MPServerless】
 *    1. 控制台「云函数」→ 新建函数 getCosSts（Node.js 运行时）；
 *    2. 把本目录的 index.js 粘贴进编辑器；
 *    3. 在函数配置里安装依赖：npm install qcloud-cos-sts（控制台可在线安装，或本地 build 后上传）；
 *    4. 配置环境变量：
 *         COS_SECRET_ID  腾讯云 CAM 子账号/主账号的 SecretId（建议用受限子账号）
 *         COS_SECRET_KEY 对应 SecretKey
 *         COS_APPID      存储桶所属账号 AppID（即 bucket 名 "-" 后的数字，如 1318479541）
 *         COS_BUCKET     存储桶名（如 bitzh-1318479541）
 *         COS_REGION     地域（如 ap-guangzhou）
 *    5. 发布函数版本。
 *
 * 【权限范围】临时密钥只允许对 main/images/ 目录做上传/复制/删除/读取
 *        （小程序实际用到的全部操作），无法访问其他目录、其他存储桶或其他云产品。
 *
 * 【注意】部署后用 config.js 里 cos.useSts=true 验证上传/改名/删除/恢复。
 *        调用失败会自动回退固定密钥（见 utils/cosSts.js），不影响线上。
 */
const COSSTS = require('qcloud-cos-sts');

// 从环境变量读永久密钥（绝不要硬编码进云函数代码并提交到仓库）
const SECRET_ID = process.env.COS_SECRET_ID;
const SECRET_KEY = process.env.COS_SECRET_KEY;
const APPID = process.env.COS_APPID || '';
const BUCKET = process.env.COS_BUCKET || '';
const REGION = process.env.COS_REGION || '';

// 最小权限策略：仅 main/images/ 目录（猫咪照片/推文图/头像都在这下面）
const POLICY = {
  version: '2.0',
  statement: [{
    action: [
      'name/cos:PutObject',
      'name/cos:PostObject',
      'name/cos:InitiateMultipartUpload',
      'name/cos:ListParts',
      'name/cos:CompleteMultipartUpload',
      'name/cos:AbortMultipartUpload',
      'name/cos:PutObjectCopy',
      'name/cos:DeleteObject',
      'name/cos:GetObject',
      'name/cos:HeadObject',
    ],
    effect: 'allow',
    resource: [
      'qcs::cos:' + REGION + ':uid/' + APPID + ':' + BUCKET + '/main/images/*',
    ],
  }],
};

module.exports = async function (ctx) {
  // MPServerless 云函数：客户端参数在 ctx.args，返回值成为 res.result（不能用 callback）
  if (!SECRET_ID || !SECRET_KEY) {
    throw new Error('未配置环境变量 COS_SECRET_ID / COS_SECRET_KEY');
  }
  const credential = await new Promise(function (resolve, reject) {
    COSSTS.getCredential({
      secretId: SECRET_ID,
      secretKey: SECRET_KEY,
      durationSeconds: 1800, // 30 分钟
      policy: POLICY,
    }, function (err, credential) {
      if (err) reject(err); else resolve(credential);
    });
  });
  const c = (credential && credential.credentials) || credential;
  if (!c || !c.tmpSecretId || !c.tmpSecretKey || !c.sessionToken) {
    throw new Error('STS 返回数据不完整');
  }
  // expiration 在 qcloud-cos-sts 返回的外层对象上，不在 credentials 里（前端 cosSts.js 用它算续期）
  const expiration = (credential && credential.expiration) || c.expiration;
  // 返回结构与 utils/cosSts.js 期望一致
  return {
    secretId: c.tmpSecretId,
    secretKey: c.tmpSecretKey,
    sessionToken: c.sessionToken,
    expiration: expiration,
  };
};
