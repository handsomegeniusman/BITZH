/**
 * utils/db.js —— 数据库与用户状态的公共方法
 * ============================================================
 * 【作用】把多个页面重复的代码集中到这里：
 *    1. 统一的增删改查（find/findOne/insertOne/updateOne/updateMany/deleteOne），
 *       所有页面通过 db.xxx('集合名', ...) 访问数据库，不再直接写
 *       app.mpServerless.db.collection(...)（避免重复 + 统一错误处理）
 *    2. 获取当前登录用户 openid（只请求一次，带缓存）
 *    3. 判断当前用户是否为"管理员"（带缓存，避免每个页面重复查库）
 *    4. 读取"是否开放注册/发布"的审核开关（带缓存）
 *    5. 通用的分页查询（自动按 _id 去重合并，避免列表重复）
 * ============================================================
 */
const config = require('../config.js');
// 「能不能发帖/评论」的纯判断式（可 node 单测，见 utils/publishGate.js 文件头）
const publishGate = require('./publishGate.js');

// ---------- 1. 统一增删改查 ----------

/** 获取指定集合（阿里云 MPServerless） */
function collection(name) {
  return getApp().mpServerless.db.collection(name);
}

/**
 * 查询多条记录
 * @param {String} name    集合名称，例如 'BITZH' / 'Page'
 * @param {Object} filter  查询条件（不传则查全部）
 * @param {Object} options 查询选项 { sort, skip, limit }
 * @returns {Promise<Array>} 结果数组（查不到返回空数组）
 */
async function find(name, filter, options) {
  try {
    const res = await collection(name).find(filter || {}, options);
    const data = (res && res.result) || [];
    console.log('[db.find]', name, JSON.stringify(filter).slice(0, 120), '=> 查到', Array.isArray(data) ? data.length : '非数组:' + JSON.stringify(res).slice(0, 120), '条');
    return data;
  } catch (e) {
    console.error('[db.find]', name, JSON.stringify(filter).slice(0, 120), '失败 =>', (e && e.message) || e);
    throw e;
  }
}

/**
 * 查询单条记录
 * @returns {Promise<Object|null>} 结果文档；查不到返回 null
 */
async function findOne(name, filter, options) {
  const list = await find(name, filter, options);
  return list[0] || null;
}

/** 插入一条记录 */
function insertOne(name, doc) {
  return collection(name).insertOne(doc);
}

/** 更新单条记录（$set/$inc 等写法不变） */
function updateOne(name, filter, update) {
  return collection(name).updateOne(filter, update);
}

/** 批量更新 */
function updateMany(name, filter, update) {
  return collection(name).updateMany(filter, update);
}

/** 删除单条记录 */
function deleteOne(name, filter) {
  return collection(name).deleteOne(filter);
}

// 用户状态缓存：同一个用户在小程序运行期间只查一次数据库
const state = {
  userId: null,             // 当前用户 openid
  userInfo: null,           // 当前用户在 Feeder（用户资料）表中的资料
  isFeeder: false,          // 是否已注册用户资料
  isAdministrator: false,   // 是否为管理员
  administratorName: null,  // 管理员姓名
  administratorChecked: false, // 管理员是否已查询过（防止重复查库）
  feederChecked: false,        // 用户资料是否已查询过
  audit: null,                 // 审核开关（是否开放注册/发布），null 表示未加载
  canPost: false,              // 是否已获批发布权限（Feeder.canPost；管理员另算，见 canPublish）
  mutePost: false,             // 是否被禁言（Feeder.mutePost；与 canPost 正交，见 publishGate.js）
};

/**
 * 获取当前登录用户的 openid（带缓存，只请求一次）
 * @returns {Promise<String>}
 */
async function getUserId() {
  if (state.userId) return state.userId;
  const app = getApp();
  try {
    const { result } = await app.mpServerless.user.getInfo();
    state.userId = result.user.userId;
    console.log('[db.getUserId] OK, userId =', state.userId);
  } catch (e) {
    console.error('[db.getUserId] 失败 =>', (e && e.message) || e);
    throw e;
  }
  return state.userId;
}

