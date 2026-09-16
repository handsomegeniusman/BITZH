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
 * 【密码：一处填、处处复用（2026-09-16 管理员决定）】
 *   原先的约定是"密码只在页面 data 里存活，本文件不缓存、用完即弃"。现在改成：
 *   管理员在「管理员」页顶部填一次并**验证通过**后，密码存进本模块的**模块级变量**，
 *   之后所有请求自动带上，不再逐次追问 —— 因为"每做一件事就要重输一遍密码"在
 *   日常使用里太烦，实际上会把人逼去用更弱的密码。
 *   ⚠️ 两条硬约束（改了就等于出事）：
 *     1. **只存内存**，绝不写 Storage / globalData —— 明文密码不该留在设备上。
 *        代价是小程序被杀掉重进就要重填一次，这是刻意接受的。
 *     2. **不主动清**（不清除是设计，不是漏了）。管理员说了"输一次共享，不主动清"，
 *        所以不要"顺手"在页面 onUnload 里加 clearSessionPassword。
 */
// 模块级缓存。注意它**不是** page data，换页面不会丢，小程序重启才丢。
let _sessionPassword = '';

/**
 * 记下本次会话的操作密码。**只应在服务端 authCheck 验证通过之后调用** ——
 * 否则会把一个错密码存下来，之后每个写操作都失败，且用户不知道错在哪。
 */
function setSessionPassword(pw) {
  _sessionPassword = (pw == null) ? '' : String(pw);
}

/** 当前缓存的操作密码（空串 = 还没填过） */
function getSessionPassword() {
  return _sessionPassword;
}

/**
 * 清掉缓存。**正常情况下不要调用**（见文件头第 2 条约束）。
 * 目前只有"用户主动要求忘记密码"这一类显式动作该用它。
 */
function clearSessionPassword() {
  _sessionPassword = '';
}

