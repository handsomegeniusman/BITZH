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
// 「审核模式对这个用户生效吗」的纯判断式（可 node 单测，见 utils/auditGate.js 文件头）
const auditGate = require('./auditGate.js');

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
  isAdministrator: false,   // 是否为管理员（**同时也豁免审核模式**，见 auditGate.js）
  administratorName: null,  // 管理员姓名
  administratorChecked: false, // 管理员是否已查询过（防止重复查库）
  feederChecked: false,        // 用户资料是否已查询过
  audit: null,                 // 审核开关（是否开放注册/发布），null 表示未加载
  enable: false,               // 当前用户是否豁免审核模式（Feeder.enable；见 auditGate.js）
  canPost: false,              // 是否已获批发布权限（Feeder.canPost；管理员另算，见 canPublish）
  mutePost: false,             // 是否被禁言（Feeder.mutePost；与 canPost 正交，见 publishGate.js）
  registUnlocked: false,       // 未注册者在「关于」页连点五次临时开放的注册入口（**内存态**，见 unlockRegist）
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
        // 审核模式豁免标志（Feeder.enable，注册时写入）。同样零额外查询、同样要在
        // resetUserState 里清 —— 漏清会让换号后**新账号也豁免审核模式**，
        // 而那正是审核模式唯一要挡的东西（游客 / 微信审核员）。
        state.enable = !!(res.result[0] && res.result[0].enable);
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
 * 读取"审核模式对**当前用户**是否开放" —— **公共内容页面**该用这个，而不是 getAudit()。
 * （「我的」页是例外，用 getAuditForMyPage() —— 那片只看"注册没注册"。）
 * ============================================================
 * 【一句话区别】getAudit() 返回**全局总开关**的原始值；本函数返回"对本人而言效果如何"：
 *   全局开放 **或** 本人被豁免（Feeder.enable === true 或 在 BITZHAdministrator 名册里，
 *   口径见 utils/auditGate.js）。
 * 【为什么要分成两个函数】管理员页要显示 / 切换的必须是全局值，不能带豁免 ——
 *   本函数对管理员**永远**返回 true（名册豁免），拿它去驱动那个开关，开关会永远显示
 *   "开放中"，既切不动也看不出真相。
 * 【必须在 initUserState 之后读 state.enable / state.isAdministrator】调用点常常先问审核
 *   开关、再初始化用户（index.js 的 onLoad 就是：先 getAudit，后 initUser），那时两个字段
 *   都还是初始值（false）。直接读会一律得到 false，表现是"已注册用户也打不开内容" ——
 *   而且**只在审核模式开启时才露出来**，平时怎么测都正常。所以本函数自己 await 一次；
 *   initUserState 内部有 administratorChecked / feederChecked 缓存，页面查过就不再查库。
 *   custom-tab-bar 的 refreshAudit 早就是这个顺序，并留了同一条注释（它 attached 早于 onLoad）。
 * 【读用户状态失败时按"不豁免"处理】宁可让已注册用户在审核模式下少看一屏，
 *   也不能因为一次网络抖动把审核模式的遮挡整个漏掉 —— 与 getAudit 出错时回落成
 *   "审核模式"（state.audit = false）是同一个方向的兜底。管理员名册查询失败同理：
 *   那次 catch（initUserState 第 129 行）只打日志、isAdministrator 保持 false。
 * @returns {Promise<Boolean>} true = 对本人开放（照常显示内容 / 功能）
 */
async function getAuditForMe() {
  const audit = await getAudit(); // 全局开关（自带缓存，且内部已兜底，不会 reject）
  try {
    await initUserState(); // 保证 state.enable / state.isAdministrator 已就绪
  } catch (e) {
    console.error('读取用户状态失败（审核模式按不豁免处理）', e);
  }
  return auditGate.auditOpen(audit, state.enable, state.isAdministrator);
}

/**
 * 读取"本人数据是否可见" —— 目前**只有「我的」页一处**用，别拿去当公共内容的开关。
 * ============================================================
 * 【和 getAuditForMe 的唯一区别】这里的豁免条件是"**有没有 Feeder 记录**"（isFeeder），
 *   而不是 `Feeder.enable === true`。也就是说：**只要注册过就放行，不看 enable**。
 * 【为什么】「我的」页显示的全是本人的东西（自己的头像昵称、自己的历史、自己的回收站），
 *   里面没有任何社区内容 —— 审核模式挡住它对审核毫无帮助，只会让已经注册的人
 *   连自己的资料和「申请发小猫书」入口都一起消失。用户口径原话：
 *   「只要注册了，在我的页面里相当于关闭审核模式」。
 * 【为什么不做成 getAuditForMe(includeFeeder) 这种开关参数】那种布尔参数在调用点
 *   读不出语义（`getAuditForMe(true)` 是什么？），两个函数名才说得清。
 * 【绝不能反过来的地方】公共内容（首页/评论区/加号/注册页）必须继续用 enable ——
 *   游客和微信审核员恰恰就是"没有 Feeder 记录"的那批人。见 utils/auditGate.js 文件头。
 * @returns {Promise<Boolean>} true = 照常显示本页
 */