/**
 * 一次性获取当前用户的完整状态：
 * openid + 是否为管理员 + 是否已注册用户（用户资料）
 * 查询结果写入 app.globalData 并通知所有页面监听器，
 * 避免每个页面各自重复查库。
 * @returns {Promise<Object>} state
 */
async function initUserState() {
  const app = getApp();
  const userId = await getUserId();

  // 1. 判断是否为管理员（BITZHAdministrator 集合，只查一次）
  if (!state.administratorChecked) {
    try {
      const res = await app.mpServerless.db.collection('BITZHAdministrator').find({
        userId: userId,
      });
      if (res.result && res.result.length > 0) {
        state.isAdministrator = true;
        state.administratorName = res.result[0].name;
      }
    } catch (e) {
      console.error('查询管理员失败', e);
    }
    state.administratorChecked = true;
  }

  // 2. 判断是否为已注册用户（Feeder 集合，只查一次）
  if (!state.feederChecked) {
    try {
      const res = await app.mpServerless.db.collection('Feeder').find({
        userId: userId,
      });
      if (res.result && res.result.length > 0) {
        state.isFeeder = true;
        state.userInfo = res.result[0];
        // 【零额外查询】Feeder 文档刚刚就查回来了，canPost / mutePost 直接读它。
        // 用 !! 而非 === true：控制台手工改数据时可能写成 1；云函数一律写布尔。
        state.canPost = !!(res.result[0] && res.result[0].canPost);
        // 禁言标志（moderate 的 mute 写入）。与 canPost 同批读、同批在 resetUserState 里清 ——
        // 漏清会残留上一次用户的 true，那是最难查的一类 bug（换账号后莫名其妙发不出帖）。
        state.mutePost = !!(res.result[0] && res.result[0].mutePost);
      }
    } catch (e) {
      console.error('查询用户资料失败', e);
    }
    state.feederChecked = true;
  }

  // 3. 写入全局状态，并通知页面
  app.globalData.userId = userId;
  app.globalData.isAdministrator = state.isAdministrator;
  app.globalData.Administrator = state.administratorName;
  app.globalData.isFeeder = state.isFeeder;
  app.globalData.userInfo = state.userInfo || {};
  app.globalData.canPost = state.canPost;
  if (typeof app.notifyPageDataListeners === 'function') {
    app.notifyPageDataListeners(app.globalData.userInfo);
  }

  return state;
}

/**
 * 能否发布 / 评论：管理员，或已获批发布权的普通用户，且**当前没有被禁言**。
 * 【为什么要有这个函数】8 个入口（底部加号 ×2 / someBooklet 浮动按钮 ×2 / addBooklet 页守卫 /
 *   bookletDetail ×2 / mydetail）都要问同一件事，判断式写 8 遍迟早漂移 —— 尤其是
 *   "加号没了但评论还能发"这种漏一处才发现的 bug。所有入口只认这一个答案。
 * 【必须在 await db.initUserState() 之后调用】它读的是模块级 state 缓存。
 * 【注意命名】DB 字段叫 canPost（只表示"被批准过"），本函数叫 canPublish（多含"管理员也算"+"没被禁言"）。
 * 【判断式本身在 utils/publishGate.js】纯函数、可 node 单测。这里只做委托，
 *   本文件依赖 wx 所以测不了它自己 —— 这也是把公式挪出去的原因。
 * @returns {Boolean}
 */
function canPublish() {
  return publishGate.canPublish(state);
}

/**
 * 读取"审核开关"：是否开放注册 / 发布（Administrator 集合中的 audit 字段）
 * 带缓存，只查一次。
 * @returns {Promise<Boolean>}
 */
