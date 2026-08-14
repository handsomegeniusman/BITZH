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
const media = require('../../utils/media.js'); // 选图（相册/拍摄）公共方法
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）
const imgEditor = require('../../utils/imgEditor.js'); // 图片区交互（长按拖拽/单击预览/删除确认）
const draft = require('../../utils/draft.js'); // 编辑草稿自动保存/恢复（断网、卡退时找回内容）
const trash = require('../../utils/trash.js'); // 回收站存档字段兼容读取（恢复模式用）
const moderate = require('../../utils/moderate.js'); // 内容安全执行器（封锁/解封帖子，走云函数）

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
    formErrors: {},              // 必填校验错误 {tittle: true}（未填时输入框变红）
    todayStr: '',                // 今天的日期（YYYY-MM-DD），用于拍摄时间 picker 的 end 上限
    isAdmin: false,              // 当前用户是否为管理员（控制「封锁/解封帖子」按钮显示）
  },

  /** 页面加载：读取推文内容，并做权限检查；缺 _id 时兜底 */
  async onLoad(options) {
    await db.initUserState();
    this.setData({ todayStr: guard.todayString(), isAdmin: app.globalData.isAdministrator }); // 拍摄时间 picker 的"今天"上限
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
    };
    // 图片区：用存档目录的 URL（保存时 reconcileImages 会服务端复制回正式 key）
    const photoArchive = trash.pick(rec, 'photoArchive');
    const photoKeys = Array.isArray(trash.pick(rec, 'photoKeys')) ? trash.pick(rec, 'photoKeys') : [];
    const imageUrls = [];
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
      restoreAvailable: false, // 恢复模式下没有"恢复上次数据"（内容来源就是存档）
    });
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

  /** 页面被卸载（返回上一页）：同样兜底保存 */
  onUnload() { this.saveDraftNow(); },

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

  /** 生成推文当前的图片地址列表（图片名 = 标题 + 序号.jpg） */
  setPhoto() {
    const imageUrls = [];
    const tittle = this.data.listData.tittle;
    for (let i = 0; i < this.data.listData.photoNum; i++) {
      imageUrls.push(cos.pageUrl(tittle, i));
    }
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

  /** 话题编辑器变更 → 写回 relative（规范串 "#话题 #话题"），并标记草稿已变 */
  onTopicChange(e) {
    setField(this, 'listData.relative', e.detail.value);
    draft.markDirty(this);
  },

  /** 点击编辑器外空白处 → 收起话题建议下拉（不挡下方拍摄时间选择器）。
   *  话题编辑器是自定义组件，内部点击不会冒泡到页面，所以只有点外部才触发，不会太灵敏。 */
  onPageTap() {
    const editor = this.selectComponent && this.selectComponent('#topicEditor');
    if (editor && typeof editor.collapseSuggest === 'function') editor.collapseSuggest();
  },

  /** 选择日期（拍摄时间） */
  bindDateChange(e) {
    setField(this, 'listData.photoTime', e.detail.value); // 动态字段名赋值
    draft.markDirty(this);
  },

  /** 追加选择新图片（相册/拍摄，统一处理权限与失败提示；达到 20 张上限拦截） */
  getphoto() {
    const left = imgEditor.remaining(this);
    if (left <= 0) {
      wx.showToast({ title: '最多 20 张', icon: 'none' });
      return;
    }
    // 选图是异步的，用 onChange 回调标记草稿"已变"，防抖保存才能看到刚加入的图
    media.chooseImages(this, 'imageUrls', left, true, () => draft.markDirty(this));
  },

  // ============ 图片区（image-sorter 组件） ============
  /** 图片顺序/增删变化 → 把新数组写回页面字段（草稿自动保存读的是页面数组） */
  onImgChange(e) {
    setField(this, this.data.imgField, e.detail.items);
    draft.markDirty(this); // 图片列表变了 → 触发自动保存
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
    // 2) 话题输入框里未按回车/空格的残留文字 → 兜底转 chip（同步写回 relative）
    const editor = this.selectComponent && this.selectComponent('#topicEditor');
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
    return db.updateOne(
      'Page',
      { _id: data._id },
      {
        $set: {
          tittle: guard.toText(data.tittle),
          main: guard.toText(data.main),
          photoTime: guard.clampDate(data.photoTime), // 缺省/未来日期钳制到今天
          relative: guard.toText(data.relative),
          photoNum: this.data.imageUrls.length, // 数字，不做文本兜底
        },
      }
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
      //    oldKeys 传空：恢复只做"新增/覆盖"，不做旧图清理，绝不多删
      await cos.reconcileImages({
        imageUrls: this.data.imageUrls,
        newKey: (i) => cos.pageJpg(tittle, i),
        oldKeys: [],
        urlToKey: cos.keyFromUrl,
      });
      // 2) 重建 Page 记录（作者字段原值写回；commendId 缺失则新生成，评论丢失记录在案）
      const doc = {
        author: guard.toText(data.author || (app.globalData.userInfo || {}).nickName || ''),
        authorId: data.authorId || (app.globalData.userInfo || {}).userId || '',
        authorImg: data.authorImg || '',
        tittle: tittle,
        main: guard.toText(data.main),
        photoTime: guard.clampDate(data.photoTime),
        relative: guard.toText(data.relative),
        photoNum: this.data.imageUrls.length,
        // 兜底生成 commendId，但不能为 0（falsy 会导致评论加载跳过）
        commendId: data.commendId != null ? data.commendId : (Math.floor(Math.random() * 9999999999) + 1),
        good: data.good || 0,
        pageTime: data.pageTime || new Date(),
      };
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
    const imageUrls = this.data.imageUrls;

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
    // 1) 文字回填（标题、正文、拍摄时间、话题）
    this.setData({
      listData: Object.assign({}, this.data.listData, {
        tittle: f.tittle,
        main: f.main,
        photoTime: f.photoTime,
        relative: f.relative,
      }),
    });
    // 2) 照片回填：有照片快照则换成存档目录 URL；某张存档缺失（复制失败）时
    //    回退到正式 key 的 URL，保证图片区不出现破图
    if (d.photoArchive && Array.isArray(d.photoKeys) && d.photoKeys.length) {
      const urls = [];
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
