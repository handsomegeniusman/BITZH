// ============================================================
// pages/editCat/editCat.js —— 编辑猫咪
// 【作用】管理员修改猫咪资料、增删照片、改名或删除整只猫咪。
//        照片同步逻辑：本地新图上传、改名时全部按新名字重传、
//        被删掉的多余图片从 COS 删除。
//        表单选项 / 关键词生成 / 入库字段构建来自 utils/catForm.js。
// ============================================================
const app = getApp();
const db = require('../../utils/db.js'); // 公共数据库方法
const cos = require('../../utils/cos.js'); // COS 图片上传/删除/路径公共方法
const guard = require('../../utils/guard.js'); // 前端保险工具（文件名清洗/限频/限长）
const media = require('../../utils/media.js'); // 选图（相册/拍摄）公共方法
const catForm = require('../../utils/catForm.js'); // 猫咪表单公共方法
const relation = require('../../utils/relation.js'); // 猫猫关系公共逻辑（解析/反向配对/同步）
const { setField } = require('../../utils/page.js'); // 动态字段名的 setData（避免编译报错）
const imgEditor = require('../../utils/imgEditor.js'); // 图片区交互（长按拖拽/单击预览/删除确认）
const draft = require('../../utils/draft.js'); // 编辑草稿自动保存/恢复（断网、卡退时找回内容）
const { formatTime } = require('../../utils/util.js'); // 统一时间格式化

// ============================================================
// 恢复上次数据：每次"修改"前把旧数据存档到 BITZHchange 集合，
// "删除整只猫"前把整只猫存档到 BITZHdelete 集合（分开管理）。
// 编辑页可一键调出最近一次修改存档，逐字段标红对比 / 恢复。
// ============================================================
const CHANGE_COLLECTION = 'BITZHchange'; // 修改存档集合（提交修改前保存旧数据）
const DELETE_COLLECTION = 'BITZHdelete'; // 删除存档集合（删除整只猫前保存整只猫）
// 可恢复的编辑字段（与下方 WXML 表单一一对应；自动生成的 nickname/relatedCats、
// 图片数量 addPhotoNumber 不参与恢复，照片由图片区单独管理）
const RESTORE_FIELDS = [
  'name', 'otherName', 'usedName', 'appearance', 'classification', 'furColor', 'gender', 'status',
  'isSterilization', 'sterilizationTime', 'location', 'birthTime', 'character',
  'firstSightingTime', 'firstSightingLocation', 'missingTime', 'deliveryTime',
  'deathTime', 'deathReason', 'namereason', 'moreInformation', 'relationship',
];
// 字段中文名（红框提示 / 提交确认弹窗标题用）
const FIELD_LABELS = {
  name: '名字', otherName: '别名/外号', usedName: '曾用名', appearance: '外貌',
  classification: '毛色分类', furColor: '毛色',
  gender: '性别', status: '状况', isSterilization: '绝育情况',
  sterilizationTime: '绝育时间', location: '出没地点', birthTime: '出生时间',
  character: '性格', firstSightingTime: '第一次目击时间',
  firstSightingLocation: '第一次被目击地点', missingTime: '失踪时间',
  deliveryTime: '送养时间', deathTime: '离世时间', deathReason: '离世原因',
  namereason: '名字来源', moreInformation: '更多', relationship: '关系',
  relatedCats: '相关猫咪关系',
};

/** 当前管理员显示名（存档 operatorName 也用这套） */
function currentEditorName() {
  return app.globalData.Administrator ||
    (app.globalData.userInfo && app.globalData.userInfo.nickName) || '';
}

