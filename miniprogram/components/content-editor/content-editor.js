// ============================================================
// components/content-editor/content-editor.js —— 内容编辑器（正文 + 话题合并）
// 【作用】把 addBooklet / editBooklet 的"正文 + 话题"合并成小红书/抖音式单输入：
//          - 正文直接在 textarea 里打；
//          - 点「#话题」按钮 → 正文末尾追加 #（末尾非分隔符时自动补空格），光标停在末尾；
//          - 输完按 空格/回车/失焦 → 末尾 #话题 剥离成下方胶囊；
//          - 输入 #话题 时防抖检索"已有猫名 + 已有话题"给建议，点选即入胶囊
//            （保留原 topic-editor 的话题搜索功能）；
//          - 提交时 flush 兜底：把末尾未提交、前位是分隔符/开头的 #话题 转胶囊。
//        存储格式与旧版完全兼容：change 事件输出 { main, relative }，
//        relative 为 "#话题 #话题" 规范串（topic.build），页面写回 listData，
//        展示端（bookletDetail / index / catDetail / someBooklet）零改动。
// ============================================================
const db = require('../../utils/db.js');
const guard = require('../../utils/guard.js');
const topic = require('../../utils/topic.js');
const catForm = require('../../utils/catForm.js'); // 猫名识别（真实名/别名/曾用名/昵称），给建议里的猫名加 🐱

