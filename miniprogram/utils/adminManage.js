/**
 * utils/adminManage.js —— 管理员在线增删封装
 * ============================================================
 * 【作用】统一走 adminManage 云函数（服务端校验密码 + 写库），前端只负责发起和展示。
 *         客户端**不做**任何"是不是管理员"的兜底判断 —— 那种判断在本项目里防不住人：
 *         miniprogram/config.js 的 clientSecret 随包发到用户手机上，拿到就能绕过这个文件
 *         直接写数据库，所以任何前端校验都只是"防手滑"，不是"防越权"。
 *
 * 【这不是安全边界】和 utils/guard.js 开头说的一样：真正的门槛在云函数和集合权限规则里。
 *   本文件只负责把请求发出去、把服务端的 { ok, code, msg } 如实转成 Promise 的结果/异常。
 *
 * 【密码怎么传】密码只在页面 data 里存活，调用时作为参数传进来，本文件**不缓存**它，
 *   也绝不写 Storage / globalData。用完即弃。
 */
function invoke(action, params) {
  const app = getApp();
  if (!app || !app.mpServerless || !app.mpServerless.function) {
    return Promise.reject(new Error('云函数不可用'));
  }
  return app.mpServerless.function.invoke('adminManage', Object.assign({ action: action }, params))
    .then(function (res) {
      // 云函数返回值包在 res.result 里，这里解包方便调用方直接用 { ok, ... }
      return (res && res.result !== undefined) ? res.result : res;
    });
}

/**
 * 把服务端的失败结果转成异常，成功则原样返回。
 * 【为什么不直接 if (res.ok)】沿用 reviewCenter.js 的写法：只认明确的 ok === false，
 *   这样云函数万一返回了不带 ok 的旧结构也不会被误判成失败。
 * 【为什么把 code 挂到 Error 上】页面要按错误码分支（LOCKED 显示倒计时、NOT_FEEDER 提示
 *   去注册、NO_PASSWORD_CONFIG 提示管理员去配环境变量），只有 msg 字符串不够用。
 */
function ensureOk(res) {
  if (res && res.ok === false) {
    const err = new Error(res.msg || '云函数返回失败');
    err.code = res.code || '';
    err.result = res;
    throw err;
  }
  return res;
}

module.exports = {
  /**
   * 管理员列表（补了昵称/头像）。
   * 服务端能独立确认身份时不需要密码；确认不了时**必须**带密码。
   * @returns {Promise<{ok:true, admins:Array, total:number, identityMode:string}>}
   */
  list: function (password) {
    return invoke('list', { password: password });
  },
  /**
   * 设为管理员。userId 必须是已注册用户（服务端会去 Feeder 核对）。
   * @returns {Promise<{ok:true, userId:string, name:string, already:boolean}>}
   */
  grant: function (userId, name, password) {
    return invoke('grant', { userId: userId, name: name, password: password });
  },
  /**
   * 移除管理员。服务端拒绝移除自己、也拒绝移除最后一位管理员。
   * @returns {Promise<{ok:true, userId:string, already:boolean}>}
   */
  revoke: function (userId, password) {
    return invoke('revoke', { userId: userId, password: password });
  },
  /**
   * 身份诊断：返回服务端能否独立确认调用者身份（实测"两道锁还是一道锁"用）。
   * 同样要求密码。ADMIN_DIAG 关掉后不再回显具体 userId。
   */
  whoami: function (password) {
    return invoke('whoami', { password: password });
  },
  /** 服务端身份**不可信**时调用（页面要显示红色提醒条），判断依据是返回里的 identityMode */
  isTrusted: function (res) {
    return !!(res && res.identityMode === 'trusted');
  },
  ensureOk: ensureOk,
};