Page({
  data: {
    cat: {
      status: '健康',
      gender: '未知',
      classification: '其他',
      name: '',   // 给 relation-editor 空串默认，避免首次渲染传 null 触发属性类型告警
    },
    url: app.globalData.url,
    pickers: catForm.pickers, // 下拉框选项（与 addCat 共用一份）
    picker_selected: {},  // 每个下拉框当前选中的下标
    imageUrls: [],        // 当前猫咪的图片地址（网络地址或本地临时文件）
    beforeName: '',       // 进入页面时的猫咪名（用于判断是否改名）
    oldPhotoNum: 0,       // 进入页面时的照片数（用于清理被删图片）
    changName: false,     // 猫咪名字是否被修改过
    imgField: 'imageUrls', // 图片列表字段名（imgEditor 按此读写）
    imgTip: '长按拖动排序，单击预览', // 图片区提示文案
    relationList: [],     // 关系编辑器当前的关系数组 [{name, relation}]
    relationSyncTasks: [], // 待提交的同步任务（编辑页面提交时才写入对方猫）
    restoreOld: {},       // 恢复数据：key -> 上一次的值（用于红框显示；空值显示为"（空）"）
    restoreValue: {},     // 恢复数据：key -> 上一次的真实值（点击红框时用它写回表单，含空串）
    restoreApplied: {},   // 恢复数据：key -> true（已点击红框应用旧值）
    restoreVisible: false, // 是否已调出恢复数据（控制"全部使用上次数据"按钮显示）
    restoreAvailable: false, // 进入页面时是否检测到可恢复的历史（控制"恢复上次数据"按钮显示）
    lastEditor: '',       // 该猫上次编辑人（BITZH.lastEditAdministrator，缺省用最近存档补全）
    restoreEditor: '',    // 恢复对象（最近一次修改存档）的编辑人
    restoreTime: '',      // 恢复对象（最近一次修改存档）的时间
    nameDuplicate: '',    // 名字失焦后的重名提示（非空时显示）
    historyShow: false,   // "历史照片"弹层是否显示
    historyList: [],      // 历史照片版本列表 [{time, operator, photos:[{url,src,i}]}]
    draftImagesAsObjects: false, // 草稿图片写回时用字符串格式（编辑页图片条用 URL 字符串）
    formErrors: {},       // 必填校验错误 {name: true, photo: true}（未填时输入框/图片区变红，仿 editBooklet）
  },

  /** 页面加载：只有管理员可以编辑猫咪；缺 _id 时兜底，避免误编辑随机记录 */
  async onLoad(options) {
    await db.initUserState();
    if (!guard.requireAdmin()) return;
    if (!options || !options._id) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    try {
      const raw = await db.findOne('BITZH', { _id: options._id });
      if (!raw) {
        wx.showToast({ title: '未找到该猫咪', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      // 历史脏数据兜底：个别文本字段可能被存成对象（显示 [object Object]），
      // 加载时转成字符串，保存时即可修正回数据库
      const cat = catForm.normalizeTextFields(raw);
      // 深拷贝：_originalCat 和 data.cat 必须独立，否则编辑时 _originalCat 被联动修改 → 存档数据不准确
      this._originalCat = JSON.parse(JSON.stringify(cat));
      this.setData({
        cat,
        beforeName: cat.name,
        oldPhotoNum: cat.addPhotoNumber || 0,
        relationList: relation.parseRelatedCats(cat.relatedCats),
        restoreOld: {},       // 每次进入页面清空恢复数据
        restoreValue: {},
        restoreApplied: {},
        restoreVisible: false,
        lastEditor: cat.lastEditAdministrator || '', // 该猫上次编辑人
      });
      this.setPhoto();
      // 记录"进页面时的照片列表"：提交时如果照片动了（增/删/排序/插历史图），
      // 就刷新照片版本号 photoVer，让首页/详情重新下载图片（具体逻辑见 buildCatData）
      this._originalUrls = this.data.imageUrls.slice();
      this.initPickerSelected();
      // 进入页面即静默检测该猫是否有可恢复的修改历史：
      // 有 → 显示"恢复上次数据"按钮；无/集合不存在 → 不显示（检测失败静默，不打扰）
      this.checkRestoreAvailable();
      // 草稿：编辑页草稿 id 用记录 _id（同一只猫每次编辑共用一个草稿档）
      this._draftType = 'editCat';
      this._draftId = raw._id;
      this._draftSaveNow = () => this.saveDraftNow();
      this.checkDraft(); // 有未完成的草稿 → 弹窗询问是否恢复
    } catch (err) {
      console.error(err);
    }
  },

  // ============ 草稿（自动保存 / 恢复，逻辑见 utils/draft.js） ============

  /** 页面加载后检查是否有未完成的草稿，有则询问是否恢复 */
  async checkDraft() {
    const ok = await draft.restore(this, this._draftType, this._draftId, {
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
    console.log('[editCat.checkDraft] 恢复结果=' + ok + ' imageUrls=' + this.data.imageUrls.length +
      ' 首张=' + (this.data.imageUrls[0] ? String(this.data.imageUrls[0]).slice(0, 80) : '(空)'));
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

  /** 生成猫咪当前的照片地址列表（照片名 = 猫名 + 序号.jpg） */
  setPhoto() {
    const num = this.data.cat.addPhotoNumber;
    if (typeof num !== 'number' || num < 0) return; // 旧数据无照片数时不出图
    const imageUrls = [];
    // 带上照片版本号 photoVer：照片内容变过的话 URL 也变新，编辑页就不会再显示旧缓存图。
    // 版本号只影响展示——同步照片时 keyFromUrl 会自动剥掉 ?v=，不影响改名/排序逻辑。
    for (let i = 0; i <= num; i++) {
      imageUrls.push(cos.catUrl(this.data.cat.name, i, this.data.cat.photoVer));
    }
    this.setData({ imageUrls });
  },

  /** 根据猫咪当前值计算出每个下拉框应该显示的下标 */
  initPickerSelected() {
    this.setData({
      picker_selected: catForm.initPickerSelected(this.data.cat, this.data.pickers),
    });
  },

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

  /** 必填校验：名字 + 至少一张照片，未填 → 标红并滚到页面顶部（两个必填项都在最上方） */
  validateRequired() {
    const errs = {};
    // 清洗猫名（会用作图片文件名）后再判空：全非法字符（如 ***）也算没填
    if (guard.isEmpty(guard.sanitizeFileName(this.data.cat.name || '', 20))) errs.name = true;
    if (!this.data.imageUrls.length) errs.photo = true;
    return errs;
  },

  /** 输入/改动后清除该字段的必填报错（红框是"提交时未填"的错误态，改了就该消） */
  clearFieldError(key) {
    const errs = Object.assign({}, this.data.formErrors);
    delete errs[key];
    this.setData({ formErrors: errs });
  },

  /** 点击"确定提交" */
  upload() {
    if (this._submitting) return; // 防止异步流程中重复提交
    // 必填校验（仿 editBooklet）：名字 + 至少一张照片
    const errs = this.validateRequired();
    if (Object.keys(errs).length) {
      this.setData({ formErrors: errs }); // 必填项未填 → 输入框/图片区变红
      wx.showToast({ icon: 'none', title: '请先填写必填项' });
      wx.pageScrollTo({ scrollTop: 0, duration: 300 }); // 必填项都在最上方，滚回去
      return;
    }
    // 清洗猫名（会用作图片文件名），sanitize 已限长 20
    const name = guard.sanitizeFileName(this.data.cat.name || '', 20);
    this.setData({ 'cat.name': name });
    // 有尚未处理的"上次数据"差异字段 → 先逐项确认用旧的还是保留本次
    const pending = this.pendingRestoreKeys();
    if (pending.length) {
      this.askRestoreChoices(0, pending);
      return;
    }
    this.showSubmitConfirm();
  },

  /** 逐项询问未处理的差异字段（用上次的 / 保留本次），全部确认后进入最终提交 */
  askRestoreChoices(i, pending) {
    if (i >= pending.length) {
      this.showSubmitConfirm();
      return;
    }
    const key = pending[i];
    const oldV = this.data.restoreValue[key]; // 真实值（可能为空串），用于写回与展示
    // 关系的"当前值"由 relationList 动态生成（cat.relatedCats 是进页面时的旧串，不代表编辑中状态）
    const curV = key === 'relatedCats'
      ? relation.buildRelatedCats(this.data.relationList || [])
      : this.data.cat[key];
    wx.showModal({
      title: FIELD_LABELS[key],
      content: '上次：' + (oldV || '（空）') + '\n本次：' + (curV || '（空）'),
      confirmText: '用上次的',
      cancelText: '保留本次',
      success: (res) => {
        if (res.confirm) this.applyRestoreValue(key, oldV); // 应用旧值
        this.askRestoreChoices(i + 1, pending);
      },
    });
  },

  /** 最终确认弹窗并提交：先存档"修改前"状态，再更新记录 */
  showSubmitConfirm() {
    if (this._confirming) return; // 弹窗已打开：忽略连点，避免叠弹窗
    this._confirming = true;
    wx.showModal({
      title: '提示',
      content: '确定提交吗？',
      success: (res) => {
        this._confirming = false;
        if (!res.confirm) return; // 取消：不消耗限频，可立即重新提交
        if (this._submitting) return; // 防止异步流程中重复提交
        // 真正要提交才限频（防连点）：校验/取消都不占用限频窗口
        if (!guard.throttle('editCat_submit', 1500)) return;
        this._submitting = true;
        wx.showLoading({ title: '更新中...', mask: true });
        // 先把"修改前"的猫咪状态存档到 BITZHchange（存档失败不阻断提交）
        this.archiveCurrent('edit', this._originalCat)
          .then(() => this.syncImages()) // 1) 先同步照片到 COS（失败则 DB 未动，不产生破图）
          .then(() => db.updateOne(       // 2) 照片就位后再写数据库
            'BITZH',
            { _id: this.data.cat._id },
            { $set: this.buildCatData() }
          ))
          .then(async () => {
            // 猫改名：同步更新所有相关推文的 relative 字段（旧名 → 新名），
            // 保证改名后 catDetail 的推文列表不丢失关联
            const newName = this.data.cat.name;
            let renamed = { renamed: 0, inherited: 0 };
            if (this.data.beforeName && this.data.beforeName !== newName) {
              try {
                await this.updatePageRelative(this.data.beforeName, newName);
              } catch (err) {
                console.error('同步推文关联失败', err);
              }
              // 同步其他猫 relatedCats 里的旧名 → 新名，保持关系图一致（含昵称刷新）。
              // 同时补全反向关系：暂存了"新名字"的猫（改名后新名字才存在）此前只有
              // 单向关联，改名时把反向关系合并进被改名猫，避免"我能关联它、它关联不到我"
              try {
                renamed = await relation.renameCat(this.data.beforeName, newName, this.data.cat.gender);
              } catch (err) {
                console.error('同步关系引用旧名→新名失败', err);
              }
            }
            // 双向同步：把关系同步到对方猫的页面（只读对方、按需写入）
            let synced = 0;
            try {
              synced = await relation.applySyncTasks(this.data.relationSyncTasks, this.data.cat.name);
            } catch (err) {
              console.error('同步关系失败', err);
            }
            cos.clearETagCache(); // 照片 key 内容已更新，清掉 ETag 缓存防"已有"误判
            draft.clearDraft(this, this._draftType, this._draftId); // 提交成功 → 清掉草稿
            wx.hideLoading();
            this._submitting = false;
            wx.showToast({ icon: 'success', title: '操作成功' });
            // 自动关联结果提示：改名补全的反向关系 + 同步到对方的猫数
            const autoCount = renamed.inherited + synced;
            if (autoCount > 0) {
              setTimeout(() => wx.showToast({ icon: 'none', title: '已自动关联 ' + autoCount + ' 只猫的关系' }), 400);
              setTimeout(() => wx.reLaunch({ url: '/pages/catSearch/catSearch' }), 1600);
            } else {
              setTimeout(() => wx.reLaunch({ url: '/pages/catSearch/catSearch' }), 600);
            }
          }).catch((err) => {
            cos.clearETagCache(); // 即使失败，照片 key 也可能被部分覆盖，缓存一律清掉
            wx.hideLoading();
            this._submitting = false;
            guard.resetThrottle('editCat_submit'); // 提交失败：改完可立即重提
            console.error(err);
            wx.showToast({ icon: 'error', title: '操作失败' });
          });
      },
      fail: () => { this._confirming = false; }, // 弹窗异常关闭也解锁，避免卡死
    });
  },

  /**
   * 把 dataSource（修改/删除前的猫咪状态）存档。
   * 修改记录存 BITZHchange，删除记录存 BITZHdelete，分开管理。
   * 存档失败只记日志，不阻断提交/删除主流程。
   * @param {String} type       'edit' 修改前存档 / 'delete' 删除前存档
   * @param {Object} dataSource 存档来源（用 onLoad 时的原始值 this._originalCat）
   */
  async archiveCurrent(type, dataSource) {
    try {
      if (!dataSource) return true;
      const data = {};
      RESTORE_FIELDS.forEach((k) => { data[k] = dataSource[k]; });
      data.addPhotoNumber = dataSource.addPhotoNumber;
      // 关系也一起存档：恢复时填回关系编辑器（老存档没存这字段，恢复时关系保持空列表）
      data.relatedCats = dataSource.relatedCats;
      // 照片也一起存档：记下当时照片的 key 清单，并把整套照片服务端复制到
      // 存档目录 main/images/archive/{catId}/{时间戳}/。此处在 syncImages
      // 删/覆盖旧图之前执行，之后即使原图被覆盖/删除，历史版本照片也永久可恢复。
      const photoKeys = [];
      if (dataSource.name && typeof dataSource.addPhotoNumber === 'number' && dataSource.addPhotoNumber >= 0) {
        for (let i = 0; i <= dataSource.addPhotoNumber; i++) {
          photoKeys.push(cos.catJpg(dataSource.name, i));
        }
        photoKeys.push(cos.catThumb(dataSource.name));
      }
      if (photoKeys.length) {
        // 每张照片的 ETag（内容指纹）：历史照片加载时据此去重，也用来判断照片是否变过。
        // 注意必须按"内容"判变，不能按 key——同一数量下换图（删 A 加 B）key 清单不变，
        // 按 key 比对会误判成"没变"而漏掉存档。
        const photoEtags = await Promise.all(photoKeys.map((k) => cos.getETag(k)));
        // 照片内容没变过（与最近一次存档的照片指纹一致）就不重复复制存档目录，
        // 只改文字/换顺序都算"没变"，避免整套复制占存储；编辑记录仍会写（文字恢复用）。
        // 删除存档始终完整复制：删除时照片要防后续同名猫覆盖，必须留副本。
        let skipCopy = false;
        if (type === 'edit') {
          skipCopy = await this.photosUnchanged(dataSource._id, photoEtags);
        }
        if (!skipCopy) {
          const photoStamp = Date.now();
          data.photoKeys = photoKeys;
          data.photoArchive = cos.archivePrefix(dataSource._id, photoStamp);
          data.photoEtags = photoEtags;
          await cos.archiveSnapshot(dataSource._id, photoStamp, photoKeys); // 失败不阻断存档
        } else {
          // 照片没变：只存指纹不复制，让下一次"照片没变"判断能连续命中（连续文字编辑都不再复制）
          data.photoEtags = photoEtags;
        }
      }
      const userId = await db.getUserId();
      const coll = type === 'delete' ? DELETE_COLLECTION : CHANGE_COLLECTION;
      await db.insertOne(coll, {
        catId: dataSource._id,
        catName: dataSource.name,
        type: type,
        data: data,
        editTime: new Date(),
        operatorId: userId,
        operatorName: app.globalData.Administrator ||
          (app.globalData.userInfo && app.globalData.userInfo.nickName) || '',
      });
      return true;
    } catch (err) {
      console.error('存档失败（' + (type === 'delete' ? 'BITZHdelete' : 'BITZHchange') + '）', err);
      return false;
    }
  },

  /** 判断照片内容是否与最近一次存档完全一致（一致则本次编辑不用重复存档照片） */
  async photosUnchanged(catId, photoEtags) {
    try {
      const list = await db.find(CHANGE_COLLECTION, { catId: catId }, { sort: { editTime: -1 }, limit: 1 });
      const last = list && list[0];
      if (!last || !last.data) return false;
      const lastTags = Array.isArray(last.data.photoEtags) ? last.data.photoEtags : null;
      if (!lastTags) return false; // 旧记录没存指纹，无法比对 → 按"需要存档"处理，保证不丢照片
      // 末尾缩略图（.png）不算：只改封面（换顺序）不属于照片变化
      const lastJpg = lastTags.slice(0, -1);
      const curJpg = (photoEtags || []).slice(0, -1);
      return JSON.stringify(lastJpg) === JSON.stringify(curJpg);
    } catch (e) {
      return false; // 查询失败按"需要存档"处理，保证不丢照片
    }
  },

  /** 把页面填写的猫咪资料整理成要写入数据库的对象 */
  buildCatData() {
    // 关系由编辑器组件维护：把 relationList 还原成 relatedCats 字符串
    // （关系变了，昵称也要刷新，因为昵称由各字段拼成、含相关猫名）
    const cat = Object.assign({}, this.data.cat);
    cat.relatedCats = relation.buildRelatedCats(this.data.relationList || []);
    cat.nickname = catForm.nickname(cat);
    const doc = catForm.buildDoc(cat, Math.max(0, this.data.imageUrls.length - 1));
    // 照片版本号：本次编辑只要动了照片（进页面时的图片列表 ≠ 现在的），
    // 就给这条记录带一个新版本号。注意 buildDoc 只保留固定字段，版本号
    // 必须放在 buildDoc 之后单独加，否则会被丢掉写不进数据库。
    // 首页/详情/编辑页拼图片 URL 时带上 ?v=版本号，微信看到 URL 变新就会
    // 重新下载图片，避免"提交后显示的还是旧图"。只改文字没动照片 → 不带
    // 版本号 → 图片不重复下载（省流量）。
    if (JSON.stringify(this._originalUrls || []) !== JSON.stringify(this.data.imageUrls)) {
      doc.photoVer = Date.now();
    }
    return doc;
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

  /**
   * 同步照片到 COS（改名 / 排序不再重传，全部走服务端复制）：
   *  - 本地新增的图片 → 上传（只传真正新增的）
   *  - 已有网络图（改名或换顺序）→ COS 服务端复制到新序号/新名字
   *  - 封面缩略图 .png → 跟随第一张图（本地图上传、网络图服务端复制）
   *  - 被删的图 → 只删"旧记录存在、新列表不再引用"的文件，绝不多删、不误删
   */
  async syncImages() {
    const cat = this.data.cat;
    const name = cat.name;
    const beforeName = this.data.beforeName;
    const oldCount = this.data.oldPhotoNum;
    const imageUrls = this.data.imageUrls;
    const renamed = beforeName && beforeName !== name;

    const oldKeys = [];
    for (let i = 0; i <= oldCount; i++) {
      oldKeys.push(cos.catJpg(beforeName, i)); // 旧记录存在过的全部图片 key
    }

    // 封面缩略图：新第一张决定内容
    const extraCopies = []; // 并入 jpg 同一批两阶段复制，保证读到"改动前"的源
    const thumbUpload = [];
    const thumbDelete = [];
    if (imageUrls.length > 0) {
      const first = imageUrls[0];
      const firstIsLocal = first.indexOf('wxfile://') === 0 || first.indexOf('http://tmp') === 0;
      if (firstIsLocal) {
        thumbUpload.push({ Key: cos.catThumb(name), FilePath: first });
      } else {
        const src = cos.keyFromUrl(first);
        if (src && src !== cos.catThumb(name)) {
          extraCopies.push({ from: src, to: cos.catThumb(name) });
        }
      }
      // 改名后旧缩略图不再需要（新缩略图已按新名字生成）
      if (renamed) thumbDelete.push(cos.catThumb(beforeName));
    } else {
      // 一张图都没有：旧缩略图一并清掉
      thumbDelete.push(cos.catThumb(beforeName));
    }

    const result = await cos.reconcileImages({
      imageUrls: imageUrls,
      newKey: (i) => cos.catJpg(name, i),
      oldKeys: oldKeys,
      urlToKey: cos.keyFromUrl,
      extraCopies: extraCopies,
    });

    if (thumbUpload.length) await cos.uploadList(thumbUpload);
    if (thumbDelete.length) cos.deleteList(thumbDelete);
    return result;
  },

  /** 删除整只猫咪 */
  delete() {
    if (this._deleting) return; // 防止重复点击删除（删除是异步流程，第一下没结束前拦截第二下）
    wx.showModal({
      title: '提示',
      confirmColor: 'red',
      content: '确定删除吗？',
      success: async (res) => {
        if (!res.confirm) return;
        if (this._deleting) return;
        this._deleting = true;
        wx.showLoading({ title: '删除中...', mask: true });
        try {
          // 删除前先把整只猫存档到 BITZHdelete（含照片快照），保证回收站可完整恢复。
          // 存档失败则中止删除：宁可删不掉也不丢数据（对齐 editBooklet 删除逻辑）
          const archived = await this.archiveCurrent('delete', this._originalCat);
          if (!archived) {
            wx.hideLoading();
            this._deleting = false;
            wx.showModal({ title: '提示', content: '删除存档失败，已取消删除，请重试', showCancel: false });
            return;
          }
          // 照片保留在 COS 原位置不删除：误删的猫可凭存档 + 原图完整恢复；
          // 存档目录另有副本，即使同名新猫覆盖原图，历史照片也不丢
          await db.deleteOne('BITZH', { _id: this.data.cat._id });
          // 清理其他猫 relatedCats 里指向这只猫的引用（避免详情页残留已删除的关系）
          try {
            await relation.removeCatRefs(this.data.cat.name);
          } catch (err) {
            console.error('清理删除猫的关系引用失败', err);
          }
          cos.clearETagCache(); // 猫已删，清掉 ETag 缓存
          draft.clearDraft(this, this._draftType, this._draftId); // 删除成功 → 清掉草稿
          wx.hideLoading();
          wx.showToast({ icon: 'success', title: '操作成功' });
          this.safeBack(); // 有上一页就返回，没有就回首页（见 safeBack）
        } catch (err) {
          wx.hideLoading();
          this._deleting = false;
          console.error('删除猫咪失败', err);
          wx.showToast({ icon: 'error', title: '删除失败' });
        }
      },
    });
  },

  /**
   * 安全返回：页面栈有上一页就 navigateBack，没有（栈深只有 1，可能是直接打开的编辑页）
   * 就 reLaunch 回首页——避免在"没有可返回的页面"时硬调 navigateBack，
   * 触发开发者工具里的 "navigateBack with an unexist webviewId" 这类导航报错。
   */
  safeBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: '/pages/catSearch/catSearch' });
    }
  },

  // ============ 历史照片（查看该猫历史出现过的照片，可挑一张加入当前） ============
  /**
   * 打开"历史照片"弹层。
   * 目标是"保持图片多样性、新增原来没有的图"：
   *  - 跨版本按内容（ETag）去重：同一张图不管在几个版本里出现过，只显示一次；
   *  - 已在当前列表里的图仍展示，但打"已有"标记（置灰角标），插入时拦截，
   *    避免同内容重复加；管理员能看清全部历史照片；
   *  - 顺序不保留（flex 网格展示，插入后可自行拖动排序）。
   * 新存档记录带 photoEtags（存档时算好），旧记录缺省时现查 COS headObject 补全。
   */
  async loadHistory() {
    wx.showLoading({ title: '加载中...', mask: true });
    try {
      const list = await db.find(
        CHANGE_COLLECTION,
        { catId: this.data.cat._id },
        { sort: { editTime: -1 }, limit: 30 }
      );
      // 收集所有版本的存档照片（跳过 .png 缩略图，只列照片本体）
      const raw = [];
      (list || []).forEach((r) => {
        const d = r.data;
        if (!d || !d.photoArchive || !Array.isArray(d.photoKeys)) return;
        const tags = Array.isArray(d.photoEtags) ? d.photoEtags : [];
        (d.photoKeys || []).forEach((key, i) => {
          if (/\.png$/.test(key)) return;
          raw.push({
            key: cos.archiveKey(d.photoArchive, key),
            url: cos.archiveUrl(d.photoArchive, key),
            etag: tags[i] || '', // 旧记录没有 photoEtags，下面现查补全
          });
        });
      });
      if (!raw.length) {
        wx.hideLoading();
        wx.showToast({ icon: 'none', title: '暂无历史照片存档' });
        return;
      }

      // 当前列表照片的内容指纹：给历史照片打"已有"标记（已在当前列表的图置灰标出，
      // 插入时拦截防重复；但仍展示出来，方便管理员看清全部历史照片）
      const curTags = new Set();
      const curEtags = await Promise.all(
        this.data.imageUrls.map((u) => {
          const k = cos.keyFromUrl(u);
          return k ? cos.getETag(k) : Promise.resolve('');
        })
      );
      curEtags.forEach((t) => { if (t) curTags.add(t); });

      // 按内容去重：同一张图跨版本只出现一次
      const seen = new Set();
      const photos = [];
      for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        let etag = p.etag;
        if (!etag) {
          try { etag = await cos.getETag(p.key); } catch (e) { etag = ''; }
        }
        if (!etag) {
          photos.push({ url: p.url, has: false }); // 读不到指纹：保留展示，宁可多显示
          continue;
        }
        if (seen.has(etag)) continue; // 历史内已出现过 → 不重复
        seen.add(etag);
        photos.push({ url: p.url, has: curTags.has(etag) });
      }
      wx.hideLoading();
      if (!photos.length) {
        wx.showToast({ icon: 'none', title: '暂无历史照片存档' });
        return;
      }
      this.setData({
        historyList: [{ time: '全部历史照片（已去重）', operator: '', photos: photos }],
        historyShow: true,
      });
    } catch (err) {
      wx.hideLoading();
      console.error('加载历史照片失败', err);
    }
  },

  /**
   * 把历史版本里的某张照片插入到当前图片列（最前或最后），可随后拖动排序。
   * 延迟提交：这里只改表单状态 imageUrls（插入的是存档照片的 COS URL），
   * 不做任何 COS 写入——真正的复制（存档目录 → 当前槽位）由提交时的 syncImages 完成。
   * 若用户不提交或中途删掉这张，COS 上不会有任何残留。
   */
  insertHistoryPhoto(e) {
    const d = e.currentTarget.dataset;
    const url = d.url; // 存档照片 URL（main/images/archive/...）
    if (!url) return;
    // 图片条用 wx:key="*this"（URL 当 key）：同一张历史照片不能插两次，
    // 重复 key 会让渲染层节点错乱（unknown removedNode / 图片串位）。
    if (this.data.imageUrls.indexOf(url) !== -1) {
      wx.showToast({ icon: 'none', title: '该历史照片已在列表中' });
      return;
    }
    // 内容级防重：该图内容已包含在当前列表（弹层里标了"已有"），不能再加
    if (d.has === 'true') {
      wx.showToast({ icon: 'none', title: '该图已包含在当前列表中' });
      return;
    }
    wx.showActionSheet({
      itemList: ['插入到图片列表最前面', '插入到图片列表最后面'],
      success: (res) => {
        const imageUrls = this.data.imageUrls.slice();
        if (res.tapIndex === 0) imageUrls.unshift(url);
        else imageUrls.push(url);
        // 先把图片条更新提交出去，弹层在 setData 回调（本帧渲染完成后）再关：
        // 同一帧里"给 scroll-view 增节点 + 移除含 scroll-view 的弹层"会让渲染层
        // 节点追踪错乱（unknown removedNode、移除节点被错误复用导致图片串位）。
        this.setData({ imageUrls }, () => {
          draft.markDirty(this); // 图片列表变了 → 纳入草稿自动保存
          this.closeHistory(); // 关掉弹层露出图片条，方便用户拖动排序
          this.clearFieldError('photo'); // 补了照片 → 消图片区红框
          wx.showToast({ icon: 'success', title: '已加入，提交后生效' });
        });
      },
    });
  },

  /** 关闭"历史照片"弹层 */
  closeHistory() {
    this.setData({ historyShow: false });
  },

  /** 输入框内容变化 */
  inputText(e) {
    const key = e.currentTarget.dataset.key;
    if (key === 'name') {
      this.setData({ changName: true, nameDuplicate: '' }); // 名字被修改，清除旧重名提示
      this.clearFieldError('name'); // 名字填上了 → 消红框
    }
    setField(this, 'cat.' + key, e.detail.value); // 动态字段名赋值
    this.setnickname();
    draft.markDirty(this); // 内容变了 → 触发自动保存
  },

  /** 自动生成搜索关键词（昵称，由各字段拼成） */
  setnickname() {
    setField(this, 'cat.nickname', catForm.nickname(this.data.cat));
  },

  /**
   * 名字输入框失焦（用户去操作别的地方）时检查是否有同名猫，提前提醒。
   * 只做提示，不拦截（同名猫在本系统合法，靠 _id 区分）。
   * 编辑页排除自己；用序号防止旧查询覆盖新结果。
   */
  async onNameBlur() {
    const name = (this.data.cat.name || '').trim();
    if (!name) {
      this.setData({ nameDuplicate: '' });
      return;
    }
    this._nameCheckSeq = (this._nameCheckSeq || 0) + 1;
    const seq = this._nameCheckSeq;
    try {
      const list = await db.find('BITZH', { name: name });
      if (seq !== this._nameCheckSeq) return; // 期间名字又变了，丢弃过期结果
      const selfId = this.data.cat._id;
      // 排除自己：编辑页保留原名字不改时不算重名
      const count = selfId
        ? list.filter((d) => String(d._id) !== String(selfId)).length
        : list.length;
      this.setData({
        nameDuplicate: count > 0 ? '已有 ' + count + ' 只猫叫「' + name + '」' : '',
      });
    } catch (err) {
      console.error('重名检查失败', err);
    }
  },

  // ============ 恢复上次数据（读取 BITZHchange 修改记录） ============

  /** 存档值与当前值是否有差异（undefined/null 按空串算，填空/清空也算差异） */
  valDiff(oldV, curV) {
    const o = (oldV === undefined || oldV === null) ? '' : String(oldV);
    const c = (curV === undefined || curV === null) ? '' : String(curV);
    return o !== c;
  },

  /** 存档里的关系与当前关系是否有差异。
      老存档（没存 relatedCats 字段）视为无差异，不参与恢复 */
  relatedDiff(rec) {
    const old = rec && rec.data && rec.data.relatedCats;
    if (old === undefined || old === null) return false;
    const cur = relation.buildRelatedCats(this.data.relationList || []);
    return String(old) !== cur;
  },

  /** 把 relatedCats 字符串格式化成可读文案：名字（关系）顿号连接；空则"（空）" */
  formatRelatedDisplay(str) {
    if (!str) return '（空）';
    const list = relation.parseRelatedCats(str);
    if (!list.length) return '（空）';
    return list.map((x) => x.name + (x.relation ? '（' + x.relation + '）' : '')).join('、');
  },

  /** 该存档与当前表单是否有任何可恢复的差异字段（含关系） */
  recHasDiff(rec) {
    if (!rec || !rec.data) return false;
    if (RESTORE_FIELDS.some((k) => this.valDiff(rec.data[k], this.data.cat[k]))) return true;
    return this.relatedDiff(rec);
  },

  /**
   * 进入页面时的静默预检：查该猫最近的修改存档，跳过"与当前完全一致"的
   * 冗余记录（上次空提交/重复提交会生成无差异记录），取最近一条真正有差异的。
   * 有 → 显示恢复按钮。集合不存在 / 无权限等任何失败都静默处理。
   */
  async checkRestoreAvailable() {
    try {
      const list = await db.find(
        CHANGE_COLLECTION,
        { catId: this.data.cat._id },
        { sort: { editTime: -1 }, limit: 10 }
      );
      const rec = list.find((r) => this.recHasDiff(r));
      if (!rec) return; // 无历史或无差异 → 不显示按钮
      this._lastRestoreRec = rec; // 缓存最近一条有差异的存档，点击时避免二次查询
      // 用存档补全"上次编辑人"（老数据可能没存 lastEditAdministrator）
      if (rec.operatorName && !this.data.lastEditor) {
        this.setData({ lastEditor: rec.operatorName });
      }
      this.setData({ restoreAvailable: true });
    } catch (err) {
      console.error('恢复预检失败（可能是 BITZHchange 未创建或无权限）', err);
    }
  },

  /** 调出最近一次有差异的存档：把差异字段标红显示上次的数据 */
  async restoreLast() {
    if (!this.data.cat || !this.data.cat._id) return;
    wx.showLoading({ title: '查询中...', mask: true });
    try {
      let list = null;
      let rec = this._lastRestoreRec;
      if (!rec) {
        list = await db.find(
          CHANGE_COLLECTION, // 恢复的是"修改记录"，从 BITZHchange 取该猫的存档
          { catId: this.data.cat._id },
          { sort: { editTime: -1 }, limit: 10 }
        );
        rec = list.find((r) => this.recHasDiff(r));
      }
      wx.hideLoading();
      if (!rec) {
        wx.showToast({
          icon: 'none',
          title: (list && list.length) ? '上次数据与当前一致' : '暂无历史记录',
        });
        this.setData({ restoreAvailable: false });
        return;
      }
      const restoreOld = {};
      const restoreValue = {};
      RESTORE_FIELDS.forEach((k) => {
        const oldV = rec.data[k];
        const curV = this.data.cat[k];
        // 只要"上次的值"和"当前值"不同就算差异（含上次为空/本次有值、上次有值/本次为空）
        if (this.valDiff(oldV, curV)) {
          const actualOld = (oldV === undefined || oldV === null) ? '' : oldV;
          restoreValue[k] = actualOld; // 点击红框时写回表单的真实值（可能为空串）
          restoreOld[k] = actualOld === '' ? '（空）' : String(actualOld); // 红框显示文案
        }
      });
      // 关系：老存档存过才参与对比，恢复时把 relatedCats 填回关系编辑器
      if (this.relatedDiff(rec)) {
        restoreValue.relatedCats = rec.data.relatedCats; // 写回用的原始字符串
        restoreOld.relatedCats = this.formatRelatedDisplay(rec.data.relatedCats); // 红框显示文案
      }
      if (Object.keys(restoreOld).length === 0) {
        wx.showToast({ icon: 'none', title: '上次数据与当前一致' });
        this.setData({ restoreAvailable: false });
        return;
      }
      this.setData({
        restoreOld,
        restoreValue,
        restoreApplied: {},
        restoreVisible: true,
        // 这次修改（恢复对象）的编辑人与时间
        restoreEditor: rec.operatorName || this.data.cat.lastEditAdministrator || '未知',
        restoreTime: formatTime(rec.editTime),
      });
    } catch (err) {
      wx.hideLoading();
      console.error(err);
      wx.showToast({ icon: 'none', title: '查询失败' });
    }
  },

  /** 点击红框 → 把该字段填回上次的真实值 */
  applyOld(e) {
    const key = e.currentTarget.dataset.key;
    this.applyRestoreValue(key, this.data.restoreValue[key]);
  },

  /** 一键把全部字段恢复成上次的真实值 */
  applyAllOld() {
    Object.keys(this.data.restoreOld || {}).forEach((k) => {
      this.applyRestoreValue(k, this.data.restoreValue[k]);
    });
  },

  /** 把某个字段的值写回表单：刷新下拉选中下标/昵称，并标记已应用 */
  applyRestoreValue(key, value) {
    if (value === undefined || value === null) return;
    if (key === 'name') {
      this.setData({ nameDuplicate: '' }); // 名字被恢复，旧重名提示作废
      this.clearFieldError('name'); // 名字填上了 → 消红框
    }
    if (key === 'relatedCats') {
      // 关系：解析成卡片数组交给 relation-editor 回显（observers.value 自动刷新卡片）
      this.setData({ relationList: relation.parseRelatedCats(value) });
      setField(this, 'restoreApplied.' + key, true); // 动态字段名用 setField 避免编译报错
      draft.markDirty(this); // 恢复的字段也算改动 → 纳入草稿自动保存
      return;
    }
    setField(this, 'cat.' + key, value);
    if (this.data.pickers[key]) this.initPickerSelected(); // 下拉框：刷新选中下标
    this.setnickname(); // 昵称由各字段拼成，恢复后跟着刷新
    setField(this, 'restoreApplied.' + key, true); // 动态字段名用 setField 避免编译报错
    draft.markDirty(this); // 恢复的字段也算改动 → 纳入草稿自动保存
  },

  /** 尚未处理（没点红框应用）且仍有差异的字段 key 列表 */
  pendingRestoreKeys() {
    const pending = [];
    Object.keys(this.data.restoreOld || {}).forEach((k) => {
      if (!this.data.restoreApplied[k]) pending.push(k);
    });
    return pending;
  },

  /** 追加选择新图片（相册/拍摄，统一处理权限与失败提示；达到 20 张上限拦截） */
  getphoto() {
    const left = imgEditor.remaining(this);
    if (left <= 0) {
      wx.showToast({ title: '最多 20 张', icon: 'none' });
      return;
    }
    // 选图是异步的，用 onChange 回调标记草稿"已变"，防抖保存才能看到刚加入的图
    media.chooseImages(this, 'imageUrls', left, true, () => {
      draft.markDirty(this);
      this.clearFieldError('photo'); // 补了照片 → 消图片区红框
    });
  },

  /** 图片区变化（拖拽排序/删除/设封面/新增）→ 写回页面数组并标记草稿已变 */
  onImgChange(e) {
    setField(this, this.data.imgField, e.detail.items);
    draft.markDirty(this);
  },
  /** 空拦截：historyShow 弹层 catchtouchmove/catchtap 用（阻止事件穿透） */
  noop() {},

  /**
   * 猫改名后同步更新推文的 relative 字段：把旧名替换为新名。
   * relative 是空格分隔的话题标签（如 "小海参 海参 橘猫"），
   * 只替换作为完整标签出现的旧名，不误伤包含旧名的其他标签。
   * 例如：把"海参"改为"大海参"时，"小海参"不会被改成"小大海参"。
   * @param {String} oldName 改名前的猫名
   * @param {String} newName 改名后的猫名
   */
  async updatePageRelative(oldName, newName) {
    var escaped = guard.escapeRegExp(oldName);
    // $regex 做粗筛：找到 relative 中包含旧名的所有推文（可能含 "小海参" 等相似名）
    var pages = await db.find('Page', { relative: { $regex: escaped, $options: 'i' } });
    if (!pages || !pages.length) return;
    // 精确替换：只匹配作为完整标签出现的旧名
    // 分隔符类与 utils/topic.js 的 tokenRegex 一致（空白/井号/全角井号/逗号等），
    // 兼容新格式 "#海参 #海参"（# 开头）和历史脏格式 "#肥仔#水晶"、"笨笨，小鸭"。
    // 这样 "海参" 只匹配独立的 "海参" 标签，不会误伤 "小海参"。
    var SEP = '[\\s#＃，,；;、|]';
    var re = new RegExp('(^|' + SEP + ')(' + escaped + ')(?=$|' + SEP + ')', 'gi');
    var self = this;
    var updates = pages.map(function (p) {
      var newRelative = (p.relative || '').replace(re, function (match, prefix, matchedName) {
        return prefix + newName;
      });
      if (newRelative === p.relative) return null; // 只有相似名（如 "小海参"）但无独立标签 → 跳过
      return db.updateOne('Page', { _id: p._id }, { $set: { relative: newRelative } });
    }).filter(Boolean);
    await Promise.all(updates);
  },
});
