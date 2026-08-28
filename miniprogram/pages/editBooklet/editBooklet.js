// ============================================================
// pages/editBooklet/editBooklet.js —— 编辑 / 删除推文
// 【作用】管理员或作者本人可修改推文内容、增删照片、删除推文。
//        删除前会把推文存档到 Delete 集合，再删除 Page 记录和 COS 图片。
//        选图 / 上传 / 限频 / 特殊字符清洗来自公共模块。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const cos = require('../../utils/cos.js'); // COS 图片上传/删除/路径公共方法
const guard = require('../../utils/guard.js'); // 前端保险工具（文件名清洗/限频/限长）
const secCheck = require('../../utils/secCheck.js'); // 内容安全审核（写库前拦截）
const media = require('../../utils/media.js'); // 选图（相册/拍摄/聊天）公共方法
const photoTime = require('../../utils/photoTime.js'); // 上传图片自动识别拍摄时间（EXIF→文件名→修改时间）
const privacy = require('../../utils/privacy.js'); // 隐私授权通用拦截（选图/聊天记录选图前按需弹合规授权弹窗）
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）
const imgEditor = require('../../utils/imgEditor.js'); // 图片区交互（长按拖拽/单击预览/删除确认）
const draft = require('../../utils/draft.js'); // 编辑草稿自动保存/恢复（断网、卡退时找回内容）
const kbHeight = require('../../utils/kbHeight.js'); // 可靠键盘高度管理器（收起感知 + resetSoon 延迟清零）
const trash = require('../../utils/trash.js'); // 回收站存档字段兼容读取（恢复模式用）
const moderate = require('../../utils/moderate.js'); // 内容安全执行器（封锁/解封帖子，走云函数）
const { formatTime } = require('../../utils/util.js'); // 时间格式化（编辑时间展示）

// ============================================================
// 帖子存档/恢复：每次"修改"前把旧数据存档到 Pagechange 集合，
// "删除"前把整条推文存档到 Delete 集合（含照片快照）。
// 编辑页可一键恢复"上次数据"；删除后可在"帖子回收站"恢复。
// ============================================================
const CHANGE_COLLECTION = 'Pagechange'; // 修改存档集合（提交修改前保存旧数据）
const DELETE_COLLECTION = 'Delete';     // 删除存档集合（删除推文前保存整条推文）
// 存档的推文字段（提交/删除时从原始数据取出；与 addBooklet 写入 Page 的字段一致）
const RESTORE_FIELDS = [
  'tittle', 'main', 'photoTime', 'relative',
  'author', 'authorId', 'authorImg', 'commendId', 'good', 'pageTime', 'photoNum',
  'official', 'officialLogo', 'editBy', 'editTime', // 官方推文标记与编辑记录（存档/恢复原样保留）
];

