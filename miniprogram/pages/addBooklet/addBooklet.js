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
const media = require('../../utils/media.js'); // 选图（相册/拍摄）公共方法
const pageUtil = require('../../utils/page.js');
const { setField } = pageUtil; // 动态字段名的 setData（避免编译报错）
const imgEditor = require('../../utils/imgEditor.js'); // 图片区交互（长按拖拽/单击预览/删除确认）
const draft = require('../../utils/draft.js'); // 编辑草稿自动保存/恢复（断网、卡退时找回内容）

Page({
  data: {
    listData: {},      // 正在编辑的推文内容
    tempFileList: [],  // 选中的本地图片列表
    photoNum: 0,       // 照片张数
    imgField: 'tempFileList', // 图片列表字段名（imgEditor 按此读写）
    imgTip: '长按拖动排序，单击预览', // 图片区提示文案
    drag: { active: false, index: -1, offsetX: 0, step: 190 }, // 拖拽状态（step=图宽180+间距10）
    delModal: { show: false, index: -1, noAsk: false }, // 删除图片确认弹窗
    draftImagesAsObjects: true, // 草稿图片写回时用对象格式 {tempFilePath}（新增页图片条用对象）
    formErrors: {},              // 必填校验错误 {tittle: true}（未填时输入框变红）
    todayStr: '',                // 今天的日期（YYYY-MM-DD），用于拍摄时间 picker 的 end 上限
  },

  /** 页面加载：初始化用户状态，非注册用户禁止访问 */
  async onLoad() {
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

  /** 页面被卸载（返回上一页）：同样兜底保存 */
  onUnload() { this.saveDraftNow(); },

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

  /** 选择日期 */
  bindDateChange(e) {
    const key = e.currentTarget.dataset.key;
    setField(this, 'listData.' + key, e.detail.value); // 动态字段名赋值
    draft.markDirty(this);
  },

  /** 选择图片（相册/拍摄，统一处理权限与失败提示；达到 20 张上限拦截） */
  getphoto() {
    const left = imgEditor.remaining(this);
    if (left <= 0) {
      wx.showToast({ title: '最多 20 张', icon: 'none' });
      return;
    }
    // 选图是异步的，用 onChange 回调标记草稿"已变"，防抖保存才能看到刚加入的图
    media.chooseImages(this, 'tempFileList', left, false, () => draft.markDirty(this));
  },

  // ============ 图片区交互（共享逻辑见 utils/imgEditor.js） ============
  // 微信事件绑定只传事件对象 e，这里统一薄封装把页面实例 this 一并传入
  /** 长按开始 / 移动 / 结束（拖拽排序） */
  onImgTouchStart(e) { imgEditor.touchStart(this, e); },
  onImgTouchMove(e) { imgEditor.touchMove(this, e); },
  onImgTouchEnd(e) {
    imgEditor.touchEnd(this, e);
    draft.markDirty(this); // 拖拽结束可能改了排序 → 触发自动保存
  },
  /** 单击图片 → 微信原生预览 */
  onImgTap(e) { imgEditor.tap(this, e); },
  /** 删除图片：带确认框 + "下次不再询问" */
  onDelete(e) {
    imgEditor.onDelete(this, e);
    draft.markDirty(this);
  },
  delConfirm(e) {
    imgEditor.delConfirm(this, e);
    draft.markDirty(this); // 确认删除 → 图片列表变了
  },
  delCancel(e) { imgEditor.delCancel(this, e); },
  toggleNoAsk(e) { imgEditor.toggleNoAsk(this, e); },
  /** 设为封面（移到第一位） */
  onSetCover(e) {
    imgEditor.setCover(this, e);
    draft.markDirty(this); // 封面变化 → 顺序变了
  },
  noop() {},

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
    // 2) 话题输入框里未按回车/空格的残留文字 → 兜底转 chip（同步写回 relative）
    const editor = this.selectComponent && this.selectComponent('#topicEditor');
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
    // 确保生成的 commendId ≠ 0（0 是 falsy，会导致评论加载跳过）
    const commendId = Math.floor(Math.random() * 9999999999) + 1;
    db.insertOne('Page', {
      author: guard.toText(userInfo.nickName),
      authorId: userInfo.userId,
      authorImg: userInfo.avatarUrl,
      tittle: guard.toText(data.tittle),
      main: guard.toText(data.main),
      photoTime: guard.clampDate(data.photoTime), // 缺省/未来日期钳制到今天，保证排序字段不为空且不会在未来
      relative: guard.toText(data.relative),
      photoNum: this.data.photoNum, // 数字，不做文本兜底
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
