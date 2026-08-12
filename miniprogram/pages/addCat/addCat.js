// ============================================================
// pages/addCat/addCat.js —— 新增猫咪
// 【作用】管理员填写猫咪信息并上传照片（照片上传到腾讯云 COS），
//        提交后写入 BITZH 集合，首页即可看到。
//        表单选项 / 关键词生成 / 入库字段构建都来自 utils/catForm.js，
//        选图 / 上传 / 限频 / 特殊字符清洗来自 utils/media.js 等公共模块。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const cos = require('../../utils/cos.js'); // COS 图片上传/路径公共方法
const guard = require('../../utils/guard.js'); // 前端保险工具（文件名清洗/限频/限长）
const media = require('../../utils/media.js'); // 选图（相册/拍摄）公共方法
const catForm = require('../../utils/catForm.js'); // 猫咪表单公共方法
const relation = require('../../utils/relation.js'); // 猫猫关系公共逻辑（解析/反向配对/同步）
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）
const imgEditor = require('../../utils/imgEditor.js'); // 图片区交互（长按拖拽/单击预览/删除确认）
const draft = require('../../utils/draft.js'); // 编辑草稿自动保存/恢复（断网、卡退时找回内容）
const { formatTime } = require('../../utils/util.js'); // 统一时间格式化

// ============================================================
// 重名检测 / 恢复上次删除的数据：
// 新增猫时输入的名字若与"删除存档"（BITZHdelete）里的猫同名，
// 询问是否把上次删除的数据直接填回表单（类似编辑页的恢复逻辑）。
// 与 BITZH 在册猫同名则只做重名提示（提交时 checkName 仍硬拦截）。
// ============================================================
const DELETE_COLLECTION = 'BITZHdelete'; // 删除存档集合（删除整只猫前保存整只猫）
// 可恢复的字段（与下方表单一一对应；自动生成的 nickname/relatedCats、
// 图片数量 addPhotoNumber 不参与，照片需重新选择）
const RESTORE_FIELDS = [
  'name', 'appearance', 'classification', 'furColor', 'gender', 'status',
  'isSterilization', 'sterilizationTime', 'location', 'birthTime', 'character',
  'firstSightingTime', 'firstSightingLocation', 'missingTime', 'deliveryTime',
  'deathTime', 'deathReason', 'namereason', 'moreInformation', 'relationship',
];