Page({
  data: {
    url: app.globalData.url + 'page/', // 推文图片目录地址
    listData: {},         // 当前推文内容（onLoad 后回填）
    imageUrls: [],        // 当前推文的图片地址
    beforeTittle: '',     // 进入页面时的标题（用于判断是否改名）
    oldPhotoNum: 0,       // 进入页面时的照片数（用于清理被删图片）
    imgField: 'imageUrls', // 图片列表字段名（image-sorter 排序后按此写回）
    imgTip: '长按拖动排序，单击预览', // 图片区提示文案（显示在图片条上方）
    draftImagesAsObjects: false, // 草稿图片写回时用字符串格式（编辑页图片条用 URL 字符串）
    restoreAvailable: false,    // 是否有可恢复的"上次数据"（控制"恢复上次数据"按钮显示）
    recoverMode: false,         // 恢复模式：从 Delete 存档进入，保存=恢复推文，删除=彻底删除存档
    contentFocused: false,      // 图片区是否压缩（标题或正文任一聚焦即 true，见 syncContentFocused）
    titleFocus: false,          // 标题输入是否聚焦（与 editorFocus 独立跟踪，防"切输入框"时失焦/聚焦顺序不定导致布局误还原）
    editorFocus: false,         // 正文编辑器是否聚焦（同上）
    sorterModalOpen: false,     // image-sorter 删除确认弹窗是否打开（打开时禁用标题/正文输入，杜绝 iOS 点穿弹键盘）
    formErrors: {},              // 必填校验错误 {tittle: true}（未填时输入框变红）
    todayStr: '',                // 今天的日期（YYYY-MM-DD），用于拍摄时间 picker 的 end 上限
    isAdmin: false,              // 当前用户是否为管理员（控制「封锁/解封帖子」按钮显示）
    editTimeText: '',            // 官方推文编辑时间的展示文本（YYYY-MM-DD HH:mm），仅管理员编辑页可见
  },

  /** 页面加载：读取推文内容，并做权限检查；缺 _id 时兜底 */
  async onLoad(options) {
    guard.ensureNotBanned();
    await db.initUserState();
    this.setData({ todayStr: guard.todayString(), isAdmin: app.globalData.isAdministrator }); // 拍摄时间 picker 的"今天"上限
    // 拍摄时间自动识别：逐图日期缓存（不挂图片对象，草稿只存 tempFilePath）+ 覆盖规则标记。
    // 放在 onLoad 顶部：正常编辑 / 恢复模式 / 参数错误提前 return 各分支都先初始化到位。
    // 注意：编辑页已有 photoTime 是历史真实日期（非今天），canOverwrite 天然返回 false 不会覆盖。
    this._photoTimes = {};           // {path: {date, source}} 已识别结果，按 path 幂等
    this._photoTimeTouched = false;  // 用户手动改过拍摄时间 → 自动识别永不覆盖
    this._photoTimeAutoFilled = false; // 自动填写的值可被后续批次重算（保证多图多数为准）
    if (!options || !options._id) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    try {
      // 恢复模式：mode=recover 时 _id 是 Delete 存档 id，从存档载入内容（详见 loadRecover）
      if (options.mode === 'recover') {
        await this.loadRecover(options._id);
        return;
      }
      const data = await db.findOne('Page', { _id: options._id });
      if (!data) {
        wx.showToast({ title: '推文不存在', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      // 权限检查：只有管理员或作者本人可以进入（防止用链接直接打开修改别人的推文）。
      // 必须用刚查到的 data 判断——此时 listData 尚未回填，isEditor() 无参调用读到的 authorId 是 undefined
      if (!this.isEditor(data)) {
        wx.showToast({ title: '无权编辑', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      // 深拷一份"进入页面时的原始数据"：confirm() 提交时会改 tittle/图片顺序，
      // 存档（Pagechange / Delete）必须用改动前的版本，"恢复上次数据"才恢复得回
      this._originalPage = JSON.parse(JSON.stringify(data));
      this.setData({
        listData: data,
        beforeTittle: data.tittle,
        oldPhotoNum: data.photoNum || 0,
      });
      this.setPhoto();
      // 官方推文编辑记录：编辑人 / 编辑时间（仅管理员编辑页展示，见 editTimeText）
      this.setData({ editTimeText: data.editBy ? formatTime(data.editTime) : '' });
      // 草稿：编辑页草稿 id 用记录 _id（同一篇推文每次编辑共用一个草稿档）
      this._draftType = 'editBooklet';
      this._draftId = data._id;
      this._draftSaveNow = () => this.saveDraftNow();
      this.checkDraft(); // 有未完成的草稿 → 弹窗询问是否恢复
      this.checkRestoreAvailable(); // 查最近一次修改存档 → 控制"恢复上次数据"按钮
    } catch (e) {
      console.error(e);
    }
  },

  /** 恢复模式：从 Delete 存档载入内容进编辑页（回收站「恢复推文」入口）。
   *  用户可修改后保存（=恢复推文）、或彻底删除存档、或返回取消。
   *  权限：管理员、删除操作者、或原作者本人。 */
  async loadRecover(archiveId) {
    const rec = await db.findOne(DELETE_COLLECTION, { _id: archiveId });
    if (!rec) {
      wx.showToast({ title: '存档不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const uid = (app.globalData.userInfo || {}).userId;
    const recAuthorId = trash.pick(rec, 'authorId');
    const isOperator = rec.operatorId === uid;
    const isAuthor = recAuthorId === uid;
    if (!(app.globalData.isAdministrator || isOperator || isAuthor)) {
      wx.showToast({ title: '无权操作', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    // 组装表单数据（字段从存档取：新存档在 data 里、老存档在顶层）
    const data = {
      tittle: trash.pick(rec, 'tittle') || '',
      main: trash.pick(rec, 'main') || '',
      photoTime: trash.pick(rec, 'photoTime') || '',
      relative: trash.pick(rec, 'relative') || '',
      author: trash.pick(rec, 'author') || '',
      authorId: recAuthorId || '',
      authorImg: trash.pick(rec, 'authorImg') || '',
      commendId: trash.pick(rec, 'commendId') || '',
      good: trash.pick(rec, 'good') || 0,
      pageTime: trash.pick(rec, 'pageTime') || new Date(),
      photoNum: trash.pick(rec, 'photoNum') || 0,
      official: trash.pick(rec, 'official') || false,
      officialLogo: !!trash.pick(rec, 'officialLogo'),
      editBy: trash.pick(rec, 'editBy') || '',
      editTime: trash.pick(rec, 'editTime') || null,
    };
    // 图片区：用存档目录的 URL（保存时 reconcileImages 会服务端复制回正式 key）
    const photoArchive = trash.pick(rec, 'photoArchive');
    const photoKeys = Array.isArray(trash.pick(rec, 'photoKeys')) ? trash.pick(rec, 'photoKeys') : [];
    const imageUrls = [];
    if (data.officialLogo) imageUrls.push(cos.BUNDLED_LOGO); // 官方封面：包内 logo 首张，不上传
    if (photoArchive && photoKeys.length) {
      photoKeys.forEach((key) => imageUrls.push(cos.archiveUrl(photoArchive, key)));
    }
    this._recoverMode = true;
    this._recoverRec = rec;
    this.setData({
      recoverMode: true,
      listData: data,
      imageUrls: imageUrls,
      beforeTittle: data.tittle,
      oldPhotoNum: data.photoNum,
      editTimeText: data.editBy ? formatTime(data.editTime) : '',
      restoreAvailable: false, // 恢复模式下没有"恢复上次数据"（内容来源就是存档）
    });
    // 回填存档里持久化的逐图日期（老存档可能没有 photoDates，seed 会安全跳过）
    photoTime.seedPhotoDates(this, imageUrls, trash.pick(rec, 'photoDates'));
    // 草稿：恢复模式用存档 id 作草稿档，避免与"正常编辑同一篇"的草稿串档
    this._draftType = 'editBooklet';
    this._draftId = rec._id;
    this._draftSaveNow = () => this.saveDraftNow();
    this.checkDraft();
  },

  // ============ 草稿（自动保存 / 恢复，逻辑见 utils/draft.js） ============

  /** 页面加载后检查是否有未完成的草稿，有则询问是否恢复 */
  async checkDraft() {
    await draft.restore(this, this._draftType, this._draftId, {
      fields: (page, fields) => {
        // 把草稿里的表单字段合并回 listData（覆盖当前值）
        page.setData({ listData: Object.assign({}, page.data.listData, fields) });
      },
    });
  },

  /** 立即保存草稿（onHide/onUnload 兜底 + 防抖定时器到点时调用） */
  saveDraftNow() {
    if (this._draftCleared) return;
    draft.saveNow(this, this._draftType, this._draftId, this.data.listData);
  },

  /** 页面被隐藏（切后台/去别的页）：把当前内容兜底保存成草稿 */
  onHide() { this.saveDraftNow(); },

  /** 页面被卸载（返回上一页）：同样兜底保存。
   *  标记"已卸载"：自动识别拍摄时间是异步的，页面销毁后不再 setData（防对已卸载页面 setData 的警告）。 */
  onUnload() {
    this._photoUnloaded = true;
    this.saveDraftNow();
  },

  /** 当前用户是否有权编辑/删除这条推文（管理员或作者本人）。
   *  onLoad 时 listData 尚未回填，必须传入已查到的 data 判断作者；
   *  confirm()/deletePage() 无参调用时回退到 listData（此时已回填）。
   *  恢复模式下还放行"删除存档的操作者本人"（回收站里看到的就是自己删的）。 */
  isEditor(data) {
    const d = data || this.data.listData;
    const isAuthor = (app.globalData.userInfo || {}).userId === d.authorId;
    const isRecoverOperator = !!(this._recoverMode && this._recoverRec &&
      this._recoverRec.operatorId === (app.globalData.userInfo || {}).userId);
    return !!(app.globalData.isAdministrator || isAuthor || isRecoverOperator);
  },

  /** 生成推文当前的图片地址列表（图片名 = 标题 + 序号.jpg）。
   *  官方推文（officialLogo）：首张为包内 logo（不走 COS，不占 photoNum），其后是自有图。 */
  setPhoto() {
    const imageUrls = [];
    const data = this.data.listData;
    if (data.officialLogo) imageUrls.push(cos.BUNDLED_LOGO);
    const tittle = data.tittle;
    for (let i = 0; i < (data.photoNum || 0); i++) {
      imageUrls.push(cos.pageUrl(tittle, i));
    }
    // 回填发布记录里持久化的逐图日期（photoDates 与 imageUrls 一一对应）：
    // 编辑已有图也能参与权重判定（加图/切封面不丢封面的日期）
    photoTime.seedPhotoDates(this, imageUrls, data.photoDates);
    this.setData({ imageUrls });
  },

  /** 输入框内容变化 */
  inputText(e) {
    const key = e.currentTarget.dataset.key;
    setField(this, 'listData.' + key, e.detail.value); // 动态字段名赋值
    // 输入即清除该字段的报错红框（红框是"提交时未填"的错误态，改了就该消）
    if (this.data.formErrors && this.data.formErrors[key]) {
      const errs = Object.assign({}, this.data.formErrors);
      delete errs[key];
      this.setData({ formErrors: errs });
    }
    draft.markDirty(this); // 内容变了 → 触发自动保存
  },

  /** 内容编辑器变更（正文 + 话题合并）→ 写回 main 与 relative
   *  （relative 为规范串 "#话题 #话题"），并标记草稿已变。
   *  注意：main/relative 必须【一次 setData】写回——拆成两次会让组件 observers
   *  'main, relative' 拿到中间态（新 main + 旧 relative）→ 误重拼正文（跳字/话题移位）。 */
  onContentChange(e) {
    this.setData({
      'listData.main': e.detail.main,
      'listData.relative': e.detail.relative,
    });
    draft.markDirty(this);
  },

  /** 空白点击吞掉：标题行 title-row 用 catchtap 拦截，防止点标题冒泡到 onPageTap */
  noop() {},

  /** 标题聚焦：压缩图片区（标题也是输入行）；收起正文的话题建议，避免盖在拍摄时间上 */
  onTitleFocus() {
    const editor = this.selectComponent && this.selectComponent('#contentEditor');
    if (editor && typeof editor.collapseSuggest === 'function') editor.collapseSuggest();
    kbHeight.cancelResetSoon(); // 又聚焦输入框 = 键盘仍要弹，作废"切输入框"的延迟清零
    this.setData({ titleFocus: true });
    this.syncContentFocused();
  },

  /** 标题失焦：看正文是否仍聚焦，都不聚焦才还原图片区。
   *  键盘状态延迟 300ms 复位：切正文时键盘可能还弹着（其 onEditorFocus 会 cancelResetSoon），
   *  真失焦时键盘也随即收起，由 kbHeight 的 0 事件快速感知，这里只是兜底。 */
  onTitleBlur() {
    this.setData({ titleFocus: false });
    kbHeight.resetSoon(300);
    this.syncContentFocused();
  },

  /** 正文聚焦：压缩图片区 */
  onEditorFocus() {
    kbHeight.cancelResetSoon(); // 与标题同理：切回正文 = 键盘仍要弹
    this.setData({ editorFocus: true });
    this.syncContentFocused();
  },

  /** 正文失焦：看标题是否仍聚焦，都不聚焦才还原图片区。
   *  标题/正文两个独立聚焦标记推导 contentFocused，解决「从正文切到标题」时
   *  失焦与聚焦事件的先后顺序在不同平台不固定、把布局误还原成展开的问题。 */
  onEditorBlur() {
    this.setData({ editorFocus: false });
    this.syncContentFocused();
  },

  /** 根据标题/正文聚焦标记推导图片区是否压缩（任一聚焦即压缩，都失焦才还原）。
   *  聚焦 → 立即压缩（不等防抖）：iOS 正文→标题切换时 blur/focus 事件间隔可能超过 60ms，
   *  延迟压缩会在"blur 先到"的瞬间把 contentFocused 误置 false → 图片区先展开（卡片下移）
   *  再缩回（卡片上移），即"添加标题"几个字上→下→上抖动。聚焦立即压缩，天然消除这帧抖动。
   *  失焦 → 延迟 300ms 再展开：事件顺序各平台不定，留窗口等"切输入框"的聚焦跟上；
   *  窗口内新聚焦（聚焦分支 clearTimeout）取消展开。 */
  syncContentFocused() {
    const self = this;
    const focused = !!(this.data.titleFocus || this.data.editorFocus);
    if (focused) {
      clearTimeout(this._expandTimer);
      if (!this.data.contentFocused) this.setData({ contentFocused: true });
      return;
    }
    clearTimeout(this._expandTimer);
    this._expandTimer = setTimeout(function () {
      if (!self.data.titleFocus && !self.data.editorFocus && self.data.contentFocused) {
        self.setData({ contentFocused: false });
      }
    }, 300);
  },

  /** 点击输入区外部（图片区/拍摄时间/空白处等）→ 收起建议 + 收回聚焦还原图片区。
   *  内容编辑器内部（根节点 catchtap）与标题行（title-row catchtap）的点击不会冒泡到这里，
   *  所以只有点到输入区外才触发，不会太灵敏。 */
  onPageTap() {
    const editor = this.selectComponent && this.selectComponent('#contentEditor');
    if (editor) {
      if (typeof editor.collapseSuggest === 'function') editor.collapseSuggest();
      if (typeof editor.cancelBtnTap === 'function') editor.cancelBtnTap();
      if (typeof editor.blurMain === 'function') editor.blurMain();
    }
    this.setData({ titleFocus: false, editorFocus: false, contentFocused: false });
  },

  /** 选择日期（拍摄时间） */
  bindDateChange(e) {
    setField(this, 'listData.photoTime', e.detail.value); // 动态字段名赋值
    this._photoTimeTouched = true; // 手动改过拍摄时间 → 自动识别不再覆盖
    draft.markDirty(this);
  },

  /** 追加选择新图片（聊天记录 / 相机 / 相册 三项平铺，无二级选择），统一处理权限与失败提示；达到 20 张上限拦截。
   *  聊天记录能拿到原始文件名/发送时间，识别拍摄时间最准（工具不支持 chooseMessageFile，点了会提示，真机才有）。
   *  编辑页已有 COS 旧图读不到 EXIF、不参与投票；仅新增的本地新图参与识别。 */
  getphoto() {
    const left = imgEditor.remaining(this);
    if (left <= 0) {
      wx.showToast({ title: '最多 20 张', icon: 'none' });
      return;
    }
    // 按需求固定三项平铺顺序：选择聊天记录 → 相机 → 相册
    wx.showActionSheet({
      itemList: ['选择聊天记录', '相机', '相册'],
      success: (res) => {
        // 三个入口都是微信隐私接口（chooseMessageFile / chooseMedia），统一先做授权拦截：
        // 未授权先弹合规授权弹窗，同意后无缝继续；已授权直接继续。「暂不使用」则不继续。
        const mark = () => draft.markDirty(this); // 选图是异步的，用回调标记草稿"已变"
        if (res.tapIndex === 0) {
          // 聊天记录：原始文件名/发送时间 → 识别最准（真机才有，工具/PC 不支持会提示）
          privacy.guard(this, () => media.chooseImagesFromChat(this, 'imageUrls', left, true, mark,
            (items) => photoTime.recognizeAndFill(this, items)));
        } else if (res.tapIndex === 1) {
          // 相机：直接打开相机拍摄
          privacy.guard(this, () => media.chooseImages(this, 'imageUrls', left, true, mark, {
            sourceType: ['camera'],
            sizeType: ['original', 'compressed'],
            onTime: (items) => photoTime.recognizeAndFill(this, items),
          }));
        } else if (res.tapIndex === 2) {
          // 相册：强制原图（EXIF 必有，拍摄时间识别最准），识别后压缩成小图再上传（体积仍小）
          privacy.guard(this, () => media.chooseImages(this, 'imageUrls', left, true, mark, {
            sourceType: ['album'],
            sizeType: ['original'], // 微信相册「原图」默认选中且不可取消 → 一定有 EXIF
            onTime: (items) => photoTime.recognizeAndCompress(this, items),
          }));
        }
      },
      fail: () => {}, // 取消 actionSheet：静默
    });
  },

  // ============ 图片区（image-sorter 组件） ============
  /** 图片顺序/增删变化 → 把新数组写回页面字段（草稿自动保存读的是页面数组）；
   *  同时立即重算拍摄时间（加权：封面权重 1.5）——新增/删除/切换封面实时刷新 */
  onImgChange(e) {
    setField(this, this.data.imgField, e.detail.items);
    draft.markDirty(this); // 图片列表变了 → 触发自动保存
    photoTime.reaggregate(this);
  },

  /** image-sorter 删除确认弹窗开/关 → 弹窗打开时禁用/收回底层输入，杜绝 iOS 点击弹窗
   *  穿透唤醒底层 input/textarea 弹系统键盘（见 del-mask 的 catch 阻断） */
  onSorterModal(e) {
    const show = !!(e && e.detail && e.detail.show);
    const editor = this.selectComponent && this.selectComponent('#contentEditor');
    if (show && editor && typeof editor.blurMain === 'function') {
      editor.blurMain(); // 收回正文聚焦 + hideKeyboard（配合 disabled 彻底关键盘）
    }
    this.setData({ sorterModalOpen: show }); // 标题 input / 正文 textarea 同步 disabled
  },

  /** 点击"修改" */
  async confirm() {
    // 权限与 onLoad 保持一致：管理员或作者本人可操作
    if (!this.isEditor()) {
      wx.showToast({ title: '无权编辑', icon: 'none' });
      return;
    }
    if (this._submitting) return; // 防止异步流程中重复提交
    const data = this.data.listData;
    // 1) 必填校验：只校验标题（内容 / 话题已改为非必填）
    const errs = {};
    if (guard.isEmpty(data.tittle)) errs.tittle = true;
    if (Object.keys(errs).length) {
      this.setData({ formErrors: errs }); // 必填项未填 → 输入框变红
      wx.showToast({ title: '请填写带 * 的必填项', icon: 'none' });
      return; // 校验失败不消耗限频，改完可立即重提
    }
    // 2) 正文末尾未按回车/空格的残留 #话题 → 兜底转 chip（同步写回 relative）
    const editor = this.selectComponent && this.selectComponent('#contentEditor');
    if (editor && typeof editor.flush === 'function') editor.flush();
    // 3) 内容限长
    if (guard.tooLong(data.tittle, 30)) {
      wx.showToast({ title: '标题过长（30字以内）', icon: 'none' });
      return;
    }
    if (guard.tooLong(data.main, 2000)) {
      wx.showToast({ title: '正文过长（2000字以内）', icon: 'none' });
      return;
    }
    if (guard.tooLong(data.relative, 100)) {
      wx.showToast({ title: '话题过长（100字以内）', icon: 'none' });
      return;
    }
    // 4) 真正提交前才限频（防连点）：校验失败/长度失败不占用窗口，改完即可立即重提
    if (!guard.throttle('editBooklet_submit', 1500)) return;
    // 5) 标题会用作图片文件名，先清洗危险字符（已限长 30）
    const tittle = guard.sanitizeFileName(data.tittle, 30);
    this.setData({ 'listData.tittle': tittle });
    // 内容安全审核（写库前拦截，自带 loading）
    const _content = [tittle, data.main, data.relative].filter(Boolean).join(' ');
    const _passed = await secCheck.guardBeforePublish(_content, 3);
    if (!_passed) {
      guard.resetThrottle('editBooklet_submit'); // 拦截：改完可立即重提
      return;
    }
    this._submitting = true;
    wx.showLoading({ title: this._recoverMode ? '恢复中...' : '更新中...', mask: true });
    // 恢复模式：不做"编辑前快照"，直接重建 Page（恢复推文）+ 删除存档
    if (this._recoverMode) {
      this.recoverPage().catch(err => {
        wx.hideLoading();
        this._submitting = false;
        guard.resetThrottle('editBooklet_submit'); // 失败：改完可立即重提
        console.error(err);
        wx.showToast({ icon: 'error', title: '操作失败' });
      });
      return;
    }
    // 先给"本次编辑之前"的状态拍快照存档（Pagechange）。失败不阻断编辑——
    // 用户之后点"恢复上次数据"，恢复的就是这次编辑前的内容
    this.archiveCurrent('edit', this._originalPage).catch(err => console.error('存档编辑前状态失败', err))
      .then(() => this.syncImages())  // 再同步照片
      .then(() => this.updatePage())
      .then(() => wx.hideLoading())
      .catch((e) => {
        wx.hideLoading();
        this._submitting = false;
        guard.resetThrottle('editBooklet_submit'); // 失败：改完可立即重提
        console.error(e);
      });
  },

  /** 写入 Page 集合 */
  updatePage() {
    const data = this.data.listData;
    // 图片数：包内 logo 不占 COS、不计入 photoNum；官方推文才写 officialLogo/editBy/editTime
    const imageUrls = Array.isArray(this.data.imageUrls) ? this.data.imageUrls : [];
    const hasLogo = imageUrls.some((u) => cos.isBundledLogo(u));
    const ownCount = imageUrls.filter((u) => !cos.isBundledLogo(u)).length;
    const $set = {
      tittle: guard.toText(data.tittle),
      main: guard.toText(data.main),
      photoTime: guard.clampDate(data.photoTime), // 缺省/未来日期钳制到今天
      relative: guard.toText(data.relative),
      photoNum: ownCount, // 数字，不做文本兜底
      // 逐图日期数组（与编辑区当前图片顺序一一对应）：保存后再次编辑仍能回填逐图日期
      photoDates: photoTime.exportPhotoDates(this, imageUrls),
    };
    // 官方推文：保留 official 标记、按编辑区图片重算 officialLogo、记录编辑人/编辑时间。
    // 归属规则：标为官方即清掉个人 openid，author/authorImg 归属官方账号（与 addOfficial 一致）
    if (data.official || hasLogo) {
      $set.official = true;
      $set.officialLogo = hasLogo;
      $set.authorId = ''; // 官方推文不携带个人 openid
      $set.author = '北理珠关爱部';
      $set.authorImg = cos.BUNDLED_LOGO;
      if (app.globalData.isAdministrator) {
        $set.editBy = guard.toText(app.globalData.Administrator || (app.globalData.userInfo || {}).nickName || '');
        $set.editTime = new Date();
      }
    }
    return db.updateOne(
      'Page',
      { _id: data._id },
      { $set: $set }
    ).then(() => {
      this._submitting = false;
      draft.clearDraft(this, this._draftType, this._draftId); // 提交成功 → 清掉草稿
      wx.showToast({ icon: 'success', title: '操作成功' });
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600);
    }).catch((err) => {
      this._submitting = false;
      guard.resetThrottle('editBooklet_submit'); // 写库失败：改完可立即重提
      console.error(err);
      wx.showToast({ icon: 'error', title: '操作失败' });
    });
  },

  /** 恢复模式保存：把编辑后的内容重新写入 Page（即恢复推文），并删除 Delete 存档记录。
   *  照片从存档目录服务端复制回正式 key（改标题/排序都适用；新增本地图直接上传）。 */
  async recoverPage() {
    const data = this.data.listData;
    const tittle = guard.toText(data.tittle);
    try {
      // 同名在册推文拦截（与发布页/一键恢复一致），防止恢复出重复标题
      const exist = await db.findOne('Page', { tittle: tittle });
      if (exist) {
        wx.hideLoading();
        this._submitting = false;
        guard.resetThrottle('editBooklet_submit'); // 同名拦截：改标题可立即重提
        wx.showToast({ icon: 'none', title: '已存在同名推文，请修改标题' });
        return;
      }
      // 1) 照片：编辑区里的存档 URL → 服务端复制回正式 key；新增本地图直接上传。
      //    oldKeys 传空：恢复只做"新增/覆盖"，不做旧图清理，绝不多删。
      //    包内 logo 不走 COS：过滤掉后自有图按"跳过 logo 的序号"从 0 起对账
      const imageUrls = Array.isArray(this.data.imageUrls) ? this.data.imageUrls : [];
      const ownUrls = imageUrls.filter((u) => !cos.isBundledLogo(u));
      const hasLogo = imageUrls.length !== ownUrls.length;
      await cos.reconcileImages({
        imageUrls: ownUrls,
        newKey: (i) => cos.pageJpg(tittle, i),
        oldKeys: [],
        urlToKey: cos.keyFromUrl,
      });
      // 2) 重建 Page 记录（作者字段原值写回；commendId 缺失则新生成，评论丢失记录在案）
      const doc = {
        author: guard.toText(data.author || (app.globalData.userInfo || {}).nickName || ''),
        // 原值缺失时才兜底，且以登录态优先（防恢复操作把操作者/他人 openid 当原作者的错乱）
        authorId: data.authorId || app.globalData.userId || (app.globalData.userInfo || {}).userId || '',
        authorImg: data.authorImg || '',
        tittle: tittle,
        main: guard.toText(data.main),
        photoTime: guard.clampDate(data.photoTime),
        relative: guard.toText(data.relative),
        photoNum: ownUrls.length,
        // 逐图日期数组（与恢复后的图片顺序一一对应）：恢复进正式库后再次编辑仍能回填逐图日期
        photoDates: photoTime.exportPhotoDates(this, imageUrls),
        // 兜底生成 commendId，但不能为 0（falsy 会导致评论加载跳过）
        commendId: data.commendId != null ? data.commendId : (Math.floor(Math.random() * 9999999999) + 1),
        good: data.good || 0,
        pageTime: data.pageTime || new Date(),
      };
      // 官方推文：恢复时保留 official 标记与编辑人/编辑时间，并按编辑区图片重算 officialLogo。
      // 归属规则：官方推文不留个人 openid，author/authorImg 归属官方账号（与 addOfficial 一致）
      if (data.official || hasLogo) {
        doc.official = true;
        doc.officialLogo = hasLogo;
        doc.authorId = ''; // 官方推文不携带个人 openid
        doc.author = '北理珠关爱部';
        doc.authorImg = cos.BUNDLED_LOGO;
        if (data.editBy) doc.editBy = data.editBy;
        if (data.editTime) doc.editTime = data.editTime;
        if (app.globalData.isAdministrator) {
          doc.editBy = guard.toText(app.globalData.Administrator || (app.globalData.userInfo || {}).nickName || '');
          doc.editTime = new Date();
        }
      }
      await db.insertOne('Page', doc);
      // 3) 删除 Delete 存档记录（防止重复恢复）
      await db.deleteOne(DELETE_COLLECTION, { _id: this._recoverRec._id });
      cos.clearETagCache(); // 正式 key 内容被存档覆盖，清掉指纹缓存防"已有"误判
      this._submitting = false;
      draft.clearDraft(this, this._draftType, this._draftId); // 恢复成功 → 清掉草稿
      wx.hideLoading();
      wx.showToast({ icon: 'success', title: '已恢复' });
      setTimeout(() => wx.reLaunch({ url: '/pages/mydetail/mydetail?currentTab=0' }), 600);
    } catch (err) {
      wx.hideLoading();
      this._submitting = false;
      guard.resetThrottle('editBooklet_submit'); // 恢复失败：改完可立即重提
      console.error('恢复推文失败', err);
      wx.showToast({ icon: 'error', title: '恢复失败，请重试' });
    }
  },

  /**
   * 同步推文图片到 COS（目录 main/images/page/，改名 / 排序走服务端复制，不重传数据）：
   *  - 本地新增的图片 → 上传（只传真正新增的）
   *  - 已有网络图（改名或换顺序）→ COS 服务端复制到新序号/新标题
   *  - 被删的图 → 只删"旧记录存在、新列表不再引用"的文件，绝不多删、不误删
   */
  async syncImages() {
    const tittle = this.data.listData.tittle;
    const beforeTittle = this.data.beforeTittle;
    const oldCount = this.data.oldPhotoNum;
    // 包内 logo 不走 COS：对账前过滤掉（图片区里 logo 可能是首张或混在中间，
    // 过滤后自有图按"跳过 logo 的序号"从 0 起对账，保证 pageUrl(tittle,0..N-1) 命中）
    const imageUrls = this.data.imageUrls.filter((u) => !cos.isBundledLogo(u));

    const oldKeys = [];
    for (let i = 0; i < oldCount; i++) {
      oldKeys.push(cos.pageJpg(beforeTittle, i)); // 旧记录存在过的全部图片 key
    }

    return cos.reconcileImages({
      imageUrls: imageUrls,
      newKey: (i) => cos.pageJpg(tittle, i),
      oldKeys: oldKeys,
      urlToKey: cos.keyFromUrl,
    });
  },

  // ============ 帖子存档（编辑前 / 删除前快照，对齐猫侧 BITZHchange/BITZHdelete） ============

  /**
   * 把推文当前状态存档。
   * type='edit'   → 存 Pagechange（编辑前快照，"恢复上次数据"读它）
   * type='delete' → 存 Delete（删除前快照，帖子回收站读它）
   * 照片：内容与上次存档一致时只存指纹（省 COS 空间）；有变化 / 首次存档 / 删除时，
   * 把整套照片服务端复制到存档目录 main/images/archive/page/{pageId}/{时间戳}/。
   * 存档失败不阻断主流程（archiveSnapshot 内部已 catch），保证"文字永远存得上"。
   * @param {String} type       'edit' / 'delete'
   * @param {Object} dataSource 存档来源（用 onLoad 深拷的 _originalPage，提交前未改动）
   * @returns {Promise} db.insertOne 的结果
   */
  async archiveCurrent(type, dataSource) {
    const data = dataSource || this._originalPage || this.data.listData;
    const pageId = data._id;
    const tittle = data.tittle || '';
    // 存档记录主体：文本字段 + 重建所需全部字段（评论区/作者/点赞原样保留）
    const archiveData = {};
    RESTORE_FIELDS.forEach((k) => { archiveData[k] = data[k]; });
    // 照片 key 清单：图片名 = 标题 + 序号.jpg（0 起，共 photoNum 张）
    const photoKeys = [];
    const photoNum = archiveData.photoNum || 0;
    for (let i = 0; i < photoNum; i++) {
      photoKeys.push(cos.pageJpg(tittle, i));
    }
    // 每张照片的 ETag（内容指纹）：判断"照片是否变过"用
    const photoEtags = await Promise.all(photoKeys.map((k) => cos.getETag(k)));
    // 编辑且照片内容没变 → 只存指纹不复制副本（连续改文字不重复占空间）；
    // 删除存档始终完整复制（防同名新帖覆盖原图，必须留副本）
    let skipCopy = false;
    if (type === 'edit') {
      skipCopy = await this.photosUnchanged(pageId, photoKeys, photoEtags);
    }
    const rec = {
      pageId: pageId,
      pageTittle: tittle,
      type: type,
      data: archiveData,
      photoKeys: photoKeys,
      photoEtags: photoEtags,
      editTime: new Date(),
      operatorId: (app.globalData.userInfo || {}).userId,
      operatorName: (app.globalData.userInfo || {}).nickName,
    };
    if (!skipCopy) {
      const stamp = Date.now();
      rec.photoArchive = cos.archivePrefix('page/' + pageId, stamp);
      await cos.archiveSnapshot('page/' + pageId, stamp, photoKeys); // 失败不阻断存档
    }
    return db.insertOne(type === 'delete' ? DELETE_COLLECTION : CHANGE_COLLECTION, rec);
  },

  /**
   * 判断照片是否与最近一次编辑存档完全一致。
   * 同时比"图片 key 清单"和"ETag 指纹"：比 key 才能抓住"改标题"——标题一变
   * 图片 key 全变，改名后旧标题图会被 reconcileImages 删掉，必须存快照才能恢复；
   * 只比 ETag 会漏掉改名。无存档 / 读不到指纹 → 返回 false（安全方向，每次都存）。
   */
  async photosUnchanged(pageId, photoKeys, photoEtags) {
    try {
      const last = await db.findOne(
        CHANGE_COLLECTION,
        { pageId: pageId },
        { sort: { editTime: -1 }, limit: 1 }
      );
      if (!last || !Array.isArray(last.photoKeys) || !Array.isArray(last.photoEtags)) return false;
      return JSON.stringify(last.photoKeys) === JSON.stringify(photoKeys) &&
             JSON.stringify(last.photoEtags) === JSON.stringify(photoEtags);
    } catch (e) {
      return false; // 查询失败按"需要存档"处理，保证不丢照片
    }
  },

  // ============ 一键恢复上次数据（读取 Pagechange 编辑存档） ============

  /** 进入页面时静默预检：最近一次编辑存档有内容 → 显示"恢复上次数据"按钮 */
  async checkRestoreAvailable() {
    try {
      const last = await db.findOne(
        CHANGE_COLLECTION,
        { pageId: this.data.listData._id },
        { sort: { editTime: -1 }, limit: 1 }
      );
      if (last && last.data) {
        this._lastChange = last; // 缓存记录，restoreLast() 直接读，避免二次查询
        this.setData({ restoreAvailable: true });
      }
    } catch (err) {
      console.error('恢复预检失败（可能是 Pagechange 未创建或无权限）', err);
    }
  },

  /**
   * 一键恢复"上次数据"：最近一次编辑存档的文字回填到表单；
   * 若有照片快照，图片区换成存档照片（提交时 reconcileImages 自动把存档 URL
   * 复制回正式 key，"恢复即生效"）。帖子字段少，只做整体恢复，不做逐字段标红。
   */
  async restoreLast() {
    const d = this._lastChange;
    if (!d || !d.data) {
      wx.showToast({ title: '没有可恢复的数据', icon: 'none' });
      return;
    }
    const f = d.data;
    // 1) 文字回填（标题、正文、拍摄时间、话题；官方推文标记原样保留）
    this.setData({
      listData: Object.assign({}, this.data.listData, {
        tittle: f.tittle,
        main: f.main,
        photoTime: f.photoTime,
        relative: f.relative,
        official: f.official || false,
        officialLogo: !!f.officialLogo,
      }),
    });
    // 2) 照片回填：有照片快照则换成存档目录 URL；某张存档缺失（复制失败）时
    //    回退到正式 key 的 URL，保证图片区不出现破图。
    //    官方推文：首张为包内 logo（不上传），其后是存档里的自有图。
    //    无照片快照 → 保持当前图片区不动（原行为；官方推文的 logo 本就在 imageUrls 里）
    const urls = [];
    if (f.officialLogo) urls.push(cos.BUNDLED_LOGO);
    if (d.photoArchive && Array.isArray(d.photoKeys) && d.photoKeys.length) {
      for (let i = 0; i < d.photoKeys.length; i++) {
        const key = d.photoKeys[i];
        const archiveK = cos.archiveKey(d.photoArchive, key);
        const etag = await cos.getETag(archiveK); // 探测存档文件是否真存在
        urls.push(etag ? cos.archiveUrl(d.photoArchive, key) : cos.pageUrl(f.tittle, i));
      }
      this.setData({ imageUrls: urls });
    }
    draft.markDirty(this); // 恢复的内容也要继续自动保存
    wx.showToast({ title: '已恢复上次数据（提交后生效）', icon: 'none' });
  },

  /** 封锁 / 解封帖子（仅管理员）：软下架（hidden=true）或恢复可见。
   *  走 moderate 云函数（hiddenBy='admin'），取证留存、不物理删，区别于「删除推文」。
   *  仅在管理员从首页搜索到帖子长按进入时展示；恢复模式下无此操作。 */
  async toggleBlock() {
    if (!app.globalData.isAdministrator) {
      wx.showToast({ title: '无权操作', icon: 'none' });
      return;
    }
    if (this._blocking) return; // 防止异步流程中重复点击
    const _id = this.data.listData._id;
    const isHidden = !!this.data.listData.hidden;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: isHidden ? '解封帖子' : '封锁帖子',
        content: isHidden
          ? '将恢复该帖子，重新对所有人可见。'
          : '将下架该帖子（软删除，取证留存，可在复核中心恢复）。',
        confirmColor: isHidden ? '#07C160' : '#fa5151',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this._blocking = true;
    wx.showLoading({ title: isHidden ? '解封中...' : '封锁中...', mask: true });
    try {
      const r = isHidden
        ? await moderate.restore('page', _id)
        : await moderate.hide('page', _id);
      this._blocking = false;
      wx.hideLoading();
      if (r && r.ok === false) { // 云函数兜底返回 {ok:false}（不抛错），需显式判失败
        console.error('[editBooklet] 封锁/解封帖子失败', r.msg);
        wx.showToast({ icon: 'error', title: '操作失败' });
        return;
      }
      wx.showToast({ icon: 'success', title: isHidden ? '已解封' : '已封锁' });
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600);
    } catch (err) {
      this._blocking = false;
      wx.hideLoading();
      console.error('[editBooklet] 封锁/解封帖子失败', err);
      wx.showToast({ icon: 'error', title: '操作失败' });
    }
  },

  /** 删除推文（删除前把整条推文存档到 Delete 集合，含照片快照；不真删 COS 原图） */
  deletePage() {
    // 恢复模式：删除 = 彻底删除这条回收站存档（见 deleteArchive）
    if (this._recoverMode) {
      this.deleteArchive();
      return;
    }
    // 权限与 onLoad 保持一致：管理员或作者本人可操作
    if (!this.isEditor()) {
      wx.showToast({ title: '无权编辑', icon: 'none' });
      return;
    }
    // 前端限频（保险）：3 秒内只能删除一次
    if (!guard.throttle('deletePage', 3000)) return;
    if (this._deleting) return; // 防止异步流程中重复点击
    const _id = this.data.listData._id;
    wx.showModal({
      title: '提示',
      confirmColor: 'red',
      content: '确定删除吗？删除后可在"帖子回收站"恢复（保留文字和照片）。',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._deleting) return;
        this._deleting = true;
        wx.showLoading({ title: '删除中...', mask: true });
        try {
          // 1) 先把"删除前"的完整内容（含照片快照）存档到 Delete，删除后好恢复
          await this.archiveCurrent('delete', this._originalPage);
          // 2) 再删数据库记录。原图保留在 COS 正式 key，存档目录另有副本，
          //    即使同名新帖覆盖原图，回收站也能凭副本完整恢复
          await db.deleteOne('Page', { _id });
          cos.clearETagCache(); // 归档 ETag 缓存已无用，清掉避免误读
          draft.clearDraft(this, this._draftType, this._draftId); // 删除成功 → 清掉草稿
          wx.hideLoading();
          wx.showToast({ icon: 'success', title: '删除成功' });
          setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600);
        } catch (err) {
          wx.hideLoading();
          this._deleting = false;
          console.error('删除推文失败', err);
          // 存档失败则中止删除：宁可删不掉也不丢数据（对齐猫侧删除逻辑）
          wx.showToast({ icon: 'error', title: '删除失败，请重试' });
        }
      },
    });
  },

  /** 恢复模式：彻底删除这条删除存档（不恢复推文；存档目录照片副本保留为兜底） */
  deleteArchive() {
    if (this._deleting) return; // 防止异步流程中重复点击
    // 前端限频（保险）：3 秒内只能删除一次
    if (!guard.throttle('deletePage', 3000)) return;
    wx.showModal({
      title: '彻底删除',
      confirmColor: 'red',
      content: '将彻底删除这条回收站存档（无法再恢复），确定？',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._deleting) return;
        this._deleting = true;
        wx.showLoading({ title: '删除中...', mask: true });
        try {
          await db.deleteOne(DELETE_COLLECTION, { _id: this._recoverRec._id });
          cos.clearETagCache();
          draft.clearDraft(this, this._draftType, this._draftId); // 存档没了 → 草稿也清掉
          wx.hideLoading();
          wx.showToast({ icon: 'success', title: '已彻底删除' });
          setTimeout(() => wx.reLaunch({ url: '/pages/mydetail/mydetail?currentTab=1' }), 600);
        } catch (err) {
          wx.hideLoading();
          this._deleting = false;
          console.error('彻底删除存档失败', err);
          wx.showToast({ icon: 'error', title: '删除失败，请重试' });
        }
      },
    });
  },
});
