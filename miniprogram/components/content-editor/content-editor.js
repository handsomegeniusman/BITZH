// ============================================================
// components/content-editor/content-editor.js —— 内容编辑器（正文 + 话题混写）
// 【作用】把 addBooklet / editBooklet 的"正文 + 话题"合并成小红书/抖音式单输入：
//          - 正文直接写在 textarea 里，话题以 #话题 形式【内联】写在正文中（无胶囊行）；
//          - 点「#话题」按钮 → 正文末尾追加 #（末尾非分隔符时自动补空格），弹键盘；
//          - 弹建议：点按钮 / 刚输入 #（无关键词）→ 弹【固定初始列表】（秒开不查库，
//            本地有上次全量查询的缓存则用缓存替换写死列表）；输入关键词命中才查数据库
//            （已有猫名 + 已有话题，猫名标 🐱），点选即追加到正文结尾；
//          - 提交/回车/失焦/完成 → 从混写正文统一解析话题（含正文中间的话题）。
//        存储格式与旧版完全兼容：change 事件输出 { main, relative }，
//        main = 剥离话题后的纯正文、relative = "#话题 #话题" 规范串（topic.build），
//        页面写回 listData，展示端（bookletDetail / index / catDetail / someBooklet）零改动。
// ============================================================
const db = require('../../utils/db.js');
const guard = require('../../utils/guard.js');
const topic = require('../../utils/topic.js');
const catForm = require('../../utils/catForm.js'); // 猫名识别（真实名/别名/曾用名/昵称），给建议里的猫名加 🐱
const kbHeight = require('../../utils/kbHeight.js'); // 可靠键盘高度管理器（忽略0+多源并收+轮询+显式清零）

// 话题 token 的构成：半角/全角井号 + 一串非分隔符。分隔符 = 各种空白（含全角空格）+ 半全角标点 + # 本身。
// （匹配正则定义在 extractTopics / stripTopics 内，每次调用新建，避免 /g 的 lastIndex 残留。）

// 【固定初始话题】点「#话题」/ 输入 # 且未输入关键词时展示，秒开不查库。
// 本地有"上次全量查询"的缓存（TOPIC_CACHE_KEY）时，自动用缓存替换此列表。
// 内容可在此按需增删（这里是通用话题种子；真实猫名/历史话题由缓存与关键词查询补充）。
const HARDCODED_TOPICS = [
  { name: '在校', isCat: false },
  { name: '送养', isCat: false },
  { name: '领养', isCat: false },
  { name: '求领养', isCat: false },
  { name: '猫咪日常', isCat: false },
  { name: '今日份猫咪', isCat: false },
  { name: '猫粮', isCat: false },
  { name: '驱虫', isCat: false },
  { name: '绝育', isCat: false },
  { name: '疫苗', isCat: false },
  { name: '体检', isCat: false },
];
const TOPIC_CACHE_KEY = 'ce_topicCache_v1'; // 全量话题建议的本地缓存（写死列表的替换源）
const CACHE_REFRESH_MS = 30000;             // 后台刷新缓存的节流间隔（同一 30s 内不重复查库）