function invoke(action, params) {
  const app = getApp();
  if (!app || !app.mpServerless || !app.mpServerless.function) {
    return Promise.reject(new Error('云函数不可用'));
  }
  const body = Object.assign({ action: action }, params);
  // 调用方没显式给密码 → 用缓存里的。缓存也是空的话就把这个键删掉，
  // 让服务端按「根本没带密码」处理（返回 NEED_PASSWORD），而不是带一个空串过去。
  if (body.password == null || body.password === '') {
    if (_sessionPassword) body.password = _sessionPassword;
    else delete body.password;
  }
  return app.mpServerless.function.invoke('adminManage', body)
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
 * 【needPassword 是给页面用的直白开关】服务端把"你压根没给密码"(NEED_PASSWORD) 和
 *   "密码不对"(BAD_PASSWORD) 分成了两个码，页面据此决定「弹输入框」还是「报密码错」。
 *   这里再摊平成布尔，免得每个页面都写一遍 code 字符串比较。
 */
function ensureOk(res) {
  if (res && res.ok === false) {
    const err = new Error(res.msg || '云函数返回失败');
    err.code = res.code || '';
    err.result = res;
    err.needPassword = res.code === 'NEED_PASSWORD';
    err.locked = res.code === 'LOCKED';
    throw err;
  }
  return res;
}

module.exports = {
  setSessionPassword: setSessionPassword,
  getSessionPassword: getSessionPassword,
  clearSessionPassword: clearSessionPassword,

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
  /**
   * 只验密码对不对，不读任何业务数据。
   * 【为什么需要它】「管理员」页要能"填的时候就告诉你密码对不对"。不能用 list 代替：
   *   list 是免密动作，身份可信时**根本不校验密码**，拿它验等于永远通过，
   *   于是错密码会被存进缓存，等到真正审批时才炸。authCheck 永远要密码。
   * ⚠️ 它与所有密码校验共用同一套失败计数 —— 连错会触发 LOCKED，页面提示要写清楚。
   * @returns {Promise<{ok:true, action:'authCheck', identityMode:string}>}
   */
  authCheck: function (password) {
    return invoke('authCheck', { password: password });
  },

  /**
   * 校验密码，**通过之后**才存进会话缓存。
   * 【为什么要收口成一个函数】「管理员」页顶部和「发布申请」页都要做这件事，
   *   而"先验证再存"这条一旦在某一边漏掉，就会把一个错密码存下来 ——
   *   之后每个写操作都失败，且用户完全不知道错在哪（他明明在别的页面输对过）。
   *   所以宁可多一个函数，也不要让两个页面各写一遍。
   * 【不抛异常】返回 { ok, err }，让调用方自己决定怎么提示（两边的提示文案不一样）。
   * @returns {Promise<{ok:boolean, err:Error|null}>}
   */
  verifyAndCache: function (password) {
    const pw = (password == null) ? '' : String(password);
    if (!pw) return Promise.resolve({ ok: false, err: new Error('请输入操作密码') });
    return invoke('authCheck', { password: pw }).then(function (res) {
      ensureOk(res);           // 密码错 → 抛 BAD_PASSWORD；被锁 → 抛 LOCKED
      _sessionPassword = pw;   // 只有走到这里才存
      return { ok: true, err: null };
    }).catch(function (e) {
      return { ok: false, err: e };
    });
  },
  /**
   * 发布申请：待办队列 + 最近处理历史，一次取回（页面上下两块要同时刷新）。
   * 与 list 一样是只读动作：服务端能独立确认身份时不需要密码。
   * @param {String} [password]
   * @param {Number} [historyLimit] 历史条数，默认 20、服务端封顶 50；不传用默认值
   * @returns {Promise<{ok:true, applies:Array, total:number, history:Array, historyTotal:number}>}
   */
  listApplies: function (password, historyLimit) {
    const p = { password: password };
    if (historyLimit) p.historyLimit = historyLimit;
    return invoke('listApplies', p);
  },
  /**
   * 通过发布申请：服务端把该用户的 Feeder.canPost 置 true（永久有效）。
   * 黑名单用户会被服务端一票否决（BLACKLISTED），即便这里点了通过。
   * @returns {Promise<{ok:true, userId:string, nickName:string, noApply:boolean}>}
   */
  approvePost: function (userId, applyId, password) {
    return invoke('approvePost', { userId: userId, applyId: applyId, password: password });
  },
  /**
   * 拒绝发布申请：只标记这条申请，**不碰该用户已有的任何权限**（本期不做撤销）。
   * 用户当天不能再申请（PostApply 的 _id 已占用），次日起可再申请。
   * @returns {Promise<{ok:true, userId:string, noApply:boolean}>}
   */
  rejectPost: function (userId, applyId, password) {
    return invoke('rejectPost', { userId: userId, applyId: applyId, password: password });
  },

  /**
   * 动态敏感词库（管理员追加的词，加进去立刻生效，不需要重新部署云函数）。
   * @returns {Promise<{ok:true, words:Array<{word,raw,tier,by,timeText}>, total:number, max:number, blocked:number}>}
   */
  listWords: function (password) {
    return invoke('listWords', { password: password });
  },
  /**
   * 追加/改档一个词。
   * @param {String} word 词（≥2 字 ≤20 字；单字会被服务端拒绝）
   * @param {String} [tier] 'block' = 命中即拒绝发布；'review' = 照常发布但推管理员复核。
   *        不传 / 非法值按 'block'。**同一个词再传一次就是改档位**，不必先删再加。
   * @returns {Promise<{ok:true, word:string, tier:string, added:boolean, updated?:boolean}>}
   */
  addWord: function (word, tier, password) {
    return invoke('addWord', { word: word, tier: tier, password: password });
  },
  /** 从词库删掉一个词（手滑加错时的补救入口） */
  delWord: function (word, password) {
    return invoke('delWord', { word: word, password: password });
  },

  /** 服务端身份**不可信**时调用（页面要显示红色提醒条），判断依据是返回里的 identityMode */
  isTrusted: function (res) {
    return !!(res && res.identityMode === 'trusted');
  },
  ensureOk: ensureOk,
};