Page({
  data: {
    cat: {
      status: '健康',
      classification: '其他',
      addPhotoNumber: 1,
      name: '',   // 给 relation-editor 空串默认，避免传 null 触发组件属性类型告警
      gender: '',
    },
    url: app.globalData.url,
    pickers: catForm.pickers, // 下拉框选项（与 editCat 共用一份）
    picker_selected: {},   // 记录每个下拉框选中的下标
    tempFileList: [],      // 选中的本地图片列表
    imgField: 'tempFileList', // 图片列表字段名（imgEditor 按此读写）
    imgTip: '长按拖动排序，单击预览', // 图片区提示文案
    drag: { active: false, index: -1, offsetX: 0, step: 190 }, // 拖拽状态（step=图宽180+间距10）
    delModal: { show: false, index: -1, noAsk: false }, // 删除图片确认弹窗
    relationList: [],     // 关系编辑器当前的关系数组 [{name, relation}]
    relationSyncTasks: [], // 待提交的同步任务（新增提交时才写入对方猫）
    nameDuplicate: '',    // 名字失焦后的重名提示（非空时显示）
    deletedRestoreTip: '', // 已把"上次删除的数据"填回表单的提示（非空时显示）
    deletedAsk: { show: false, name: '', time: '' }, // "发现同名删除记录"询问弹层（自定义弹层，不用 wx.showModal）
    draftImagesAsObjects: true, // 草稿图片写回时用对象格式 {tempFilePath}（新增页图片条用对象）
  },

  /** 页面加载：只有管理员可以新增猫咪 */
  async onLoad() {
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    // 草稿：记录本页草稿的"类型 + id"（新增页 id 用 userId，不同管理员不串档）
    const userInfo = app.globalData.userInfo || {};
    this._draftType = 'addCat';
    this._draftId = userInfo.userId || '';
    this._draftSaveNow = () => this.saveDraftNow();
    this.checkDraft(); // 有未完成的草稿 → 弹窗询问是否恢复
  },

  // ============ 草稿（自动保存 / 恢复，逻辑见 utils/draft.js） ============

  /** 页面加载后检查是否有未完成的草稿，有则询问是否恢复 */
  async checkDraft() {
    await draft.restore(this, this._draftType, this._draftId, {
      // 填回表单字段：合并到 cat，再重算下拉选中下标与昵称（派生字段不能直接存）
      fields: (page, fields) => {
        page.setData({ cat: Object.assign({}, page.data.cat, fields) });
        page.initPickerSelected();
        page.setnickname();
      },
      // 填回关系卡片与待同步任务（关系编辑器回显用）
      relation: (page, relationList, relationSyncTasks) => {
        page.setData({ relationList: relationList || [], relationSyncTasks: relationSyncTasks || [] });
      },
    });
  },

  /** 立即保存草稿（onHide/onUnload 兜底 + 防抖定时器到点时调用） */
  saveDraftNow() {
    if (this._draftCleared) return;
    draft.saveNow(this, this._draftType, this._draftId, this.data.cat, this.data.relationList, this.data.relationSyncTasks);
  },

  /** 页面被隐藏（切后台/去别的页）：把当前内容兜底保存成草稿 */
  onHide() { this.saveDraftNow(); },

  /** 页面被卸载（返回上一页）：同样兜底保存 */
  onUnload() { this.saveDraftNow(); },

  /** 选择日期 */
  bindDateChange(e) {
    const key = e.currentTarget.dataset.key;
    setField(this, 'cat.' + key, e.detail.value); // 动态字段名赋值
    draft.markDirty(this); // 内容变了 → 触发自动保存
  },

  /** 选择下拉框 */
  bindPickerChange(e) {
    const key = e.currentTarget.dataset.key;
    const index = e.detail.value;
    setField(this, 'cat.' + key, this.data.pickers[key][index]); // 动态字段名赋值
    this.setnickname();
    draft.markDirty(this);
  },

  /** 点击"确定提交" */
  upload() {
    wx.showModal({
      title: '提示',
      content: '确定添加猫吗？',
      success: (res) => {
        if (!res.confirm) return;
        if (this._submitting) return; // 防止异步流程中重复提交
        // 清洗猫名（会用作图片文件名），并做必填/长度校验
        const name = guard.sanitizeFileName(this.data.cat.name || '', 20);
        if (guard.isEmpty(name)) {
          wx.showToast({ icon: 'error', title: '请输入猫名' });
          return;
        }
        // 必须至少选一张照片，否则 addPhotoNumber 会算出 -1、封面缺失
        if (this.data.tempFileList.length === 0) {
          wx.showToast({ icon: 'error', title: '请至少选择一张照片' });
          return;
        }
        // 校验通过后才限频（防连点）：校验失败不消耗限频，改完即可立即重提
        if (!guard.throttle('addCat_submit', 1500)) return;
        this.setData({ 'cat.name': name });
        this._submitting = true;
        this.checkName();
      },
    });
  },

  /** 检查猫名是否已存在，不存在则上传图片并入库 */
  async checkName() {
    try {
      const found = await db.findOne('BITZH', { name: this.data.cat.name });
      if (found) {
        this._submitting = false;
        guard.resetThrottle('addCat_submit'); // 失败：改完名字可立即重提
        wx.showToast({ icon: 'error', title: '猫咪已存在' });
        return;
      }
      wx.showLoading({ title: '上传中...', mask: true });
      const ok = await this.uploadCatImages(); // 先把照片传到 COS
      wx.hideLoading();
      if (!ok) {
        this._submitting = false;
        guard.resetThrottle('addCat_submit'); // 上传失败：重试不等待
        return;
      }
      this.insertCat(); // 照片传完后再写入数据库
    } catch (err) {
      wx.hideLoading();
      this._submitting = false;
      guard.resetThrottle('addCat_submit'); // 异常失败：重试不等待
      console.error(err);
      wx.showToast({ icon: 'error', title: '操作失败' });
    }
  },

  /**
   * 上传猫咪照片到 COS：
   * 第 i 张图传到 main/images/{猫名}{i}.jpg，
   * 第一张同时作为首页列表的缩略图 main/images/{猫名}.png。
   * @returns {Promise<Boolean>} 是否全部上传成功
   */
  async uploadCatImages() {
    const name = this.data.cat.name;
    const files = this.data.tempFileList;
    // 图片区可能混有"本地新选的图"（wxfile:// 开头）和"恢复的旧照片"
    // （http 开头的存档地址）。本地图必须真正上传；恢复的旧照片本来就在
    // COS 上，直接"服务端复制"到新序号即可（不重新传图片数据，快得多）。
    // 本地/网络判断与 utils/cos.js 的 uploadList 保持一致。
    const isLocal = (p) => p.indexOf('wxfile://') === 0 || p.indexOf('http://tmp') === 0;
    const toUpload = []; // [{Key, FilePath}] 要真正上传的本地新图
    const toCopy = [];   // [{from, to}] 要服务端复制的网络旧图（含恢复的照片）
    files.forEach((f, i) => {
      const key = cos.catJpg(name, i);
      const p = f.tempFilePath;
      if (isLocal(p)) {
        toUpload.push({ Key: key, FilePath: p });
      } else {
        const src = cos.keyFromUrl(p); // 网络地址反推出源 key
        // 源已在该槽位 → 无需处理；能定位到源才复制，定位不到跳过该图不破坏数据
        if (src && src !== key) toCopy.push({ from: src, to: key });
      }
    });
    // 第一张图作为首页缩略图（已保证至少有一张）：
    // 本地图 → 上传成 {猫名}.png；恢复的网络图 → 从它所在的源文件复制成缩略图
    if (files.length > 0) {
      const first = files[0].tempFilePath;
      if (isLocal(first)) {
        toUpload.push({ Key: cos.catThumb(name), FilePath: first });
      } else {
        const src = cos.keyFromUrl(first);
        if (src && src !== cos.catThumb(name)) toCopy.push({ from: src, to: cos.catThumb(name) });
      }
    }
    // 先服务端复制（快、不耗流量），再上传本地新图（避免上传覆盖复制源）。
    // 复制失败的图说明源文件不存在（如恢复的存档图已被清理），该槽位会破图，
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
    // 本地图一张都没传 = 全部是恢复的旧照片，复制已在上一步完成
    if (successCount < toUpload.length) {
      wx.showModal({ title: '提示', content: '部分图片上传失败，请重试', showCancel: false });
      return false;
    }
    return true;
  },

  /** 写入 BITZH 集合 */
  async insertCat() {
    const name = this.data.cat.name;
    // 1. 自动补全"暂存关系"：扫描旧猫 relatedCats 里指向新猫名字的条目，
    //    把反向关系补到新猫自己身上（历史"未找到"关系的兜底）
    let inherited = [];
    try {
      inherited = await relation.collectInheritedRelations(name, this.data.cat.gender);
    } catch (err) {
      console.error('扫描暂存关系失败', err);
    }
    // 2. 构建文档：关系由编辑器维护，还原成 relatedCats；昵称需刷新（含相关猫名）
    const cat = Object.assign({}, this.data.cat);
    cat.relatedCats = relation.buildRelatedCats(this.data.relationList || []);
    if (inherited.length) {
      cat.relatedCats = relation.mergeRelations(cat.relatedCats, inherited);
    }
    cat.nickname = catForm.nickname(cat);
    const doc = catForm.buildDoc(cat, Math.max(0, this.data.tempFileList.length - 1));
    // 新猫也带一个照片版本号：万一这名字的猫以前存在过（已删除、照片留在 COS），
    // 上传的新图会覆盖同名 URL，版本号让 URL 变新，微信重新下载，不显示旧缓存图。
    doc.photoVer = Date.now();
    try {
      await db.insertOne('BITZH', doc);
      // 3. 双向同步：把关系同步到对方猫的页面
      try {
        await relation.applySyncTasks(this.data.relationSyncTasks || [], name);
      } catch (err) {
        console.error('同步关系失败', err);
      }
      draft.clearDraft(this, this._draftType, this._draftId); // 添加成功 → 清掉草稿
      this._submitting = false;
      wx.showToast({ icon: 'success', title: '操作成功' });
      if (inherited.length) {
        setTimeout(() => wx.showToast({ icon: 'none', title: '已自动关联 ' + inherited.length + ' 条旧关系' }), 600);
      }
      setTimeout(() => wx.reLaunch({ url: '/pages/catSearch/catSearch' }), 600);
    } catch (err) {
      wx.hideLoading();
      this._submitting = false;
      guard.resetThrottle('addCat_submit'); // 写库失败：重试不等待
      console.error(err);
      wx.showToast({ icon: 'error', title: '操作失败' });
    }
  },

  /** 关系编辑器回调：暂存最新关系数组与待同步任务（提交时才写对方猫） */
  onRelationChange(e) {
    const detail = e.detail || {};
    this.setData({
      relationList: detail.relations || [],
      relationSyncTasks: detail.syncTasks || [],
    });
    draft.markDirty(this); // 关系变了 → 触发自动保存
  },

  /** 输入框内容变化 */
  inputText(e) {
    const key = e.currentTarget.dataset.key;
    setField(this, 'cat.' + key, e.detail.value); // 动态字段名赋值
    if (key === 'name') {
      // 名字改动后清除旧重名提示 / 恢复提示，并允许重新询问"用上次删除的数据"
      this.setData({ nameDuplicate: '', deletedRestoreTip: '' });
      this._deletedAskedName = '';
      this._deletedRec = null;
    }
    this.setnickname();
    draft.markDirty(this); // 内容变了 → 触发自动保存
  },

  /** 自动生成搜索关键词（昵称，由各字段拼成） */
  setnickname() {
    setField(this, 'cat.nickname', catForm.nickname(this.data.cat));
  },

  /**
   * 名字输入框失焦（用户去操作别的地方）时检查同名猫，提前提醒。
   * 两件事：
   *   1. 在册同名猫 → 只提示，不拦截（提交时的 checkName 才是硬校验）；
   *   2. 无在册同名、但"删除存档"里有同名猫 → 询问是否用上次删除的数据。
   * 用序号防止旧查询覆盖新结果：名字又被改了就丢弃过期结果。
   */
  async onNameBlur() {
    const name = (this.data.cat.name || '').trim();
    if (!name) {
      this.setData({ nameDuplicate: '', deletedRestoreTip: '' });
      return;
    }
    this._nameCheckSeq = (this._nameCheckSeq || 0) + 1;
    const seq = this._nameCheckSeq;
    // 1. 在册同名猫：只提示
    try {
      const list = await db.find('BITZH', { name: name });
      if (seq !== this._nameCheckSeq) return; // 期间名字又变了，丢弃过期结果
      this.setData({
        nameDuplicate: list.length > 0 ? '已有 ' + list.length + ' 只猫叫「' + name + '」' : '',
      });
      if (list.length > 0) return; // 在册已有同名 → 按纯重名处理，不打扰恢复
    } catch (err) {
      console.error('重名检查失败', err);
      return;
    }
    // 2. 同名删除记录：询问是否用上次删除的数据（这个名字已问过就不再弹窗）
    if (name === this._deletedAskedName) return;
    try {
      const dlist = await db.find(
        DELETE_COLLECTION,
        { catName: name },
        { sort: { editTime: -1 }, limit: 5 }
      );
      if (seq !== this._nameCheckSeq) return; // 名字又变了，丢弃过期结果
      if (!dlist.length) return; // 无同名删除记录（BITZHdelete 不存在/无权限也静默跳过）
      this._deletedAskedName = name; // 记录已询问，避免每次失焦都弹窗
      this.askUseDeleted(dlist[0]);
    } catch (err) {
      console.error('查询删除记录失败', err);
    }
  },

  /** 根据猫咪当前值计算出每个下拉框应该显示的下标（恢复删除数据后回填用） */
  initPickerSelected() {
    this.setData({
      picker_selected: catForm.initPickerSelected(this.data.cat, this.data.pickers),
    });
  },

  /**
   * 询问是否用上次删除的数据（存在同名删除记录、且无在册同名时调用）。
   * 用页面内自定义弹层而非 wx.showModal——bindblur 瞬间调用系统弹窗
   * 在部分微信环境会被吞掉（实测同步/延后都不弹），自定义弹层靠 setData 渲染，稳定。
   */
  askUseDeleted(rec) {
    this._deletedRec = rec;
    const d = (rec && rec.data) || {};
    // 存档里有没有"当时的照片清单"：有 → 弹层里提示"含当时照片"，恢复时连照片一起填回
    const hasPhotos = !!(d.photoArchive && Array.isArray(d.photoKeys) && d.photoKeys.length);
    this.setData({
      deletedAsk: {
        show: true,
        name: this.data.cat.name || '',
        time: formatTime(rec.editTime),
        hasPhotos: hasPhotos,
      },
    });
  },

  /** 关闭"发现同名删除记录"弹层（忽略，不再问这个名） */
  hideDeletedAsk() {
    this.setData({ 'deletedAsk.show': false });
  },

  /** 确认"使用上次数据"：把上次删除的猫数据填回表单并关闭弹层 */
  async confirmDeletedAsk() {
    this.hideDeletedAsk();
    if (this._deletedRec) await this.applyDeletedData(this._deletedRec);
  },

  /** 把上次删除的猫数据填回表单（文本/下拉/日期字段 + 关系；有存档照片则一并填回） */
  async applyDeletedData(rec) {
    const data = rec.data || {};
    const patch = {};
    RESTORE_FIELDS.forEach((k) => {
      const v = data[k];
      // 历史存档缺字段/空值 → 空串；脏对象 → 归一化成字符串
      patch[k] = (v === undefined || v === null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
    });
    // 关系也一起恢复：把存档里的 relatedCats 字符串解析成关系卡片数组交给
    // relation-editor 回显（老存档没存 relatedCats 则保持空列表）
    const rawRelated = data.relatedCats;
    const relationList = (rawRelated === undefined || rawRelated === null)
      ? []
      : relation.parseRelatedCats(rawRelated);
    // 照片也一起恢复（如果有"当时的照片清单"）：把删除前的照片以网络地址追加到
    // 图片区 tempFileList 的末尾——用户自己先选的图保留在最前，恢复的旧照片排在
    // 后面（不替换），之后可拖动排序/删除。真正把照片从存档目录复制回
    // main/images/{猫名}{i}.jpg 的动作，放到提交时的 uploadCatImages 里做
    // （服务端复制，不重新传图）。老存档没存照片清单 → 保持"需重新选图"现状。
    let tempFileList = this.data.tempFileList || [];
    let restoredCount = 0;
    if (data.photoArchive && Array.isArray(data.photoKeys) && data.photoKeys.length) {
      // 跳过 .png 缩略图（不占图片槽位），只取照片本体 jpg0..n
      const urls = data.photoKeys.filter((k) => !/\.png$/.test(k));
      restoredCount = urls.length;
      // 优先用存档副本展示（最可靠）；存档文件不存在（老数据/当时复制失败）时
      // 退回原 key——删除时原图本就没删，直接展示原图位置也能看到删除前的照片
      const fallbackVer = Date.now(); // 回退到原 key 展示时带版本号，避免微信缓存旧图
      const restoredItems = await Promise.all(urls.map(async (k, i) => ({
        tempFilePath: (await cos.getETag(cos.archiveKey(data.photoArchive, k)))
          ? cos.archiveUrl(data.photoArchive, k)
          : cos.catUrl(data.name, i, fallbackVer),
      })));
      // 追加而不是替换：用户先选的图在最前（封面仍是用户那张），旧照片排后面
      tempFileList = tempFileList.concat(restoredItems);
    }
    this.setData({
      cat: Object.assign({}, this.data.cat, patch),
      relationList: relationList,
      tempFileList: tempFileList,
      nameDuplicate: '',
      deletedRestoreTip: '已填入上次删除的数据（' + formatTime(rec.editTime) + '）' +
        (restoredCount ? '，已追加 ' + restoredCount + ' 张旧照片在所选照片后面（可拖动调整）' : ''),
    });
    this.initPickerSelected(); // 下拉框回填选中下标
    this.setnickname();        // 昵称由各字段拼成，恢复后重新生成
    draft.markDirty(this);     // 恢复的"上次删除数据"也要纳入草稿自动保存
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
  /** 设为封面（移到第一位，第一张会成为首页缩略图） */
  onSetCover(e) {
    imgEditor.setCover(this, e);
    draft.markDirty(this); // 封面变化 → 顺序变了
  },
  noop() {},
});
