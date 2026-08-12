/**
 * utils/cosSts.js —— COS 临时密钥（STS）签发
 * ============================================================
 * 【作用】通过 MPServerless 云函数「getCosSts」为腾讯云 COS 签发临时密钥，
 *        避免把固定的 SecretId / SecretKey 放在小程序包里（前端可被反编译）。
 *
 * 【启用方式】三步：
 *    1. 在阿里云 MPServerless 控制台创建一个云函数 getCosSts，
 *       上传仓库 cloudfunctions/getCosSts/ 里的代码并配置环境变量；
 *    2. 在 config.js 里把 cos.useSts 改为 true；
 *    3. 重新上传体验版验证上传/改名/删除/恢复均正常。
 *
 * 【安全性】所有操作都回退固定密钥兜底：云函数未部署 / 调用失败 /
 *          返回数据不完整时，自动退回 config.cos 里的固定密钥，功能不受影响。
 *          所以启用 useSts 后即使云函数还没就绪也不会报错，只是暂时未生效。
 * ============================================================
 */
const config = require('../config.js');

// 临时密钥缓存：有效期约 30 分钟，提前 5 分钟续期，避免每个请求都调云函数
let cached = null; // { secretId, secretKey, sessionToken, expiration(ms) }

/** 是否已过期（或即将过期） */
function isExpiredSoon(expirationMs) {
  return !expirationMs || (expirationMs - Date.now()) < 5 * 60 * 1000;
}

/**
 * 调用云函数 getCosSts 签发临时密钥（带缓存）。
 * @returns {Promise<Object|null>} {secretId, secretKey, sessionToken, expiration}
 *          失败返回 null，调用方据此回退固定密钥
 */
function fetchTempKeys() {
  if (cached && !isExpiredSoon(cached.expiration)) return Promise.resolve(cached);
  return new Promise(function (resolve) {
    const app = getApp();
    if (!app || !app.mpServerless || !app.mpServerless.function) {
      console.warn('MPServerless 云函数不可用，回退固定密钥');
      resolve(null);
      return;
    }
    app.mpServerless.function.invoke('getCosSts', {})
      .then(function (res) {
        const r = (res && res.result) || {};
        if (!r.secretId || !r.secretKey || !r.sessionToken) {
          console.error('云函数返回的临时密钥不完整，回退固定密钥');
          resolve(null);
          return;
        }
        cached = {
          secretId: r.secretId,
          secretKey: r.secretKey,
          sessionToken: r.sessionToken,
          expiration: Date.parse(r.expiration) || (Date.now() + 30 * 60 * 1000),
        };
        resolve(cached);
      })
      .catch(function (e) {
        console.error('获取 COS 临时密钥失败，回退固定密钥', e);
        resolve(null);
      });
  });
}

/**
 * 生成 COS 客户端初始化配置。
 * useSts=true 且能拿到临时密钥 → 用 getAuthorization（临时密钥签名）；
 * 否则 → 用 config.cos 的固定密钥（与旧行为完全一致）。
 * @returns {Object} 传给 new COS(...) 的配置
 */
function buildCosConfig() {
  const base = {
    Bucket: config.cos.Bucket,
    Region: config.cos.Region,
  };
  if (!config.cos.useSts) return Object.assign({}, config.cos, base);
  return Object.assign({
    getAuthorization: function (options, callback) {
      fetchTempKeys().then(function (creds) {
        if (!creds) {
          callback({ SecretId: config.cos.SecretId, SecretKey: config.cos.SecretKey });
          return;
        }
        callback({
          TmpSecretId: creds.secretId,
          TmpSecretKey: creds.secretKey,
          SecurityToken: creds.sessionToken,
          StartTime: Math.floor(Date.now() / 1000),
          ExpiredTime: Math.floor(creds.expiration / 1000),
        });
      });
    },
  }, base);
}

module.exports = {
  fetchTempKeys: fetchTempKeys,
  buildCosConfig: buildCosConfig,
};