async function getAudit() {
  if (state.audit !== null) return state.audit;
  try {
    const app = getApp();
    const res = await app.mpServerless.db.collection('Administrator').find({
      _id: config.administratorRecordId,
    });
    state.audit = !!(res.result && res.result[0] && res.result[0].audit);
  } catch (e) {
    console.error('读取审核开关失败', e);
    state.audit = false;
  }
  return state.audit;
}

/**
 * 读取"联系方式"（手机号 + 邮箱）：Administrator 集合中联系方式记录（config.contactRecordId）的
 * phone / email 字段。注意：联系方式与审核开关不是同一条记录。
 * 不缓存，每次读取最新值（联系方式改动只改数据库、无需重新发版即可生效）。
 * 字段缺失或查询失败返回空串，由调用方（about 页）兜底显示默认值。
 * @returns {Promise<{phone: String, email: String}>}
 */
async function getContact() {
  try {
    const app = getApp();
    const res = await app.mpServerless.db.collection('Administrator').find({
      _id: config.contactRecordId,
    });
    const rec = res.result && res.result[0];
    return {
      phone: (rec && typeof rec.phone === 'string') ? rec.phone : '',
      email: (rec && typeof rec.email === 'string') ? rec.email : '',
    };
  } catch (e) {
    console.error('读取联系方式失败（about 页显示默认值）', e);
    return { phone: '', email: '' };
  }
}

/**
 * 检查当前用户是否在"黑名单"（BlackNum 集合）中
 * @returns {Promise<Boolean>}
 */
async function isBlacklisted() {
  const userId = await getUserId();
  try {
    const res = await getApp().mpServerless.db.collection('BlackNum').find({
      id: userId,
    });
    return !!(res.result && res.result.length > 0);
  } catch (e) {
    console.error('查询黑名单失败', e);
    return false;
  }
}

/**
 * 通用分页查询：
 * 查询数据库并把新数据按 _id 去重后合并进已有列表（用于下拉加载更多）
 * @param {String} collection 集合名称，例如 'BITZH' / 'Page'
 * @param {Object} filter     查询条件
 * @param {Object} options    查询选项 { sort, limit, skip }（skip 不传则自动用列表长度）
 * @param {Array}  list       当前已加载的列表
 * @returns {Promise<Array>}  合并去重后的新列表
 */
function paginate(collection, filter, options, list) {
  const app = getApp();
  // 防御：list 必须是数组（某些页面曾误传对象），否则按空列表处理，避免 list.map 报错
  const safeList = Array.isArray(list) ? list : [];
  const opts = Object.assign({ limit: 20, skip: safeList.length }, options);
  return app.mpServerless.db.collection(collection).find(filter, opts)
    .then(function (res) {
      const data = (res && res.result) || [];
      const seen = new Set(safeList.map(function (i) { return i._id; }));
      // 只保留还没加载过的新数据，避免翻页时重复
      return safeList.concat(data.filter(function (i) { return !seen.has(i._id); }));
    })
    .catch(function (err) {
      console.error('分页查询失败：' + collection, err);
      // 出错时返回原列表，不影响页面展示；同时挂 _failed 标记，让调用方能区分
      // 「真的没数据」和「查询失败」——返回值仍是数组（Array.isArray 为真），
      // 旧调用方无视该属性即可，行为完全不变。
      const out = safeList.slice();
      out._failed = true;
      return out;
    });
}

/**
 * 清除用户状态缓存。
 * 【用途】在"注册成功 / 修改资料"后调用，强制下次重新查询
 *        （因为此时用户资料已变更，isFeeder 需要刷新）
 */
function resetUserState() {
  state.userId = null;
  state.userInfo = null;
  state.isFeeder = false;
  state.isAdministrator = false;
  state.administratorName = null;
  state.administratorChecked = false;
  state.feederChecked = false;
  // 【必须清】漏了会残留上一次的 true —— 管理员刚批准完自己再切号，
  // 新账号会带着"已获批"的状态继续用，加号和评论框都误开。
  state.canPost = false;
  // 同理，而且更隐蔽：漏了 mutePost 会让"解禁后仍发不出帖"
  //（本人在自己手机上永远是禁言前的状态，换号才复现）。
  state.mutePost = false;
}

