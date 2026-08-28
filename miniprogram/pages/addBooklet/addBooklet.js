// ============================================================
// pages/addBooklet/addBooklet.js —— 发布推文
// 【作用】写推文（标题、正文、拍摄时间、话题标签），
//        照片上传到 COS，提交后写入 Page 集合，出现在"小猫书"列表。
//        选图 / 上传 / 限频 / 特殊字符清洗来自公共模块。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const cos = require('../../utils/cos.js'); // COS 图片上传/路径公共方法
const guard = require('../../utils/guard.js'); // 前端保险工具（文件名清洗/限频/限长）
const secCheck = require('../../utils/secCheck.js'); // 内容安全审核（写库前拦截）
const media = require('../../utils/media.js'); // 选图（相册/拍摄/聊天）公共方法
const photoTime = require('../../utils/photoTime.js'); // 上传图片自动识别拍摄时间（EXIF→文件名→修改时间）
const privacy = require('../../utils/privacy.js'); // 隐私授权通用拦截（选图/聊天记录选图前按需弹合规授权弹窗）
const pageUtil = require('../../utils/page.js');
const { setField } = pageUtil; // 动态字段名的 setData（避免编译报错）
const imgEditor = require('../../utils/imgEditor.js'); // 图片区交互（长按拖拽/单击预览/删除确认）
const draft = require('../../utils/draft.js'); // 编辑草稿自动保存/恢复（断网、卡退时找回内容）
const kbHeight = require('../../utils/kbHeight.js'); // 可靠键盘高度管理器（收起感知 + resetSoon 延迟清零）