async function getAuditForMyPage() {
  const audit = await getAudit();
  try {
    await initUserState(); // 保证 state.isFeeder / state.isAdministrator 已就绪
  } catch (e) {
    console.error('读取用户状态失败（本页按不豁免处理）', e);
  }
  return auditGate.myPageOpen(audit, state.isFeeder, state.isAdministrator, state.registUnlocked);
}

/**
 * 临时开放注册入口 —— 未注册者在「关于」页连点五次走的就是这一条。
 * ============================================================
 * 【只有未注册的人会走到这里】已注册的人连点五次走的是 postApply 云函数的 selfEnable
 *   （写 `Feeder.enable`，并推一条通知到飞书申请群）。分流在 about.js 的 staffTap。
 * 【为什么是内存态、不落 storage 也不写库】
 *   ① 写不了库：未注册的人**没有 Feeder 文档** —— 那正是"未注册"的定义。
 *      （这也正是它不需要云函数的原因：没有任何东西需要服务端派生身份或鉴权。）
 *   ② 落 storage 会让它跨重启存活，与需求原话「**暂时**授权开放注册页面」相反。
 *   所以它是本机本次运行内的许可：小程序被销毁即失效。
 * 【它只开注册页，不开内容】见 utils/auditGate.js —— 公共内容走 auditOpen，
 *   那个函数根本不收这个开关。未注册者连点五次**不会**因此看见瀑布流和评论区。
 * 【注册成功之后它就没用了】isFeeder 变真，myPageOpen 本来就返回 true。
 */
function unlockRegist() {
  state.registUnlocked = true;
  console.log('[db.unlockRegist] 注册入口已临时开放（仅本次运行，关掉小程序即失效）');
}

/** 注册入口当前是否处于临时开放状态（供 about.js 提示文案判断，不要拿它当权限判断） */
function isRegistUnlocked() {
  return !!state.registUnlocked;
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
 * 把"本人已开通审核模式豁免"直接写进内存缓存 —— 连点五次成功后调用（about.js 的 grantSelfEnable）。
 * ============================================================
 * 【为什么不能用 resetUserState() 代替】它是一把大扫帚：清 `state.userId`（下次要重跑
 *   getInfo）、清 `administratorChecked` / `feederChecked`（下次要重查两张表）、
 *   清 `state.audit`（那是**全局**开关，跟"我开不开豁免"根本没关系）。
 *   于是紧接着的 switchTab 落到目标页时，闸门要**连着跑 4 次网络往返**才给出答案
 *   （getInfo → BITZHAdministrator → Feeder → Administrator），页面因此明显发钝。
 *   而这一次改动里**真正变的只有 Feeder.enable 一个字段** —— 身份没变、名册没变、
 *   全局开关没变。所以这里只写那一个字段。
 * 【为什么写内存比重新查库还准】这个值不是猜的：云函数刚回了 ok，库里的 enable 就是 true。
 *   重新查一遍库只是"再确认一次已知的事"，代价是 4 次往返。
 * 【和 resetUserState 的关系】不是替代品，是**精确版**。注册成功 / 换账号 / 改资料
 *   仍然必须用 resetUserState（那些场景连 userId 都可能变），别顺手改成这个。
 * 【如果 feederChecked 还是 false 会怎样】下次 initUserState 会照常查库，用库里的真值
 *   覆盖这里的 true —— 所以"还没查过就写 true"最坏也只是白写一次，不会留下假状态。
 */
function markSelfEnable() {
  state.enable = true;
  // userInfo 是整篇 Feeder 文档的快照，别只改 state.enable 让两处自相矛盾；
  // 但它可能还是 null（feederChecked 尚未跑过），那就别凭空造一个对象出来。
  if (state.userInfo) state.userInfo.enable = true;
  console.log('[db.markSelfEnable] state.enable = true（只改这一个字段，其余缓存未动）');
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
  // 漏了 enable 的后果和上面两条同类但方向相反：残留的 true 会让**下一个账号**
  // 也被判定为"已注册激活"，于是审核模式对他也失效 —— 而审核模式要挡的
  // 恰恰是没在本机注册过的人（游客 / 微信审核员）。
  state.enable = false;
  // 【这个清掉的语义和上面几条不同，值得单独说明】registUnlocked 不是"从库里读来的
  //   身份"，而是**上一个用户在本机点出来的许可**。换人之后这个许可不该继续有效 ——
  //   它是"某人在「关于」页连点五次"的结果，新来的人并没有点过。
  //   （它本来就是内存态，小程序重启自然也没了；这里是"同一次运行内换了身份"的那条口子。）
  state.registUnlocked = false;
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
  getAuditForMe: getAuditForMe,
  getAuditForMyPage: getAuditForMyPage,
  unlockRegist: unlockRegist,              // 未注册者连点五次：临时开注册入口（内存态）
  isRegistUnlocked: isRegistUnlocked,      // 只给 about.js 挑提示文案用，别当权限判断
  markSelfEnable: markSelfEnable,          // 已注册者连点五次成功后：精准写 state.enable（别用大扫帚清缓存）
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
