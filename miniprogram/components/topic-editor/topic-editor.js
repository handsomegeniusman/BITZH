// ============================================================
// components/topic-editor/topic-editor.js —— 话题（推文标签）编辑器
// 【作用】把 addBooklet / editBooklet 的"话题"从"手输 #话题 #话题"改成
//        chip 卡片式编辑：
//          - 无需打 #：输入后点「添加」按钮 / 点下方建议 / 按回车 生成标签
//            （不依赖空格键——中文输入法候选词会抢占空格，把空格映射成关联字）
//          - 输入过程中防抖检索"已有猫名 + 已有话题"给出建议，点选即加
//          - 建议行 tap 有兜底：键盘收起时 tap 可能被系统吃掉（"点击添加无反应"），
//            用 catchtouchstart 记录意图 + blur 定时兜底，保证第一次点击就生效
//          - 每个标签带 × 可删；变更通过 change 事件把规范串（"#话题 #话题"）
//            交给页面，页面写回 listData.relative（存库格式与旧数据兼容）
// ============================================================
const db = require('../../utils/db.js');
const guard = require('../../utils/guard.js');
const topic = require('../../utils/topic.js');

Component({
  properties: {
    /** 话题规范串（页面回填 / 草稿恢复 / 上次数据恢复用，兼容脏格式） */
    value: { type: String, value: '' },
    /** 当前猫名（建议里排除自己，避免把猫名自身当话题重复建议） */
    catName: { type: String, value: '' },
  },

  data: {
    topics: [],           // 已生成的话题数组（不含 #）
    input: '',            // 输入框当前文字
    suggestions: [],      // 建议列表（猫名 + 已有话题，去重后）
    showSuggest: false,   // 是否显示建议下拉
    suggestDone: false,   // 最近一次检索是否已完成（用于"无匹配"空态）
  },

  observers: {
    value: function (val) {
      this.seed(val);
    },
  },

  lifetimes: {
    attached() {
      this.seed(this.data.value);
    },
    detached() {
      clearTimeout(this._suggestTimer);
      clearTimeout(this._pickTimer);
    },
  },

  methods: {
    noop() {},

    /** 用页面传入的话题串初始化 chip 列表（topic.parse 兼容全部脏格式） */
    seed(value) {
      const arr = topic.parse(value);
      const cur = this.data.topics;
      if (JSON.stringify(arr) === JSON.stringify(cur)) return; // 内容没变不重复 setData
      this.setData({ topics: arr });
    },

    /** 去重添加单个话题到数组；重复/空串返回 false */
    addUnique(topics, t) {
      const s = String(t == null ? '' : t).trim().replace(/^[#＃]+/, ''); // 去掉用户可能手打的 #
      if (!s) return false;
      if (topics.indexOf(s) >= 0) return false;
      topics.push(s);
      return true;
    },

    /** 页面点击编辑器外空白处时收起建议下拉（由页面 onPageTap 调用）。
     *  只收建议、不清输入——用户可能只是想去点别的字段，回来还能接着打。 */
    collapseSuggest() {
      this.setData({ suggestions: [], showSuggest: false, suggestDone: false });
    },

    /** 把当前输入生成 chip 并通知页面。
     *  flush()：供「添加」按钮 / 页面提交兜底调用 → 转 chip 并收起建议；
     *  flushKeepSuggest()：供键盘「完成」/ 失焦（收起键盘）调用 → 转 chip 但保留建议，
     *    因为"收起键盘"≠"不要建议"，用户收起键盘后往往还要点下面的建议继续加；
     *    真正收起建议的动作是"点编辑器外空白处"（页面 onPageTap → collapseSuggest）。 */
    flush() { this.flushCore(true); },
    flushKeepSuggest() { this.flushCore(false); },
    flushCore(clearSuggest) {
      if (clearSuggest) {
        // 输入框仍有残留时收起建议（已生成 chip 的内容无需再建议）
        this.setData({ suggestions: [], showSuggest: false, suggestDone: false });
      }
      const v = String(this.data.input || '').replace(/^[#＃\s　，,；;、|]+/, '').trim();
      if (v) {
        const topics = this.data.topics.slice();
        if (this.addUnique(topics, v)) {
          this.setData({ topics });
          this.emit();
        }
      }
      this.setData({ input: '' });
    },

    /** 把最新话题数组 emit 成规范串交给页面 */
    emit() {
      this.triggerEvent('change', { value: topic.build(this.data.topics) });
    },

    // ============ 输入 ============
    /** 输入时：遇分隔符自动把已完成的词转 chip；未完成部分留在输入框；防抖检索建议 */
    onInput(e) {
      // 输入新内容 = 之前的"点建议"意图作废（防 touch 兜底误触发过期 pick）
      clearTimeout(this._pickTimer);
      this._picking = false;
      this._pickItem = null;
      const raw = String(e.detail.value || '');
      // 去掉开头分隔符（用户手打的 # 或误触空格），只保留有效内容
      const val = raw.replace(/^[#＃\s　，,；;、|]+/, '');
      // 是否以分隔符结尾：是 → 当前最后一个词也"已完成"，立即转 chip（否则要等下一个词/失焦）
      const endsSep = /[#＃\s　，,；;、|]$/.test(raw);
      const parts = val.split(/[#＃\s　，,；;、|]+/).filter(Boolean);
      const topics = this.data.topics.slice();
      let changed = false;
      // 需转 chip 的词：以分隔符结尾时全部完成；否则最后一个词还在输入中
      const complete = endsSep ? parts : parts.slice(0, -1);
      complete.forEach(function (p) { if (this.addUnique(topics, p)) changed = true; }, this);
      const rest = endsSep ? '' : (parts[parts.length - 1] || '');
      this.setData({ topics: topics, input: rest });
      if (changed) this.emit();
      // 防抖检索建议：停顿 250ms 后才查库，不阻塞打字
      clearTimeout(this._suggestTimer);
      const kw = val.trim();
      if (!kw) {
        this.setData({ suggestions: [], showSuggest: false, suggestDone: false });
        return;
      }
      this._suggestTimer = setTimeout(() => this.searchSuggestions(kw), 250);
    },

    /** 键盘"完成"键 → 当前输入转 chip，但保留建议下拉（收起键盘≠不要建议） */
    onConfirm() {
      this.flushKeepSuggest();
    },

    /** 失焦：非建议交互时把输入转 chip（保证滚动/点发布时不丢词）。
     *  注意：正在点建议（_picking）时不能清空建议——微信里 blur 先于 tap 触发，
     *  而且键盘收起时第一次 tap 常被系统吃掉（表现为"点击添加无反应"）。
     *  对策：手指按建议时由 touch 记录意图 _pickItem，blur 后若 tap 没跟上
     *  （被吃掉），延迟 150ms 由定时器兜底执行"点选"。 */
    onBlur() {
      const picking = this._picking;
      if (picking) {
        clearTimeout(this._pickTimer);
        this._pickTimer = setTimeout(() => {
          if (!this._picking) return; // touchcancel 已取消本次点选
          this.doPick(this._pickItem);
        }, 150);
        return; // 别移除建议：等 tap 或定时兜底处理
      }
      this._picking = false;
      this._pickItem = null;
      // 失焦（收起键盘）≠ 不要建议：只把输入转 chip 并保留建议下拉，
      // 用户收起键盘后往往还要点下面的建议继续加；
      // 真正收起建议的动作是"点编辑器外空白处"（页面 onPageTap → collapseSuggest）。
      this.flushKeepSuggest();
    },

    // ============ 建议 ============
    /** 手指按到某条建议：记录意图（touch 一定在 blur/tap 之前触发，不会被键盘吃掉） */
    onItemTouchStart(e) {
      this._picking = true;
      this._pickItem = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset.item : '';
    },
    /** 触摸被中断（滑动走 / 系统打断）→ 取消本次点选意图 */
    onItemTouchCancel() {
      this._picking = false;
      this._pickItem = null;
    },

    /** 点建议 → 添加为 chip、清输入、收起建议（tap 正常送达的路径） */
    tapSuggestion(e) {
      clearTimeout(this._pickTimer);
      const t = e.currentTarget.dataset.item;
      this.doPick(t);
    },

    /** 真正执行"点选某条建议"。tap 与 blur 兜底都汇到这里，天然去重。 */
    doPick(t) {
      const item = String(t == null ? '' : t).trim();
      if (!item) return;
      const topics = this.data.topics.slice();
      if (this.addUnique(topics, item)) {
        this.setData({ topics });
        this.emit();
      }
      this.setData({ input: '', suggestions: [], showSuggest: false, suggestDone: false });
      this._picking = false; // 完成本次点选，恢复"失焦即 flush"的正常行为
      this._pickItem = null;
    },

    /** 删除一个 chip */
    removeTopic(e) {
      const idx = e.currentTarget.dataset.index;
      if (typeof idx !== 'number') return;
      const topics = this.data.topics.slice();
      topics.splice(idx, 1);
      this.setData({ topics });
      this.emit();
    },

    /** 检索建议：猫名（前缀匹配）+ 已有话题（包含匹配），合并去重后 top 8 */
    async searchSuggestions(kw) {
      const esc = guard.escapeRegExp(kw);
      const catName = this.data.catName || '';
      const results = [];
      try {
        // 两个查询并行；任一失败不阻塞另一个
        const cats = await db.find('BITZH', { name: { $regex: '^' + esc, $options: 'i' } }, { limit: 6 });
        const pages = await db.find('Page', { relative: { $regex: esc, $options: 'i' } }, { limit: 6 });
        (cats || []).forEach(function (c) {
          if (c && c.name && String(c.name) !== catName) results.push(String(c.name));
        });
        (pages || []).forEach(function (p) {
          topic.parse(p && p.relative).forEach(function (t) { if (t !== catName) results.push(t); });
        });
      } catch (err) {
        console.error('话题建议查询失败', err);
      }
      // 去重 + 排除已选 + 截断 8 条（保留先出现的猫名优先）
      const seen = {};
      const cur = this.data.topics;
      const list = [];
      results.forEach(function (t) {
        if (seen[t]) return;
        if (cur.indexOf(t) >= 0) return;
        seen[t] = true;
        list.push(t);
      });
      this.setData({ suggestions: list.slice(0, 8), showSuggest: true, suggestDone: true });
    },
  },
});