Page({
  data: {
    listData: {},      // 正在编辑的推文内容
    tempFileList: [],  // 选中的本地图片列表
    photoNum: 0,       // 照片张数
    imgField: 'tempFileList', // 图片列表字段名（image-sorter 排序后按此写回）
    imgTip: '长按拖动排序，单击预览', // 图片区提示文案（显示在图片条上方）
    draftImagesAsObjects: true, // 草稿图片写回时用对象格式 {tempFilePath}（新增页图片条用对象）
    formErrors: {},              // 必填校验错误 {tittle: true}（未填时输入框变红）
    contentFocused: false,      // 图片区是否压缩（标题或正文任一聚焦即 true，见 syncContentFocused）
    titleFocus: false,          // 标题输入是否聚焦（与 editorFocus 独立跟踪，防"切输入框"时失焦/聚焦顺序不定导致布局误还原）
    editorFocus: false,         // 正文编辑器是否聚焦（同上）
    sorterModalOpen: false,     // image-sorter 删除确认弹窗是否打开（打开时禁用标题/正文输入，杜绝 iOS 点穿弹键盘）
    todayStr: '',                // 今天的日期（YYYY-MM-DD），用于拍摄时间 picker 的 end 上限
  },

  /** 页面加载：初始化用户状态，非注册用户禁止访问 */
  async onLoad() {
    guard.ensureNotBanned();
    await db.initUserState();
    if (!app.globalData.isFeeder) {
      pageUtil.promptRegister(app.globalData.userId);
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    // 草稿：记录本页草稿的"类型 + id"（新增页 id 用 userId，同一用户不同次发布不串档）
    const userInfo = app.globalData.userInfo || {};
    this._draftType = 'addBooklet';
    this._draftId = userInfo.userId || '';
    this._draftSaveNow = () => this.saveDraftNow();
    // 拍摄时间：默认预填今天（提高填写率——用户不改也自动有值），并给 picker 提供"今天"上限；
    // 草稿恢复若有用户上次填的日期，会用草稿值覆盖这个默认值
    const today = guard.todayString();
    this.setData({ todayStr: today, 'listData.photoTime': this.data.listData.photoTime || today });
    // 拍摄时间自动识别：逐图日期缓存（不挂图片对象，草稿只存 tempFilePath）+ 覆盖规则标记
    this._photoTimes = {};           // {path: {date, source}} 已识别结果，按 path 幂等
    this._photoTimeTouched = false;  // 用户手动改过拍摄时间 → 自动识别永不覆盖
    this._photoTimeAutoFilled = false; // 自动填写的值可被后续批次重算（保证多图多数为准）
    this.checkDraft(); // 有未完成的草稿 → 弹窗询问是否恢复
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

  /** 选择日期 */
  bindDateChange(e) {
    const key = e.currentTarget.dataset.key;
    setField(this, 'listData.' + key, e.detail.value); // 动态字段名赋值
    if (key === 'photoTime') this._photoTimeTouched = true; // 手动改过拍摄时间 → 自动识别不再覆盖
    draft.markDirty(this);
  },

  /** 选择图片（聊天记录 / 相机 / 相册 三项平铺，无二级选择），统一处理权限与失败提示；达到 20 张上限拦截。
   *  聊天记录能拿到原始文件名/发送时间，识别拍摄时间最准（工具不支持 chooseMessageFile，点了会提示，真机才有）。 */
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
          privacy.guard(this, () => media.chooseImagesFromChat(this, 'tempFileList', left, false, mark,
            (items) => photoTime.recognizeAndFill(this, items)));
        } else if (res.tapIndex === 1) {
          // 相机：直接打开相机拍摄
          privacy.guard(this, () => media.chooseImages(this, 'tempFileList', left, false, mark, {
            sourceType: ['camera'],
            sizeType: ['original', 'compressed'],
            onTime: (items) => photoTime.recognizeAndFill(this, items),
          }));
        } else if (res.tapIndex === 2) {
          // 相册：强制原图（EXIF 必有，拍摄时间识别最准），识别后压缩成小图再上传（体积仍小）
          privacy.guard(this, () => media.chooseImages(this, 'tempFileList', left, false, mark, {
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

  /** 点击"发布"：先校验必填项 */
  confirm() {
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
    // 3) 内容限长（防止超长内容刷库）
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
    if (!guard.throttle('addBooklet_submit', 1500)) return;
    // 5) 标题会用作图片文件名，先清洗危险字符（已限长 30）
    const tittle = guard.sanitizeFileName(data.tittle, 30);
    this.setData({ 'listData.tittle': tittle });
    this._submitting = true;
    this.checkName();
  },

  /** 检查标题是否已存在，不存在则上传图片 */
  async checkName() {
    try {
      const found = await db.findOne('Page', { tittle: this.data.listData.tittle });
      if (found) {
        this._submitting = false;
        guard.resetThrottle('addBooklet_submit'); // 失败：改完标题可立即重提
        wx.showToast({ icon: 'error', title: '标题已存在' });
        return;
      }
      // 内容安全审核（写库前拦截，自带 loading）
      const _content = [this.data.listData.tittle, this.data.listData.main, this.data.listData.relative].filter(Boolean).join(' ');
      const _passed = await secCheck.guardBeforePublish(_content, 3);
      if (!_passed) {
        this._submitting = false;
        guard.resetThrottle('addBooklet_submit'); // 拦截：改完可立即重提
        return;
      }
      wx.showLoading({ title: '上传中...', mask: true });
      const ok = await this.uploadImages(); // 先上传照片
      wx.hideLoading();
      if (!ok) {
        this._submitting = false;
        guard.resetThrottle('addBooklet_submit'); // 上传失败：重试不等待
        return;
      }
      this.updatePage(); // 图片传完后再写数据库
    } catch (err) {
      wx.hideLoading();
      this._submitting = false;
      guard.resetThrottle('addBooklet_submit'); // 异常失败：重试不等待
      console.error(err);
      wx.showToast({ icon: 'error', title: '操作失败' });
    }
  },

  /**
   * 上传推文图片到 COS（目录 main/images/page/，图片名 = 标题 + 序号.jpg）。
   * 图片区可能混有"本地新选的图"（wxfile:// 开头）和"恢复的草稿/存档图"
   * （http 开头的地址）：本地图必须真正上传；草稿/存档图本来就在 COS 上，
   * 直接"服务端复制"到新序号即可（不重新传图片数据，快得多）。
   * @returns {Promise<Boolean>} 是否全部上传成功
   */
  async uploadImages() {
    const tittle = this.data.listData.tittle;
    const files = this.data.tempFileList;
    // 本地/网络判断与 utils/cos.js 的 uploadList 保持一致
    const isLocal = (p) => p.indexOf('wxfile://') === 0 || p.indexOf('http://tmp') === 0;
    const toUpload = []; // [{Key, FilePath}] 要真正上传的本地新图
    const toCopy = [];   // [{from, to}] 要服务端复制的网络旧图（含草稿/存档图）
    files.forEach((f, i) => {
      const key = cos.pageJpg(tittle, i);
      const p = f.tempFilePath;
      if (isLocal(p)) {
        toUpload.push({ Key: key, FilePath: p });
      } else {
        const src = cos.keyFromUrl(p); // 网络地址反推出源 key
        // 源已在该槽位 → 无需处理；能定位到源才复制，定位不到跳过该图不破坏数据
        if (src && src !== key) toCopy.push({ from: src, to: key });
      }
    });
    // 先服务端复制（快、不耗流量），再上传本地新图（避免上传覆盖复制源）。
    // 复制失败的图说明源文件不存在（如草稿/存档图已被清理），该槽位会破图，
    // 必须中止提交，不能带着空槽位入库
    if (toCopy.length) {
      const copyResults = await cos.copyList(toCopy);
      const copyFailed = copyResults.filter(function (r) { return !r.ok; });
      if (copyFailed.length > 0) {
        wx.showModal({ title: '提示', content: '部分图片源文件不存在，无法恢复，请移除后重试', showCancel: false });
        return false;
      }
    }
    const successCount = await cos.uploadList(toUpload);
    // 本地图一张都没传 = 全部是恢复的旧图，复制已在上一步完成
    if (successCount < toUpload.length) {
      wx.showModal({ title: '提示', content: '部分图片上传失败，请重试', showCancel: false });
      return false;
    }
    this.setData({ photoNum: files.length }); // 记录照片张数
    return true;
  },

  /** 写入 Page 集合 */
  updatePage() {
    const userInfo = app.globalData.userInfo || {};
    const data = this.data.listData;
    // 作者头像安全兜底：本地临时路径（wxfile:// / http://tmp）写进库里会立即失效（换设备/重启即破图），
    // 且会随推文扩散成脏数据。本地路径一律不写，自动兜底成 COS 地址（nickName 对应用户头像文件）。
    const rawAvatar = typeof userInfo.avatarUrl === 'string' ? userInfo.avatarUrl : '';
    const isLocalAvatar = rawAvatar.indexOf('wxfile://') === 0 || rawAvatar.indexOf('http://tmp') === 0;
    const authorImg = isLocalAvatar ? cos.profileUrl(userInfo.nickName) : rawAvatar;
    // 确保生成的 commendId ≠ 0（0 是 falsy，会导致评论加载跳过）
    const commendId = Math.floor(Math.random() * 9999999999) + 1;
    db.insertOne('Page', {
      author: guard.toText(userInfo.nickName),
      // authorId 以服务端登录态为准（防 Feeder 资料 userId 脏数据带错 openid），资料字段仅作兜底
      authorId: app.globalData.userId || userInfo.userId || '',
      authorImg,
      tittle: guard.toText(data.tittle),
      main: guard.toText(data.main),
      photoTime: guard.clampDate(data.photoTime), // 缺省/未来日期钳制到今天，保证排序字段不为空且不会在未来
      relative: guard.toText(data.relative),
      photoNum: this.data.photoNum, // 数字，不做文本兜底
      // 逐图日期数组（与落库图片顺序一一对应，photoDates[i] = 第 i 张的拍摄时间）：
      // 之后编辑这篇推文时按此回填逐图缓存，封面权重判定不再失效
      photoDates: photoTime.exportPhotoDates(this, this.data.tempFileList),
      commendId,
      good: 0,
      pageTime: new Date(),
    }).then(() => {
      this._submitting = false;
      draft.clearDraft(this, this._draftType, this._draftId); // 发布成功 → 清掉草稿
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600);
    }).catch((err) => {
      this._submitting = false;
      guard.resetThrottle('addBooklet_submit'); // 写库失败：重试不等待
      console.error(err);
      wx.showToast({ icon: 'error', title: '操作失败' });
    });
  },
});