/**
 * 清除审核开关缓存。
 * 【用途】管理员在后台切换"是否开放注册/发布"后调用，
 *        让其他页面下次读取时拿到最新值。
 */
function resetAuditCache() {
  state.audit = null;
}

// ---------- 封禁/解封/软删除（内容安全，取证留存） ----------

/**
 * 封禁用户：加入黑名单 + 软删除其全部推文/评论（打标志，不物理删，供监管抽查取证）。
 * @param {String} userId 被禁用户 openid
 * @param {String} reason 封禁原因（可选，写入 BlackNum 供申诉时查证）
 */
async function banUser(userId, reason) {
  const now = new Date();
  // 1) 黑名单（幂等：已存在则跳过，避免重复插入）
  const exist = await findOne('BlackNum', { id: userId });
  if (!exist) {
    await insertOne('BlackNum', { id: userId, time: now, reason: reason || '' });
  }
  // 2) 软删推文
  await updateMany('Page', { authorId: userId }, { $set: { hidden: true, hiddenBy: 'ban', hiddenTime: now } });
  // 3) 软删评论
  await updateMany('Comment', { authorId: userId }, { $set: { deleted: true, deletedBy: 'ban', deletedTime: now } });
}

/**
 * 解封用户：移出黑名单 + 恢复其内容可见。
 * @param {String} userId 被解封用户 openid
 */
async function unbanUser(userId) {
  const recs = await find('BlackNum', { id: userId });
  for (let i = 0; i < recs.length; i++) {
    if (recs[i]._id) await deleteOne('BlackNum', { _id: recs[i]._id });
  }
  await updateMany('Page', { authorId: userId }, { $set: { hidden: false } });
  await updateMany('Comment', { authorId: userId }, { $set: { deleted: false } });
}

/**
 * 软删除单条评论（替代物理 deleteOne，取证留存）。
 * @param {String|Number} myCommentId 评论 myCommentId
 * @param {String} operator 操作者（管理员名/作者本人），写入 deletedBy 备查
 */
function softDeleteComment(myCommentId, operator) {
  return updateOne('Comment', { myCommentId: myCommentId }, {
    $set: { deleted: true, deletedBy: operator || '', deletedTime: new Date() },
  });
}

/**
 * 软删除单条推文（替代物理 deleteOne，取证留存）。
 * @param {String} _id Page 记录 _id
 * @param {String} operator 操作者，写入 hiddenBy 备查
 */
function softDeletePage(_id, operator) {
  return updateOne('Page', { _id: _id }, {
    $set: { hidden: true, hiddenBy: operator || '', hiddenTime: new Date() },
  });
}

/**
 * 过滤掉被软删除（hidden）的推文。封禁用户的内容打 hidden 标志，
 * 前端展示层统一过滤（取证留存在库中，不物理删除）。
 * @param {Array} list 推文列表
 * @returns {Array} 不含 hidden 项的列表
 */
function filterHidden(list) {
  return (Array.isArray(list) ? list : []).filter(function (item) {
    return item && !item.hidden;
  });
}

module.exports = {
  state: state,
  // 统一增删改查
  find: find,
  findOne: findOne,
  insertOne: insertOne,
  updateOne: updateOne,
  updateMany: updateMany,
  deleteOne: deleteOne,
  // 用户状态 / 审核开关 / 分页
  getUserId: getUserId,
  initUserState: initUserState,
  canPublish: canPublish,
  getAudit: getAudit,
  getContact: getContact,
  isBlacklisted: isBlacklisted,
  paginate: paginate,
  resetUserState: resetUserState,
  resetAuditCache: resetAuditCache,
  // 封禁/解封/软删除
  banUser: banUser,
  unbanUser: unbanUser,
  softDeleteComment: softDeleteComment,
  softDeletePage: softDeletePage,
  filterHidden: filterHidden,
};
