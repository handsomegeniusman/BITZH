// ============================================================
// components/relation-editor/relation-editor.js —— 猫咪关系编辑器
// 【作用】把 addCat / editCat 页面的"相关的猫"编辑从手输文字
//        改成卡片式 UI（同 catDetail 展示样式）：
//          - 左侧固定「＋」添加，右侧横向滑动关系卡片
//          - 点「＋」→ 半屏搜索已有猫（模糊匹配名字/昵称）
//          - 无匹配时可"暂存这个名字的关系"（日后创建该猫自动关联）
//          - 填关系后弹"同步确认"，自动配对反向关系（可手改/不同步）
//          - 每次关系变更通过 change 事件把 relations + syncTasks
//            交给页面，页面在"确定提交"时才真正写库（取消编辑不污染数据库）
//        头像缩略图回退 / 弹窗样式参考页面现有实现。
// ============================================================
const db = require('../../utils/db.js');
const pageUtil = require('../../utils/page.js');
const relation = require('../../utils/relation.js');

Component({
  properties: {
    /** 关系数组 [{name, relation}]，页面回填用（解析后的 relatedCats） */
    value: { type: Array, value: [] },
    /** 当前猫名字（搜索排除 + 反向文案用） */
    catName: { type: String, value: '' },
    /** 当前猫性别（'公'/'母'，决定部分反向关系用词） */
    catGender: { type: String, value: '' },
  },

  data: {
    url: '',               // 图片根地址
    commonRelations: [],   // 常见关系快捷词条
    list: [],              // 关系卡片 [{name, relation, missing, _thumbFallback}]
    syncTasks: [],         // 待提交的同步任务 [{name, relation} | {name, remove:true}]
    // 搜索弹窗
    showSearch: false,
    keyword: '',
    searchResults: [],
    searching: false,
    searchDone: false,
    // 填关系弹窗
    showRelation: false,
    editIndex: -1,         // -1 新增；>=0 编辑 list 中某条
    target: null,          // {name, gender, location, missing, _thumbFallback}
    relationText: '',
    // 同步确认弹窗
    showSync: false,
    syncInfo: null,        // {targetName, relationLabel, inverseText, candidates}
    noAsk: false,          // 本次编辑不再询问（会话内自动同步）
    // 删除确认弹窗
    showDelete: false,
    deleteIndex: -1,
  },

  observers: {
    value: function (val) {
      this.seed(val);
    },
  },

  lifetimes: {
    attached() {
      const app = getApp();
      this.setData({
        url: (app.globalData && app.globalData.url) || '',
        commonRelations: relation.COMMON_RELATIONS,
      });
      this.seed(this.data.value);
    },
    detached() {
      clearTimeout(this._searchTimer);
    },
  },

  methods: {
    noop() {},

    /** 用页面传入的关系数组初始化卡片列表，并判定哪些目标猫不存在 */
    seed(value) {
      const arr = Array.isArray(value) ? value : [];
      // 保留已有卡片的 missing / 头像回退状态，避免重复渲染时闪烁
      const prev = {};
      this.data.list.forEach(function (x) {
        prev[x.name] = { missing: x.missing, _thumbFallback: x._thumbFallback || 0 };
      });
      const entries = arr
        .filter(function (x) { return x && x.name; })
        .map(function (x) {
          const old = prev[x.name] || {};
          return {
            name: x.name,
            relation: x.relation || '',
            missing: !!old.missing,
            _thumbFallback: old._thumbFallback || 0,
          };
        });
      // 与当前列表一致时直接跳过，避免页面回传 value 引发的重复查询
      const cur = this.data.list.map(function (x) { return { name: x.name, relation: x.relation || '' }; });
      const next = entries.map(function (x) { return { name: x.name, relation: x.relation }; });
      if (JSON.stringify(next) === JSON.stringify(cur)) return;
      this.setData({ list: entries });
      this.checkMissing();
    },

    /** 查询数据库，把不存在的目标猫标记为 missing（历史脏数据/暂存）。
        只修正这次查询过名字的 missing 标记，保留列表其它内容，
        避免查询期间用户新增的卡片被覆盖。 */
    async checkMissing() {
      const names = this.data.list.map(function (x) { return x.name; }).filter(Boolean);
      if (!names.length) return;
      let exist;
      try {
        const found = await db.find('BITZH', { name: { $in: names } });
        exist = new Set(found.map(function (c) { return c.name; }));
      } catch (err) {
        console.error('检查关系猫是否存在失败', err);
        return;
      }
      const known = new Set(names);
      const list = this.data.list.map(function (x) {
        if (!known.has(x.name)) return x; // 查询期间新增的，保留原样
        return Object.assign({}, x, { missing: !exist.has(x.name) });
      });
      this.setData({ list: list });
    },

    // ============ 搜索弹窗 ============
    openSearch() {
      this.setData({
        showSearch: true,
        keyword: '',
        searchResults: [],
        searching: false,
        searchDone: false,
      });
      clearTimeout(this._searchTimer);
    },
    closeSearch() {
      this.setData({ showSearch: false });
    },
    onSearchInput(e) {
      const keyword = e.detail.value;
      this.setData({ keyword: keyword });
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this.doSearch(keyword), 300);
    },
    async doSearch(keyword) {
      const kw = String(keyword || '').trim();
      if (!kw) {
        this.setData({ searchResults: [], searching: false, searchDone: false });
        return;
      }
      const exclude = this.data.list
        .map(function (x) { return x.name; })
        .concat([this.data.catName])
        .filter(Boolean);
      this.setData({ searching: true });
      try {
        const res = await relation.searchCats(kw, exclude);
        const results = res.map(function (c) {
          return {
            _id: c._id,
            name: c.name,
            gender: c.gender,
            location: c.location,
            _thumbFallback: 0,
          };
        });
        this.setData({ searchResults: results, searching: false, searchDone: true });
      } catch (err) {
        console.error('搜索失败', err);
        this.setData({ searchResults: [], searching: false, searchDone: true });
      }
    },
    /** 选中一条搜索结果 */
    pickResult(e) {
      const item = this.data.searchResults[e.currentTarget.dataset.index];
      if (!item) return;
      const existIdx = this.data.list.findIndex(function (x) { return x.name === item.name; });
      if (existIdx >= 0) {
        // 已在列表中：直接进入编辑
        this.setData({ showSearch: false });
        this.openRelation(existIdx);
        return;
      }
      this.setData({
        showSearch: false,
        showRelation: true,
        editIndex: -1,
        target: {
          name: item.name,
          gender: item.gender,
          location: item.location,
          missing: false,
          _thumbFallback: 0,
        },
        relationText: '',
      });
    },
    /** 搜索无结果：暂存这个名字的关系（日后创建该猫时自动反向关联） */
    keepUnmatched() {
      const name = String(this.data.keyword || '').trim();
      if (!name) {
        wx.showToast({ title: '请输入名字', icon: 'none' });
        return;
      }
      if (name === this.data.catName) {
        wx.showToast({ title: '不能选择自己', icon: 'none' });
        return;
      }
      if (this.data.list.some(function (x) { return x.name === name; })) {
        wx.showToast({ title: '已在列表中', icon: 'none' });
        return;
      }
      this.setData({
        showSearch: false,
        showRelation: true,
        editIndex: -1,
        target: { name: name, gender: '', location: '', missing: true, _thumbFallback: 0 },
        relationText: '',
      });
    },

    // ============ 填关系弹窗 ============
    /** 点击卡片 → 编辑该条关系 */
    editRelation(e) {
      this.openRelation(e.currentTarget.dataset.index);
    },
    openRelation(index) {
      const item = this.data.list[index];
      if (!item) return;
      this.setData({
        showRelation: true,
        editIndex: index,
        target: {
          name: item.name,
          gender: '',
          location: '',
          missing: !!item.missing,
          _thumbFallback: 0,
        },
        relationText: item.relation || '',
      });
    },
    closeRelation() {
      this.setData({ showRelation: false });
    },
    onRelationInput(e) {
      this.setData({ relationText: e.detail.value });
    },
    tapChip(e) {
      this.setData({ relationText: e.currentTarget.dataset.rel });
    },
    /** 填关系弹窗里的"删除这条关系" */
    removeRelationFromSheet() {
      const idx = this.data.editIndex;
      if (idx < 0) return;
      this.setData({ showRelation: false });
      this.openDelete(idx);
    },
    /** 保存关系：更新本地列表，然后进入同步确认（或按"不再询问"自动处理） */
    saveRelation() {
      const rel = relation.normalizeRelation(this.data.relationText);
      if (!rel) {
        wx.showToast({ title: '请输入关系', icon: 'none' });
        return;
      }
      const target = this.data.target;
      if (!target || !target.name) return;
      const isEdit = this.data.editIndex >= 0;

      // 1. 更新本地列表
      const list = this.data.list.slice();
      if (isEdit) {
        list[this.data.editIndex] = Object.assign({}, list[this.data.editIndex], { relation: rel });
      } else {
        list.push({
          name: target.name,
          relation: rel,
          missing: !!target.missing,
          _thumbFallback: 0,
        });
      }
      this.setData({ list: list, showRelation: false });

      // 2. 计算反向关系
      const inv = relation.getInverse(rel, this.data.catGender);

      // 3. 已勾选"本次编辑不再询问"：自动处理（可配对的自动同步，否则仅改当前猫）
      if (this.data.noAsk) {
        if (inv.known && inv.prefill) {
          this.setSyncTask(target.name, { name: target.name, relation: inv.prefill });
        } else {
          this.setSyncTask(target.name, null);
        }
        this.emit();
        wx.showToast({ title: isEdit ? '已更新' : '已添加', icon: 'success' });
        return;
      }

      // 4. 弹同步确认
      this.setData({
        showSync: true,
        syncInfo: {
          targetName: target.name,
          relationLabel: rel,
          inverseText: inv.prefill || '',
          candidates: inv.candidates || [],
        },
      });
    },

    // ============ 同步确认弹窗 ============
    onInverseInput(e) {
      this.setData({ 'syncInfo.inverseText': e.detail.value });
    },
    tapInverseChip(e) {
      this.setData({ 'syncInfo.inverseText': e.currentTarget.dataset.rel });
    },
    toggleNoAsk() {
      this.setData({ noAsk: !this.data.noAsk });
    },
    /** 同步到对方：写入反向关系任务 */
    confirmSync() {
      const info = this.data.syncInfo;
      if (!info) return;
      const inverseText = relation.normalizeRelation(info.inverseText);
      this.setSyncTask(info.targetName, { name: info.targetName, relation: inverseText });
      this.setData({ showSync: false });
      this.emit();
      wx.showToast({ title: '已同步对方', icon: 'success' });
    },
    /** 仅改当前猫：清除该目标之前可能积累的同步任务，不碰对方 */
    skipSync() {
      if (this.data.syncInfo) {
        this.setSyncTask(this.data.syncInfo.targetName, null);
      }
      this.setData({ showSync: false });
      this.emit();
      wx.showToast({ title: '仅修改当前猫', icon: 'success' });
    },

    // ============ 删除关系 ============
    openDelete(index) {
      this.setData({ showDelete: true, deleteIndex: index });
    },
    closeDelete() {
      this.setData({ showDelete: false });
    },
    /** 仅删除本条：不影响对方页面 */
    deleteOnly() {
      const item = this.data.list[this.data.deleteIndex];
      if (item && item.name) this.setSyncTask(item.name, null);
      this.removeFromList(this.data.deleteIndex);
    },
    /** 同时删除对方：追加 remove 同步任务 */
    deleteAndSync() {
      const item = this.data.list[this.data.deleteIndex];
      if (item && item.name) {
        this.setSyncTask(item.name, { name: item.name, remove: true });
      }
      this.removeFromList(this.data.deleteIndex);
    },
    removeFromList(index) {
      const list = this.data.list.slice();
      list.splice(index, 1);
      this.setData({ list: list, showDelete: false });
      this.emit();
      wx.showToast({ title: '已删除', icon: 'success' });
    },

    // ============ 头像缩略图回退 ============
    onAvatarError(e) {
      pageUtil.onImgError(this, e);
    },
    onTargetAvatarError() {
      const target = this.data.target;
      if (!target) return;
      const fb = (target._thumbFallback || 0) + 1;
      if (fb > 2) return;
      this.setData({ 'target._thumbFallback': fb });
    },

    // ============ 内部工具 ============
    /** 设置某个目标的同步任务（先清掉旧任务，后操作覆盖先操作） */
    setSyncTask(name, task) {
      const syncTasks = this.data.syncTasks.filter(function (t) { return t.name !== name; });
      if (task) syncTasks.push(task);
      this.setData({ syncTasks: syncTasks });
    },
    /** 把最新 relations + syncTasks 通知页面暂存 */
    emit() {
      const relations = this.data.list.map(function (x) {
        return { name: x.name, relation: x.relation };
      });
      this.triggerEvent('change', {
        relations: relations,
        syncTasks: this.data.syncTasks.slice(),
      });
    },
  },
});