Component({
  properties: {
    /** 正文（页面回填 / 草稿恢复 / 上次数据恢复用），只作种子，不做反向同步 */
    main: { type: String, value: '' },
    /** 话题规范串（同上，兼容脏格式，topic.parse 解析） */
    relative: { type: String, value: '' },
    /** 正文最大长度（与旧正文 textarea 一致） */
    maxlength: { type: Number, value: 2000 },
    /** textarea 占位提示 */
    placeholder: { type: String, value: '添加正文或话题' },
    /** 当前猫名（建议里排除自己，避免把猫名自身当话题重复建议） */
    catName: { type: String, value: '' },
    /** 禁用输入（删除确认弹窗打开等弹窗盖在输入区上的场景由页面置 true）：
     *  textarea 转 disabled，从根源上杜绝 iOS 点击弹窗穿透聚焦正文、弹系统键盘 */
    disabled: { type: Boolean, value: false },
  },

  data: {
    body: '',            // 正文（唯一事实源：正文 + #话题 混写，同步给 main/relative）
    focusMain: false,    // 瞬态：追加 # 时聚焦 textarea；自然失焦 / 离开页面时复位（避免返回页面时抢焦点）
    cursor: -1,          // 程序化改正文后的光标位置（尽量贴合末尾；-1 = 不指定）
    suggestions: [],     // 建议列表（固定列表/缓存/关键词查询，去重后；每项 {name, isCat}）
    showSuggest: false,  // 是否显示建议下拉
    suggestDone: false,  // 最近一次检索是否已完成（用于"无匹配"空态）
    suggestMaxH: 320,    // 建议下拉最大高度（px；动态=窗口高-键盘高-工具栏-输入框底，保证不越过键盘）
    suggestH: 320,       // 建议下拉实际高度（px）= 内容高（刚好展示在 # 号下一行），封顶 suggestMaxH
    ceMaxH: 9999,        // 正文 textarea 最大高度（px；9999=不限制）。聚焦时按「输入框顶→键盘顶」
                         // 动态分配（layoutSuggest）：保证光标不被键盘盖住 + 列表始终有位置展示
    kbH: 0,              // 键盘高度（px）：键盘上方工具栏「话题/完成」fixed bottom 用
    kbUp: false,         // 键盘是否弹起（订阅管理器推得）：门控工具栏显示（见 ce-kb-bar），
                         // 键盘收起时工具栏跟随隐藏，避免失焦后仍悬在屏幕底部
    showToolbar: false,  // 是否显示键盘上方工具栏（正文聚焦时 true，替代正文里的 #话题 按钮）
  },

  observers: {
    // main / relative 任一变化都重拼正文（两字段合并成混写正文）
    'main, relative': function () { this.seedBody(); },
  },

  lifetimes: {
    attached() {
      // 双保险：个别时序下属性先于 observers 生效，attached 里再 seed 一次
      this.seedBody();
      // 订阅 kbHeight 管理器（多源并收 + 轮询兜底 + 显式清零，规避 wx.onKeyboardHeightChange
      // 在 iOS/安卓的已知缺陷）：
      //   - _kbH = 键盘高度，供 layoutSuggest 算「输入框顶→键盘顶」可用空间；
      //   - kbH 写入 data，供键盘上方工具栏「#话题/完成」fixed bottom 定位；
      //   - 高度变化会改变可用空间，防抖重排（键盘弹/收动画期间事件很密，不逐帧查布局）。
      this._unsubKb = kbHeight.subscribe((h, up) => {
        this._kbH = h;
        const patch = {};
        if (this.data.kbH !== h) patch.kbH = h;
        if (this.data.kbUp !== !!up) patch.kbUp = !!up; // 键盘收起（up=false）→ 工具栏跟随隐藏
        if (Object.keys(patch).length) this.setData(patch);
        if (this.data.showSuggest || this.data.showToolbar) this.scheduleLayout();
      });
    },
    detached() {
      clearTimeout(this._suggestTimer);
      clearTimeout(this._pickTimer);
      clearTimeout(this._layoutTimer);
      clearTimeout(this._focusLayoutTimer);
      if (this._unsubKb) this._unsubKb();
      this._unsubKb = null;
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

    // ============ 种子（外部回填 main/relative → body） ============

    /** 正文回填：main(纯正文) + relative("#话题 #话题") 拼成混写正文。
     *  用 _lastEmitted 防重灌：页面把我们刚输出的 main/relative 原样回灌时（值相同）跳过，
     *  否则每次 emit 都会把"正文中间的话题"移到末尾 → 跳字/话题位置乱跳。 */
    seedBody() {
      const main = String(this.data.main == null ? '' : this.data.main);
      const rel = String(this.data.relative == null ? '' : this.data.relative);
      if (this._lastEmitted && this._lastEmitted.main === main && this._lastEmitted.relative === rel) {
        return; // 编辑回灌：body 已最新，跳过
      }
      // 外部真实回填（草稿恢复 / 上次数据恢复）：纯正文 + 话题串拼成混写正文
      const parts = [main.replace(/\s+$/, ''), rel.replace(/^\s+/, '')]
        .filter(function (s) { return s.trim() !== ''; });
      const body = parts.join(' ');
      if (body !== this.data.body) this.setData({ body: body });
    },

    /** 页面点击编辑器外空白处时收起建议下拉（由页面 onPageTap 调用）。
     *  只收建议、不清正文——用户可能只是想去点别的字段，回来还能接着打。 */
    collapseSuggest() {
      this._suggestInteracting = false; // 收起建议 = 退出列表交互
      this.setData({ suggestions: [], showSuggest: false, suggestDone: false });
    },

    /** 页面点击输入区外部（由 onPageTap 调用）：取消「#话题」按钮按下标记，
     *  避免"点完按钮立刻点外部"被 onBodyBlur 误判成按钮失焦而重新聚焦。 */
    cancelBtnTap() {
      this._btnTapAt = 0;
    },

    // ============ 混写解析（正文 ⇆ main/relative） ============

    /** 从混写正文提取 #话题（去重保序，返回不含 # 的话题名数组）。
     *  @param {Boolean} includeTail 是否连"末尾正在打的 #片段"也算（提交兜底用）
     *  注意：每次调用都新建正则（带 /g 的 exec 会残留 lastIndex，复用模块级正则会漏匹配） */
    extractTopics(body, includeTail) {
      const s = String(body == null ? '' : body);
      const re = includeTail
        ? /[#＃]([^#＃\s　，,；;、|]+)/g
        : /[#＃]([^#＃\s　，,；;、|]+)(?=[\s　，,；;、|#＃])/g;
      const seen = {};
      const out = [];
      let m;
      while ((m = re.exec(s)) !== null) {
        const t = String(m[1] || '').trim();
        if (!t || seen[t]) continue;
        seen[t] = true;
        out.push(t);
      }
      return out;
    },

    /** 从混写正文剥离 #话题，剩纯正文（main）。
     *  去掉话题后把"话题两侧各留的空白"折叠成单个空格，但不动换行（保留段落）。 */
    stripTopics(body, includeTail) {
      const s = String(body == null ? '' : body);
      const re = includeTail
        ? /[#＃][^#＃\s　，,；;、|]+/g
        : /[#＃][^#＃\s　，,；;、|]+(?=[\s　，,；;、|#＃])/g;
      return s.replace(re, ' ').replace(/[ \t　]+/g, ' ').trim();
    },

    /** 把最新 body 解析成 { main, relative } 交给页面（每次输入/点选/提交都触发）。
     *  @param {Boolean} includeTail 提交兜底时传 true，连末尾未完成的 #片段 也算话题 */
    emitChange(includeTail) {
      const body = String(this.data.body || '');
      const topics = this.extractTopics(body, !!includeTail);
      const main = this.stripTopics(body, !!includeTail);
      const relative = topic.build(topics);
      this._lastEmitted = { main: main, relative: relative }; // ← 防重灌的关键
      this.triggerEvent('change', { main: main, relative: relative });
    },

    /** 提交/收尾兜底：把末尾未完成的 #片段 也算进话题，并收起建议。
     *  页面 confirm()、回车、自然失焦、完成都走这里（语义一致：收尾话题输入）。 */
    flush() {
      this.emitChange(true);
      this.collapseSuggest();
    },

    // ============ 输入 ============

    /** 「#话题」按钮按下：记录时间戳。真机点按钮可能让 textarea 失焦（iOS 更常见），
     *  onBodyBlur 据此区分"点按钮的失焦"与"真失焦"——前者重新聚焦并阻止页面还原图片区。 */
    onBtnTouchStart() {
      this._btnTapAt = Date.now();
    },

    /** 点「#话题」按钮：正文末尾追加 #。末尾是普通文字时先补空格，保证 token 边界。
     *  末尾已是"分隔符/开头 + 空 #"时不重复追加（避免 "##"），但照常弹键盘 + 列表。
     *  【安卓兼容】不能用"正在聚焦的 textarea 上直接 setData value"：安卓原生输入会话
     *  会覆盖/丢弃程序化改的值（表现为点按钮没反应、不显示 #）。必须【失焦 + 改值】同一帧
     *  setData（与 doPick 点选建议同款脉冲），下一帧再聚焦 + 光标贴末尾。此刻触发的真失焦
     *  由 onBodyBlur 按"点按钮的失焦"（_btnTapAt<300ms）提前返回，不还原布局、不清建议。 */
    appendHash() {
      const cur = String(this.data.body || '');
      const tailEmptyHash = /(^|[#＃\s　，,；;、|])#$/.test(cur);
      const body = tailEmptyHash
        ? cur
        : cur + ((cur === '' || /[\s　，,；;、|#＃]$/.test(cur)) ? '' : ' ') + '#';
      // 主动声明"正在输入正文"，让页面立即压缩图片，不依赖 textarea 聚焦事件链
      // （点按钮常先让 textarea 失焦、iOS 更常见，聚焦链路易被打断，见 Bug-D）。
      this.triggerEvent('editorfocus');
      kbHeight.cancelResetSoon(); // 点按钮 = 回到正文输入，作废"自然失焦"的延迟清零
      // 失焦 + 改值（同一帧 setData，值在非聚焦态写入，安卓原生不干扰）；
      // 下一帧聚焦 + 光标贴末尾（wx.nextTick 保证改值已渲染）
      this.setData({ body: body, cursor: -1, focusMain: false });
      const self = this;
      wx.nextTick(function () {
        self.setData({ focusMain: true, cursor: String(self.data.body || '').length });
      });
      this.emitChange();
      // 点「#话题」按钮：直接弹出固定初始列表（不查库，秒开），供点选。
      // 清掉旧的防抖检索，避免用户此前输入遗留的定时器把列表覆盖成旧关键词结果。
      clearTimeout(this._suggestTimer);
      this.showAllTopics();
    },

    /** 弹出固定初始话题列表（点「#话题」按钮进入）：
     *  优先用本地缓存（上次全量查询），无缓存用写死的 HARDCODED_TOPICS；后台刷新缓存。 */
    showAllTopics() {
      this.searchSuggestions('');
    },

    /** 输入：正文是唯一事实源，原样记录（不剥话题），再实时解析给页面 + 防抖检索建议 */
    onBodyInput(e) {
      this._btnTapAt = 0; // 开始输入 = "#话题"按钮交互已结束（防陈旧标记把下一次真失焦误判成点按钮）
      // 输入新内容 = 之前的"点建议"意图作废（防 touch 兜底误触发过期 pick）
      clearTimeout(this._pickTimer);
      this._picking = false;
      this._pickItem = null;
      this._suggestInteracting = false; // 开始打字 = 手指已离开建议列表
      const raw = String(e.detail.value || '');
      // 输入进行中保持微信原生光标：顺手把程序化移动过的 cursor 复位成 -1（不指定），
      // 否则上次 doPick/appendHash 留下的陈旧正数会在本次 value 重渲染时被 textarea 重放 → 光标跳位
      this.setData({ body: raw, cursor: -1 });
      this.emitChange(); // includeTail=false：末尾正在打的 #片段 暂不算话题
      this.maybeSuggest(); // 末尾有 # 片段才弹建议（刚输入 # 弹固定列表，打了字才查库）
    },

    /** 回车/完成键：收尾末尾未提交话题 + 收起建议 */
    onBodyConfirm() {
      this.flush();
    },

    /** textarea 逐元素键盘高度事件（bindkeyboardheightchange）→ 喂给管理器。
     *   iOS 上全局事件在"先聚焦 input 再聚焦 textarea"时可能完全不触发，
     *   textarea 自带的这个事件是可靠的补充来源（走管理器同一套"只认非0"合并规则）。 */
    onKbHeight(e) {
      const h = (e && e.detail && e.detail.height) || 0;
      kbHeight.feed(h);
    },

    /** 聚焦：通知页面（页面借此压缩图片区、给建议列表腾位）；显示键盘上方工具栏；
     *  并按当前键盘高/输入框位置重排「输入框高 + 建议列表高」（layoutSuggest）。 */
    onBodyFocus() {
      this._focused = true;
      this._btnTapAt = 0; // 已重新聚焦，按钮失焦的兜底重聚焦不再需要
      // 键盘可能已在弹起中（如从标题切到正文）：先取管理器的当前高度做布局基准，
      // 避免首帧按 0 算把正文放得太高（管理器在弹起期间一直持有实际高度）
      const st = kbHeight.get();
      if (st) {
        if (st.kbH) {
          this._kbH = st.kbH;
          if (this.data.kbH !== st.kbH) this.setData({ kbH: st.kbH });
        }
        // 键盘可能已在弹起中（如刚从标题切到正文）：同步 kbUp，工具栏不因延迟事件晚出
        if (this.data.kbUp !== !!st.kbUp) this.setData({ kbUp: !!st.kbUp });
      }
      kbHeight.cancelResetSoon(); // 重新聚焦 = 键盘状态作废上次"自然失焦"的延迟清零
      this.setData({ showToolbar: true });
      this.triggerEvent('editorfocus');
      this.layoutSuggest();
      this.ensureInputVisible(); // adjust-position=false 不自动滚页，输入区若被键盘盖住手动滚到可见
      // 页面收到 editorfocus 后图片区压缩是 0.3s 过渡，过渡结束布局才稳定，再校正一次
      const self = this;
      clearTimeout(this._focusLayoutTimer);
      this._focusLayoutTimer = setTimeout(function () {
        self.layoutSuggest();
        self.ensureInputVisible();
      }, 350);
    },

    /** 页面点击编辑器外空白处 / 点图片或标题时调用：主动收回聚焦，还原布局。
     *  部分平台 focus=false 不一定真收起软键盘，用 wx.hideKeyboard 兜底（无键盘时为无操作）。
     *  同时复位 _focused：页面说"已失焦"就是真失焦，防下次 appendHash 聚焦脉冲用陈旧标记判断。 */
    blurMain() {
      this._focused = false;
      kbHeight.reset(); // 页面明确收回聚焦 = 键盘收起，显式清零不等事件/轮询
      this.setData({ focusMain: false, showToolbar: false, ceMaxH: 9999, kbUp: false });
      if (wx.hideKeyboard) wx.hideKeyboard();
    },

    /** 失焦：通知页面还原图片区；非建议交互时收尾末尾未提交话题（保证滚动/点发布时不丢词）。
     *  注意：正在点建议（_picking）时不能清空建议——微信里 blur 先于 tap 触发，
     *  而且键盘收起时第一次 tap 常被系统吃掉（表现为"点击添加无反应"）。
     *  对策：手指按建议时由 touch 记录意图 _pickItem，blur 后若 tap 没跟上
     *  （被吃掉），延迟 150ms 由定时器兜底执行"点选"。 */
    onBodyBlur() {
      this._focused = false;
      // 刚点过「#话题」按钮导致的失焦（真机点按钮可能让 textarea 失焦，iOS 更常见）：
      // 不该让页面还原图片布局。重新聚焦交给 appendHash（tap）的"失焦+改值+下一帧聚焦"脉冲完成。
      if (this._btnTapAt && (Date.now() - this._btnTapAt) < 300) {
        this._btnTapAt = 0;
        // 点「#话题」按钮导致的失焦：不还原图片、不清建议、也不 flush。
        // 【关键】这里【不】重新聚焦——重新聚焦交给 appendHash（tap）的聚焦脉冲完成。
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
      // 自然失焦 → 复位瞬态聚焦（防返回页面时抢键盘）；收起键盘上方工具栏；收尾末尾话题
      // 键盘状态不立即清零（切输入框时键盘可能还弹着），延迟 300ms 若仍无新高度才复位，
      // 避免"切到标题时键盘高度被误清零、完成栏闪掉"（若已切到其它输入框，其 onFocus 会 cancelResetSoon）
      kbHeight.resetSoon(300);
      this._suggestInteracting = false;
      this.setData({ focusMain: false, showToolbar: false, ceMaxH: 9999 });
      this.triggerEvent('editorblur');
      this._picking = false;
      this._pickItem = null;
      this.flush();
    },

    // ============ 建议列表 ============

    /** 输入后的防抖检索：
     *   - 末尾没有 # 片段 → 隐藏建议；
     *   - 末尾是"刚输入的空 #" → 弹固定初始列表（秒开不查库）；
     *   - 末尾是"# + 文字" → 防抖 250ms 后按关键词查数据库（猫名 + 历史话题）。 */
    maybeSuggest() {
      clearTimeout(this._suggestTimer);
      const m = /([#＃])([^#＃\s　，,；;、|]*)$/.exec(String(this.data.body || ''));
      if (!m) {
        this.setData({ suggestions: [], showSuggest: false, suggestDone: false });
        return;
      }
      const kw = String(m[2] || '').trim();
      if (!kw) {
        this.searchSuggestions(''); // 刚输入 # → 固定列表
        return;
      }
      this._suggestTimer = setTimeout(() => this.searchSuggestions(kw), 250);
    },

    /** 检索入口：空关键词 → 固定初始列表（缓存优先）；有关键词 → 查数据库。
     *  用序号 _suggestSeq 防"迟到的异步结果"覆盖最新列表：关键词查询在途时用户退回只输 #，
     *  弹的是固定列表，旧查询 resolve 后因序号过期被丢弃，不会盖掉固定列表。 */
    searchSuggestions(kw) {
      const seq = (this._suggestSeq = (this._suggestSeq || 0) + 1); // 首次为 undefined → 用 0 兜底，避免 NaN
      if (!kw) {
        this.showFixedTopics();
        return;
      }
      const self = this;
      this.fetchEntries(kw).then(function (entries) {
        if (seq !== self._suggestSeq) return; // 过期结果：用户已切到固定列表 / 其它关键词
        const list = self.filterExcluded(entries).slice(0, 12);
        self.setData({ suggestions: list, showSuggest: true, suggestDone: true });
        self.layoutSuggest();
      });
    },

    /** 固定初始列表：优先本地缓存（上次全量查询），无缓存用写死的 HARDCODED_TOPICS；
     *  再排除已选话题；后台节流刷新缓存（不阻塞展示）。 */
    showFixedTopics() {
      const cached = wx.getStorageSync(TOPIC_CACHE_KEY);
      const list = (Array.isArray(cached) && cached.length) ? cached : HARDCODED_TOPICS;
      const out = this.filterExcluded(list);
      this.setData({ suggestions: out, showSuggest: true, suggestDone: true });
      this.layoutSuggest();
      this.refreshTopicCache(); // 后台刷新缓存（节流，秒开优先）
    },

    /** 排除已选话题（从混写正文解析），保留顺序、规范 {name, isCat} */
    filterExcluded(list) {
      const cur = this.extractTopics(this.data.body, true);
      const seen = {};
      const out = [];
      (list || []).forEach(function (e) {
        if (!e || seen[e.name]) return;
        if (cur.indexOf(e.name) >= 0) return;
        seen[e.name] = true;
        out.push({ name: String(e.name), isCat: !!e.isCat });
      });
      return out;
    },

    /** 后台刷新全量话题缓存：节流 CACHE_REFRESH_MS 内只查一次库，结果写入本地缓存。
     *  失败静默（展示已由缓存/写死列表兜底，不阻塞）。 */
    async refreshTopicCache() {
      if (this._refreshingCache) return;
      if (this._cacheRefreshAt && (Date.now() - this._cacheRefreshAt) < CACHE_REFRESH_MS) return;
      this._refreshingCache = true;
      try {
        const entries = await this.fetchEntries('');
        if (entries && entries.length) {
          wx.setStorageSync(TOPIC_CACHE_KEY, entries);
          this._cacheRefreshAt = Date.now();
        }
      } catch (err) {
        console.error('话题缓存刷新失败', err);
      } finally {
        this._refreshingCache = false;
      }
    },

    /** 从数据库取建议条目（猫名前缀命中标 🐱 + 历史话题含别名命中标 🐱），去重保序后返回。
     *  @param {String} kw 空 = 全量（缓存/固定列表的后台源）；非空 = 关键词过滤 */
    async fetchEntries(kw) {
      const esc = guard.escapeRegExp(kw);
      const catName = this.data.catName || '';
      const all = !kw;
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
      // 去重（先猫名后话题）
      const seen = {};
      const list = [];
      entries.forEach(function (e) {
        if (!e || seen[e.name]) return;
        seen[e.name] = true;
        list.push(e);
      });
      return list;
    },

    /** 输入框 + 建议列表联动布局：聚焦（键盘上方工具栏出现）时按「输入框顶 → 键盘顶」的可用高度动态分配：
     *   - 正文 textarea 给最大高 ceMaxH（9999=不限制）：内容再多也只长到"给列表预留位置"为止，
     *     超出在 textarea 内部滚动、光标所在行贴底可见。只有限制住正文高度，建议列表才有位置
     *     展示在 # 号下一行——否则正文一长（auto-height 无限增高）列表就被压成一条/被键盘盖住；
     *   - 建议列表实际高度 suggestH = 内容高（刚好展示，列表贴正文底、即 # 号下一行），
     *     封顶为「输入框底 → 键盘顶」的剩余空间（suggestMaxH），超出在 scroll-view 内部滚动；
     *   - 配合 textarea adjust-position=false：键盘不会自动滚动整页，「完成」栏（position:fixed）
     *     稳定贴在键盘上方（Bug-B：之前正文一长 adjust-position 就把整页顶上去、栏被顶离键盘）。
     *   - 未聚焦（无工具栏）时输入框恢复不限制，列表按可用空间封顶。 */
    layoutSuggest() {
      const self = this;
      wx.nextTick(function () {
        self.createSelectorQuery().select('.ce-textarea-wrap').boundingClientRect(function (rect) {
          if (!rect) return;
          const winH = (typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo().windowHeight : 0) || 640;
          const kbH = self._kbH || 0;
          const barH = (self.data.showToolbar && self.data.kbUp) ? 48 : 0; // 键盘上方工具栏高度（px，≈96rpx），列表底边不越过工具栏顶
          const availTop = winH - kbH - barH - 12;     // 列表底边界：键盘顶（工具栏顶）再往上留 12px
          const usable = availTop - rect.top;          // 输入框顶 → 列表底边界
          const LIST_RESERVE = 180;                    // 长文时至少给列表预留的高度（≈6 条）
          let ceMaxH = Math.round(usable - LIST_RESERVE);
          if (ceMaxH < 110) ceMaxH = 110;
          if (ceMaxH > 380) ceMaxH = 380;
          // 输入框实际底：限制后 = top + ceMaxH（长文），否则 = 当前实测底（短文，还没长到限高）
          const clampedBottom = Math.min(rect.bottom, rect.top + ceMaxH);
          let suggestMaxH = Math.round(availTop - clampedBottom - 12);
          if (suggestMaxH < 100) suggestMaxH = 100;
          if (suggestMaxH > 400) suggestMaxH = 400;
          if (!self.data.showToolbar) { // 未聚焦：输入框不限高，列表按可用空间封顶
            ceMaxH = 9999;
            suggestMaxH = Math.max(100, Math.min(400, Math.round(availTop - rect.top - 12)));
          }
          // 列表实际高度 = 内容高（刚好展示：24rpx 上下 padding + 名字行 ≈43px/条），封顶 suggestMaxH
          const n = (self.data.suggestions || []).length;
          const contentH = n ? n * 43 + 4 : 66;
          const suggestH = Math.max(66, Math.min(suggestMaxH, Math.round(contentH)));
          const patch = { suggestH: suggestH, suggestMaxH: suggestMaxH };
          if (self.data.ceMaxH !== ceMaxH) patch.ceMaxH = ceMaxH; // 没变则不重设，避免 textarea 反复重渲染
          self.setData(patch);
        }).exec();
      });
    },

    /** 防抖重排：键盘弹/收动画期间键盘高度事件很密，不逐帧查布局（layoutSuggest 有查询开销）；
     *  同时按最新键盘高校正输入区可见性（键盘弹起后 input 若仍被盖住，一起处理） */
    scheduleLayout() {
      clearTimeout(this._layoutTimer);
      const self = this;
      this._layoutTimer = setTimeout(function () {
        self.layoutSuggest();
        self.ensureInputVisible();
      }, 80);
    },

    /** 保证正文输入区可见：adjust-position=false 时键盘弹出【不会自动滚动页面】（安卓键盘
     *  是覆盖式，不压缩视口），正文长文或输入框位置偏低时，末尾/光标会被键盘盖住——表现为
     *  "点「#话题」没反应、不显示 #"（# 追加到了键盘下面）。此方法在确实被盖住时手动下滚
     *  页面，让输入框底边不越过键盘顶（留 12px）；没被盖住则不动，避免无谓抖动。
     *  【注意】用 wx.pageScrollTo（普通滚动，不产生 transform），不会像 adjust-position
     *  那样把 position:fixed 的「完成/话题」栏顶离键盘（Bug-B）。 */
    ensureInputVisible() {
      const self = this;
      wx.nextTick(function () {
        const q = self.createSelectorQuery();
        q.select('.ce-textarea-wrap').boundingClientRect();
        q.selectViewport().scrollOffset();
        q.exec(function (res) {
          const rect = res && res[0];
          const viewport = res && res[1];
          if (!rect || !viewport) return;
          const kbH = self._kbH || 0;
          if (kbH <= 0) return; // 键盘高度还没拿到：等下一轮事件/轮询（subscribe 回调会重排）
          const winH = (typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo().windowHeight : 0) || 640;
          const keyboardTop = winH - kbH;
          const targetBottom = keyboardTop - 12; // 输入框底边目标：键盘顶再往上留 12px
          if (rect.bottom > targetBottom) {
            const by = rect.bottom - targetBottom;          // 需要往下滚的量
            const capped = Math.min(by, Math.max(0, rect.top - 20)); // 顶多滚到输入框顶在视口 20px
            if (capped > 0) {
              wx.pageScrollTo({ scrollTop: viewport.scrollTop + capped, duration: 100 });
            }
          }
        });
      });
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

    /** 点建议 → 追加到正文结尾（tap 正常送达的路径） */
    tapSuggestion(e) {
      clearTimeout(this._pickTimer);
      const t = e.currentTarget.dataset.item;
      this.doPick(t);
    },

    /** 真正执行"点选某条建议"。tap 与 blur 兜底都汇到这里，天然去重。
     *  正文末尾若有 #片段，一并剥掉（点选 = 该片段替换为所选话题），再把 #话题 追加到正文结尾。 */
    doPick(t) {
      const item = String(t == null ? '' : t).trim();
      if (!item) return;
      let body = String(this.data.body || '');
      body = body.replace(/[#＃][^#＃\s　，,；;、]*$/, ''); // 剥掉结尾正在打的 #片段
      const lead = (body && !/[\s　]$/.test(body)) ? ' ' : '';
      body = body + lead + '#' + item + ' ';             // 追加 #话题（末尾空格 = 已完成）
      this.setData({
        body: body,
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

    /** 「完成」按钮（键盘上方工具栏右端）：完全退出话题输入——收尾话题 + 收列表 + 还原图片 + 收起键盘。
     *  与"点页面外部"等价，但由键盘上方工具栏显式触发。
     *  同时复位 _focused：完成后 textarea 已失焦，防下次 appendHash 聚焦脉冲用陈旧标记判断。 */
    collapseAll() {
      clearTimeout(this._pickTimer);
      this._picking = false;
      this._pickItem = null;
      this._suggestInteracting = false;
      this._focused = false;
      kbHeight.reset(); // 点「完成」= 明确收起键盘，显式清零不等事件/轮询
      this.emitChange(true); // 收尾：末尾未提交的 #片段 计入 relative
      this.setData({ suggestions: [], showSuggest: false, suggestDone: false, focusMain: false, showToolbar: false, ceMaxH: 9999, kbUp: false });
      if (wx.hideKeyboard) wx.hideKeyboard();
      this.triggerEvent('editorblur'); // 通知页面还原图片区
    },
  },
});