Component({
  properties: {
    /** 正文（页面回填 / 草稿恢复 / 上次数据恢复用），只作种子，不做反向同步 */
    main: { type: String, value: '' },
    /** 话题规范串（同上，兼容脏格式，topic.parse 解析） */
    relative: { type: String, value: '' },
    /** 正文最大长度（与旧正文 textarea 一致） */
    maxlength: { type: Number, value: 2000 },
    /** textarea 占位提示 */
    placeholder: { type: String, value: '输入正文内容，点「#话题」按钮添加话题' },
    /** 当前猫名（建议里排除自己，避免把猫名自身当话题重复建议） */
    catName: { type: String, value: '' },
  },

  data: {
    body: '',            // 正文（唯一事实源，同步给 main）
    topics: [],          // 已生成的话题数组（不含 #，同步给 relative）
    focusMain: false,    // 瞬态：追加 # 时聚焦 textarea；自然失焦 / 离开页面时复位（避免返回页面时抢焦点）
    cursor: -1,          // 程序化改正文后的光标位置（尽量贴合末尾；-1 = 不指定）
    suggestions: [],     // 建议列表（猫名 + 已有话题，去重后；每项 {name, isCat}）
    showSuggest: false,  // 是否显示建议下拉
    suggestDone: false,  // 最近一次检索是否已完成（用于"无匹配"空态）
    suggestMaxH: 320,    // 建议下拉最大高度（px；动态=窗口高-键盘高-正文底部，保证不越过键盘）
    kbH: 0,              // 键盘高度（px）：键盘上方工具栏「话题/完成」fixed bottom 用
    showToolbar: false,  // 是否显示键盘上方工具栏（正文聚焦时 true，替代正文里的 #话题 按钮）
  },

  observers: {
    main: function (val) { this.seedBody(val); },
    relative: function (val) { this.seedTopics(val); },
  },

  lifetimes: {
    attached() {
      // 双保险：个别时序下属性先于 observers 生效，attached 里再 seed 一次
      this.seedBody(this.data.main);
      this.seedTopics(this.data.relative);
      // 监听键盘高度：建议列表最大高度 = 窗口高 - 键盘高 - 输入框底，保证列表底边不越过键盘；
      // 同时把 kbH 写入 data，供键盘上方工具栏 fixed bottom 定位
      this._onKbHeight = (res) => {
        const h = (res && res.height) || 0;
        this._kbH = h;
        if (this.data.kbH !== h) this.setData({ kbH: h });
        if (this.data.showSuggest) this.updateSuggestMaxH();
      };
      if (wx.onKeyboardHeightChange) wx.onKeyboardHeightChange(this._onKbHeight);
    },
    detached() {
      clearTimeout(this._suggestTimer);
      clearTimeout(this._pickTimer);
      if (wx.offKeyboardHeightChange && this._onKbHeight) wx.offKeyboardHeightChange(this._onKbHeight);
    },
  },

  pageLifetimes: {
    hide() {
      // 离开页面：复位瞬态聚焦，防止返回本页时 textarea 抢键盘
      if (this.data.focusMain) this.setData({ focusMain: false });
    },
  },

  methods: {
    noop() {},

    // ============ 种子（外部回填 main/relative → body/topics） ============

    /** 正文回填：内容没变不重复 setData。微信 observers 值不变也触发，
     *  页面每键回灌 main（值相同）若无此守卫会重绑 textarea 值 → 光标跳/闪烁。 */
    seedBody(val) {
      const v = val == null ? '' : String(val);
      if (v === this.data.body) return;
      this.setData({ body: v });
    },

    /** 话题回填：topic.parse 兼容全部脏格式；JSON 比较守卫防无谓重渲染 */
    seedTopics(val) {
      const arr = topic.parse(val);
      const cur = this.data.topics;
      if (JSON.stringify(arr) === JSON.stringify(cur)) return;
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
     *  只收建议、不清正文/话题——用户可能只是想去点别的字段，回来还能接着打。 */
    collapseSuggest() {
      this._suggestInteracting = false; // 收起建议 = 退出列表交互
      this.setData({ suggestions: [], showSuggest: false, suggestDone: false });
    },

    /** 页面点击输入区外部（由 onPageTap 调用）：取消「#话题」按钮按下标记，
     *  避免"点完按钮立刻点外部"被 onBodyBlur 误判成按钮失焦而重新聚焦。 */
    cancelBtnTap() {
      this._btnTapAt = 0;
    },

    // ============ 对外 flush（提交兜底） ============

    /** 提交前兜底：把正文末尾未提交的 #话题 转胶囊，并同步 emit 让页面拿到最新 relative。
     *   flush()：供页面 confirm() 调用 → 转 chip 并收起建议；
     *   flushKeepSuggest()：供回车/失焦调用 → 转 chip 但保留建议（收起键盘≠不要建议）。 */
    flush() { this.flushCore(true); },
    flushKeepSuggest() {
      this.flushCore(false);
      // 提交后正文末尾若无待定 #片段 → 自动收起建议（有则继续检索，保持一致性）
      this.maybeSuggest();
    },
    flushCore(clearSuggest) {
      if (clearSuggest) {
        this.setData({ suggestions: [], showSuggest: false, suggestDone: false });
      }
      // 末尾未提交话题：循环剥离（只取最后一个会把 "#猫 #狗" 里的 "#猫" 留在正文）。
      // 前位必须是"空白/分隔符/开头"，防把正文中间手写的 #（如 "今天#小猫很可爱"）误提交。
      let body = String(this.data.body || '');
      const topics = this.data.topics.slice();
      let changed = false;
      let m;
      while ((m = body.match(/(^|[\s　，,；;、|])([#＃][^#＃\s　，,；;、|]+)$/))) {
        const name = m[2];
        body = body.slice(0, body.length - name.length - m[1].length);
        if (this.addUnique(topics, name)) changed = true;
      }
      // 正文/话题任一变化都要写回（正文剥离是必须的，重复话题也要剥，防内容丢失）
      if (changed || body !== String(this.data.body || '')) {
        this.setData({ body: body, topics: topics, cursor: body.length });
        this.emitChange();
      }
    },

    /** 把最新 body + topics emit 成 { main, relative } 交给页面（每次输入/增删都触发） */
    emitChange() {
      this.triggerEvent('change', {
        main: String(this.data.body || ''),
        relative: topic.build(this.data.topics),
      });
    },

    /** 程序化改正文：统一收口，光标尽量停在末尾（变更都发生在末尾，天然贴末尾） */
    applyBody(next) {
      this.setData({ body: next, cursor: next.length });
    },

    // ============ 输入 ============

    /** 「#话题」按钮按下：记录时间戳。真机点按钮可能让 textarea 失焦（iOS 更常见），
     *  onBodyBlur 据此区分"点按钮的失焦"与"真失焦"——前者重新聚焦并阻止页面还原图片区。 */
    onBtnTouchStart() {
      this._btnTapAt = Date.now();
    },

    /** 点「#话题」按钮：正文末尾追加 #。末尾是普通文字时先补空格，保证 token 边界
     *  （否则 flush 的"前位分隔符"守卫不通过，话题永远提交不了）。
     *  末尾已有"分隔符/开头 + 空 #"时是无效操作，不重复追加（避免 "##"）。 */
    appendHash() {
      const cur = String(this.data.body || '');
      if (/(^|[#＃\s　，,；;、|])#$/.test(cur)) return; // 末尾已是空 #，再点无意义
      const sep = (cur === '' || /[\s　，,；;、|#＃]$/.test(cur)) ? '' : ' ';
      const body = cur + sep + '#';
      this.setData({ body: body, cursor: body.length });
      // 焦点脉冲：点按钮常先让 textarea 失焦（iOS 更常见）。此刻 tap 已执行完、正文已写入，
      // 再重新聚焦不会被"失焦后立即聚焦"吞掉 tap。仍聚焦（_focused）则直接置 true 幂等；
      // 已失焦则 false→true 脉冲触发真实聚焦（光标贴末尾，继续打话题）。
      if (this._focused) {
        this.setData({ focusMain: true });
      } else {
        const self = this;
        this.setData({ focusMain: false });
        wx.nextTick(function () {
          self.setData({ focusMain: true, cursor: String(self.data.body || '').length });
        });
      }
      this.emitChange();
      // 点「#话题」按钮：直接弹出全部话题列表（猫名 + 历史话题），供点选。
      // 清掉旧的防抖检索，避免用户此前输入遗留的定时器把"全部话题"覆盖成旧关键词结果。
      clearTimeout(this._suggestTimer);
      this.showAllTopics();
    },

    /** 弹出全部话题列表（猫名 + 已有话题，无关键词过滤）。
     *  点「#话题」按钮进入：不在正文残留可搜索的孤立片段，直接给完整候选。 */
    showAllTopics() {
      this.searchSuggestions('');
    },

    onBodyInput(e) {
      this._btnTapAt = 0; // 开始输入 = "#话题"按钮交互已结束（防陈旧标记把下一次真失焦误判成点按钮）
      // 输入新内容 = 之前的"点建议"意图作废（防 touch 兜底误触发过期 pick）
      clearTimeout(this._pickTimer);
      this._picking = false;
      this._pickItem = null;
      this._suggestInteracting = false; // 开始打字 = 手指已离开建议列表
      const raw = String(e.detail.value || '');
      // 末尾有空格/换行 → 末尾话题串视为已完成，剥离成胶囊
      const hit = this.extractOnInput(raw);
      if (hit) {
        this.commitRun(hit.body, hit.topics);
      } else {
        this.setData({ body: raw }); // 不打 cursor：输入进行中，保持微信输入光标
      }
      this.maybeSuggest(); // 防抖检索建议（针对正文末尾正在打的 #话题）
    },

    /** 末尾有分隔符（空格/换行）才提交：一次收末尾连续多个 #话题，正文保留 m[1] */
    extractOnInput(v) {
      const m = /^(.*?)((?:[#＃][^#＃\s　，,；;、|]+[ \t　]*)+)[ \t　\n]+$/.exec(v);
      if (!m) return null;
      const names = m[2].split(/[#＃\s　，,；;、|]+/).filter(Boolean);
      return { body: String(m[1] || ''), topics: names };
    },

    /** 把一组话题入胶囊 + 剥离正文（无论去重是否入队，正文都剥离，防内容丢失） */
    commitRun(body, names) {
      const topics = this.data.topics.slice();
      names.forEach((t) => this.addUnique(topics, t));
      this.applyBody(body);
      this.setData({ topics: topics });
      this.emitChange();
    },

    /** 回车/完成键：末尾未提交 #话题 → 转胶囊；建议保留（收起键盘≠不要建议） */
    onBodyConfirm() {
      this.flushKeepSuggest();
    },

    /** 聚焦：通知页面（页面借此压缩图片区、给建议列表腾位）；显示键盘上方工具栏。 */
    onBodyFocus() {
      this._focused = true;
      this._btnTapAt = 0; // 已重新聚焦，按钮失焦的兜底重聚焦不再需要
      this.setData({ showToolbar: true });
      this.triggerEvent('editorfocus');
    },

    /** 页面点击编辑器外空白处 / 点图片或标题时调用：主动收回聚焦，还原布局。
     *  部分平台 focus=false 不一定真收起软键盘，用 wx.hideKeyboard 兜底（无键盘时为无操作）。 */
    blurMain() {
      this.setData({ focusMain: false, showToolbar: false });
      if (wx.hideKeyboard) wx.hideKeyboard();
    },

    /** 失焦：通知页面还原图片区；非建议交互时把末尾未提交话题转胶囊（保证滚动/点发布时不丢词）。
     *  注意：正在点建议（_picking）时不能清空建议——微信里 blur 先于 tap 触发，
     *  而且键盘收起时第一次 tap 常被系统吃掉（表现为"点击添加无反应"）。
     *  对策：手指按建议时由 touch 记录意图 _pickItem，blur 后若 tap 没跟上
     *  （被吃掉），延迟 150ms 由定时器兜底执行"点选"。 */
    onBodyBlur() {
      this._focused = false;
      // 刚点过「#话题」按钮导致的失焦（真机点按钮可能让 textarea 失焦，iOS 更常见）：
      // 不该让页面还原图片布局。重新聚焦交给 appendHash（tap）按 _focused 脉冲完成。
      if (this._btnTapAt && (Date.now() - this._btnTapAt) < 300) {
        this._btnTapAt = 0;
        // 点「#话题」按钮导致的失焦：不还原图片、不清建议、也不 flush。
        // 【关键】这里【不】重新聚焦——重新聚焦交给 appendHash（tap）按 _focused 脉冲完成。
        // 之前在 nextTick 里重新聚焦，会在 tap 送达前把焦点抢走，iOS 上直接吞掉 tap，
        // 表现为"点话题只有图片放大又缩回、没出 # 也没出列表"。
        return;
      }
      this._btnTapAt = 0;
      // 正在点建议（_picking）：微信里 blur 先于 tap，这次失焦是点选流程的一部分。
      // 不通知页面还原（图片区保持压缩），等 tap 或 150ms 定时兜底完成点选，
      // doPick 里会重新聚焦 textarea 继续打下一个话题。
      if (this._picking) {
        clearTimeout(this._pickTimer);
        this._pickTimer = setTimeout(() => {
          if (!this._picking) return; // touchcancel 已取消本次点选
          this.doPick(this._pickItem);
        }, 150);
        return; // 别移除建议：等 tap 或定时兜底处理
      }
      // 正在与建议列表交互（滑动/按住列表）：真机滑动列表常让 textarea 失焦，
      // 但这不是"离开输入"，不该还原图片、不清建议、也不 flush（末尾 # 片段仍在输入中）。
      if (this._suggestInteracting) {
        return;
      }
      // 自然失焦 → 复位瞬态聚焦（防返回页面时抢键盘）；收起键盘上方工具栏
      this._suggestInteracting = false;
      this.setData({ focusMain: false, showToolbar: false });
      this.triggerEvent('editorblur');
      this._picking = false;
      this._pickItem = null;
      this.flushKeepSuggest();
    },

    // ============ 建议下拉（保留原话题搜索功能） ============

    /** 防抖检索：正文末尾正在打的 #话题 片段（最后一个 # 之后到末尾的文字）作为关键词 */
    maybeSuggest() {
      clearTimeout(this._suggestTimer);
      const kw = this.pendingKeyword();
      if (!kw) {
        this.setData({ suggestions: [], showSuggest: false, suggestDone: false });
        return;
      }
      this._suggestTimer = setTimeout(() => this.searchSuggestions(kw), 250);
    },

    /** 计算建议下拉最大高度：窗口高 - 键盘高 - 正文底部 - 边距，钳制在 [40, 360]，
     *  保证列表底边不越过键盘顶（超出部分内部滚动）。基准是正文 textarea 底部（.ce-textarea-wrap）。 */
    updateSuggestMaxH() {
      const self = this;
      wx.nextTick(function () {
        self.createSelectorQuery().select('.ce-textarea-wrap').boundingClientRect(function (rect) {
          if (!rect) return;
          const winH = (typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo().windowHeight : 0) || 640;
          const kbH = self._kbH || 0;
          let maxH = winH - kbH - rect.bottom - 12;
          if (maxH < 40) maxH = 40;
          if (maxH > 360) maxH = 360;
          self.setData({ suggestMaxH: Math.round(maxH) });
        }).exec();
      });
    },

    /** 取正文末尾未提交的 #片段 文字（无则空串） */
    pendingKeyword() {
      const body = String(this.data.body || '');
      const m = /([#＃])([^#＃\s　，,；;、|]*)$/.exec(body);
      if (!m) return '';
      return String(m[2] || '').trim();
    },

    /** 手指按到某条建议：记录意图（touch 一定在 blur/tap 之前触发，不会被键盘吃掉）；
     *  同时标记"正在与建议列表交互"，滑动/按住列表期间的 textarea 失焦不还原图片。 */
    onItemTouchStart(e) {
      this._picking = true;
      this._suggestInteracting = true;
      this._pickItem = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset.item : '';
    },
    /** 手指在建议上移动 = 正在滚动列表，不是点选 → 取消点选意图（防滚动后残留误选）；
     *  但保留 _suggestInteracting：滑动列表也是"与列表交互"，期间的失焦不还原图片。 */
    onItemTouchMove() {
      this._picking = false;
      this._pickItem = null;
    },
    /** 手指离开建议列表（正常抬起）→ 结束"列表交互"标记 */
    onItemTouchEnd() {
      this._suggestInteracting = false;
    },
    /** 触摸被中断（滑动走 / 系统打断）→ 取消本次点选意图 + 结束列表交互标记 */
    onItemTouchCancel() {
      this._picking = false;
      this._pickItem = null;
      this._suggestInteracting = false;
    },

    /** 点建议 → 添加为胶囊、剥离正文里的 #片段、收起建议（tap 正常送达的路径） */
    tapSuggestion(e) {
      clearTimeout(this._pickTimer);
      const t = e.currentTarget.dataset.item;
      this.doPick(t);
    },

    /** 真正执行"点选某条建议"。tap 与 blur 兜底都汇到这里，天然去重。
     *  正文末尾若有 #片段，一并剥离（点选 = 该片段替换为所选话题）。 */
    doPick(t) {
      const item = String(t == null ? '' : t).trim();
      if (!item) return;
      const body = String(this.data.body || '').replace(/([#＃][^#＃\s　，,；;、|]*)$/, '');
      const topics = this.data.topics.slice();
      this.addUnique(topics, item);
      this.setData({
        body: body,
        topics: topics,
        cursor: body.length,
        suggestions: [],
        showSuggest: false,
        suggestDone: false,
      });
      this.emitChange();
      this._picking = false; // 完成本次点选，恢复"失焦即 flush"的正常行为
      this._pickItem = null;
      this._suggestInteracting = false; // 点选完成 = 离开列表交互
      // 点选后保持输入聚焦（继续打下一个话题/正文）。点建议会先 blur（微信 blur 先于 tap），
      // 若已失焦（_focused=false）就重新聚焦 textarea：此刻 focusMain 是陈旧 true，
      // 先复位再置 true 触发真实聚焦，不会二次 blur；若平台没失焦则无需处理。
      if (!this._focused) {
        this.setData({ focusMain: false });
        const self = this;
        wx.nextTick(function () {
          self.setData({ focusMain: true, cursor: String(self.data.body || '').length });
        });
      }
    },

    /** 检索建议：猫名（前缀匹配，标 🐱）+ 已有话题（包含匹配，命中猫名/别名也标 🐱），合并去重后 top N */
    async searchSuggestions(kw) {
      const esc = guard.escapeRegExp(kw);
      const catName = this.data.catName || '';
      const all = !kw; // 空关键词 = 点「#话题」按钮 → 展示全部话题（不带关键词过滤）
      const limit = all ? 20 : 10;
      const entries = []; // [{name, isCat}]，猫名在前、话题在后（去重时猫名优先）
      try {
        // 真实猫名（BITZH.name 前缀匹配）→ 一定是猫名，标 🐱
        const cats = await db.find('BITZH', all ? {} : { name: { $regex: '^' + esc, $options: 'i' } }, { limit });
        (cats || []).forEach(function (c) {
          if (c && c.name && String(c.name) !== catName) entries.push({ name: String(c.name), isCat: true });
        });
        // 历史话题（Page.relative 解析）→ 可能是猫名（含别名/曾用名/昵称），用 catForm 反查打标
        const pages = await db.find('Page', all ? {} : { relative: { $regex: esc, $options: 'i' } }, { limit });
        const pageTopics = [];
        db.filterHidden(pages).forEach(function (p) {
          topic.parse(p && p.relative).forEach(function (t) { if (t !== catName) pageTopics.push(t); });
        });
        const catSet = await this.markCatTopics(pageTopics);
        pageTopics.forEach(function (t) {
          entries.push({ name: t, isCat: !!catSet[t] });
        });
      } catch (err) {
        console.error('话题建议查询失败', err);
      }
      // 去重（先猫名后话题）+ 排除已选 + 截断
      const seen = {};
      const cur = this.data.topics;
      const list = [];
      entries.forEach(function (e) {
        if (!e || seen[e.name]) return;
        if (cur.indexOf(e.name) >= 0) return;
        seen[e.name] = true;
        list.push(e);
      });
      this.setData({ suggestions: list.slice(0, all ? 24 : 12), showSuggest: true, suggestDone: true });
      this.updateSuggestMaxH(); // 按键盘高 + 正文位置约束下拉高度
    },

    /** 话题数组 → 命中猫名的话题集合（真实名/别名/曾用名/昵称任一独立词命中即算猫名）。
     *  复用 catForm.topicCatFilter + aliasContains，与 catDetail/bookletDetail 的判定口径一致。 */
    async markCatTopics(topics) {
      const list = (topics || []).filter(Boolean);
      if (!list.length) return {};
      const filter = catForm.topicCatFilter(list);
      if (!filter) return {};
      try {
        const matched = await db.find('BITZH', filter, { limit: 200 });
        const set = {};
        (matched || []).forEach(function (c) {
          const stack = [c.name, c.otherName, c.usedName, c.nickname].filter(Boolean).join(' ');
          list.forEach(function (t) {
            if (catForm.aliasContains(stack, t)) set[t] = true;
          });
        });
        return set;
      } catch (e) {
        console.error('猫名标注失败', e);
        return {};
      }
    },

    /** 「完成」按钮（键盘上方工具栏右端）：完全退出话题输入——收列表 + 还原图片 + 收起键盘。
     *  与"点页面外部"等价，但由键盘上方工具栏显式触发。 */
    collapseAll() {
      clearTimeout(this._pickTimer);
      this._picking = false;
      this._pickItem = null;
      this._suggestInteracting = false;
      this.setData({ suggestions: [], showSuggest: false, suggestDone: false, focusMain: false, showToolbar: false });
      if (wx.hideKeyboard) wx.hideKeyboard();
      this.triggerEvent('editorblur'); // 通知页面还原图片区
    },

    // ============ 胶囊 ============

    /** 删除一个胶囊 */
    removeTopic(e) {
      const idx = e.currentTarget.dataset.index;
      if (typeof idx !== 'number') return;
      const topics = this.data.topics.slice();
      topics.splice(idx, 1);
      this.setData({ topics: topics });
      this.emitChange();
    },
  },
});
