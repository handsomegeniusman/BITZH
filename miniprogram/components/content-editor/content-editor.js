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

// 【建议列表尺寸】列表最多同时展示 SUGGEST_MAX_ROWS 行，多出来的在列表内部滚动。
// 固定初始列表 11 条、缓存最多 20+ 条、关键词结果切到 12 条，不封顶的话下拉能长到
// 400px（≈ 屏幕六成）把整个表单盖住。
const SUGGEST_MAX_ROWS = 5;                 // 最多同时展示 5 行（≈185px）
const SUGGEST_ROW_H = 43;                   // 单条候选行高的【估算值】(px)：只在首次布局时用，
                                            // 渲染出第一条后改用实测值自校准（见 layoutSuggest，
                                            // 估算偏差会让列表底部留一条点不动的空白 / 裁掉半行）

/** 是否 iOS。用于区分"聚焦脉冲"要不要做 —— 见 appendHash。
 *  取法与 utils/media.js 一致（getDeviceInfo 替代已弃用的 getSystemInfoSync，低基础库兜底）。
 *  注意：开发者工具把模拟器切成 iPhone 时 platform 也是 'ios'，所以这个分支在工具里可验。 */
let _isIOS = null;
function isIOS() {
  if (_isIOS !== null) return _isIOS;
  try {
    const platform = (typeof wx.getDeviceInfo === 'function')
      ? wx.getDeviceInfo().platform
      : wx.getSystemInfoSync().platform;
    _isIOS = platform === 'ios';
  } catch (e) {
    _isIOS = false; // 取不到就按非 iOS 走（保留原行为，脉冲照旧）
  }
  return _isIOS;
}

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
    suggestions: [],     // 建议列表（固定列表/缓存/关键词查询，去重后；每项 {name, isCat, exact?}）
    topics: [],          // 框下彩色话题条：正文中已解析出的话题（每项 {name, isCat}）
    showSuggest: false,  // 是否显示建议下拉
    suggestDone: false,  // 最近一次检索是否已完成（用于"无匹配"空态）
    suggestMaxH: 320,    // 建议下拉最大高度（px；动态 = 窗口高-键盘高-工具栏-输入框底，且不超过 5 行高）
    suggestH: 320,       // 建议下拉实际高度（px）：装得下 = 内容高（刚好展示在 # 号下一行），
                         // 装不下 = min(5 行高, suggestMaxH)，超出部分在列表内部滚动
    suggestScrollable: true, // 建议列表是否【真的滚得动】（内容高 > suggestH 才为 true）：
                         // 滚不动时把 scroll-y 关掉，否则这个原生容器会把上下滑手势吃掉，
                         // 用户滑动"没反应"、页面也带不动（见 wxml）
    suggestUp: false,    // 列表朝【上】开（绝对定位在正文上方）：键盘占掉正文下方时用，见 layoutSuggest
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
      // 🐱 映射种子：本地话题缓存（结构就是 [{name, isCat}]，由 refreshTopicCache 写入）。
      // 必须先建映射再 seedBody，否则首次回填出的话题条会缺小猫头。
      this._catTopicMap = {};
      try {
        const cached = wx.getStorageSync(TOPIC_CACHE_KEY);
        const map = this._catTopicMap;
        (Array.isArray(cached) ? cached : []).forEach(function (e) {
          if (e && e.name) map[e.name] = !!e.isCat;
        });
      } catch (e) { /* 缓存读失败不影响功能：只是话题条不显示 🐱 */ }
      // 双保险：个别时序下属性先于 observers 生效，attached 里再 seed 一次
      this.seedBody();
      // 订阅 kbHeight 管理器（多源并收 + 轮询兜底 + 显式清零，规避 wx.onKeyboardHeightChange
      // 在 iOS/安卓的已知缺陷）：
      //   - _kbH = 键盘高度，供 layoutSuggest 算「输入框顶→键盘顶」可用空间；
      //   - kbH 写入 data，供键盘上方工具栏「#话题/完成」fixed bottom 定位；
      //   - 高度变化会改变可用空间，防抖重排（键盘弹/收动画期间事件很密，不逐帧查布局）。
      this._unsubKb = kbHeight.subscribe((h, up) => {
        // 只有"高度 / 弹起状态真的变了"才重排：kbHeight 内部有 250ms 轮询兜底，
        // 状态没变也会反复回调，无脑重排 = 反复改写 scroll-view 的高度，
        // 正滑着的列表会被当场打断（"有时候滑不动"的来源之一，另一处见 scheduleLayout）。
        const changed = (this._kbH !== h) || (this._kbUp !== !!up);
        this._kbH = h;
        this._kbUp = !!up;
        const patch = {};
        if (this.data.kbH !== h) patch.kbH = h;
        if (this.data.kbUp !== !!up) patch.kbUp = !!up; // 键盘收起（up=false）→ 工具栏跟随隐藏
        if (Object.keys(patch).length) this.setData(patch);
        if (changed && (this.data.showSuggest || this.data.showToolbar)) this.scheduleLayout();
      });
    },
    detached() {
      clearTimeout(this._suggestTimer);
      clearTimeout(this._pickTimer);
      clearTimeout(this._layoutTimer);
      clearTimeout(this._focusLayoutTimer);
      clearTimeout(this._expandLayoutTimer);
      clearTimeout(this._selfBlurTimer);
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
      // 外部回填（草稿恢复 / 上次数据恢复）不经过 emitChange，这里补一次话题条同步
      this.syncTopicChips(this.extractTopics(body, false));
    },

    /** 页面点击编辑器外空白处时收起建议下拉（由页面 onPageTap 调用）。
     *  只收建议、不清正文——用户可能只是想去点别的字段，回来还能接着打。 */
    collapseSuggest() {
      this._suggestInteracting = false; // 收起建议 = 退出列表交互
      this.setData({ suggestions: [], showSuggest: false, suggestDone: false });
      // 收起后重排一次：列表在时输入框是按"给列表留位"限高的（见 layoutSuggest），
      // 列表没了就该放开。不重排的话，这次限高会一直留着，正文看着能滚却滚不动。
      this.layoutSuggest();
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
      // 框下彩色话题条：复用这里已经算好的 topics，不额外解析一遍。
      // 语义天然正确——输入中（includeTail=false）只显示【已完成】话题；
      // 回车/失焦/完成（includeTail=true）时末尾未提交的片段也算进去，与"提交"一致。
      this.syncTopicChips(topics);
      this._lastEmitted = { main: main, relative: relative }; // ← 防重灌的关键
      this.triggerEvent('change', { main: main, relative: relative });
    },

    /** 同步框下彩色话题条（正文里每个已解析出的话题 → 一个粉色胶囊）。
     *  🐱 标注取自 _catTopicMap（由 fetchEntries 顺带记录 + 本地话题缓存种子填充），
     *  不做额外 DB 查询；映射里没有该名字时不带 🐱（降级，不影响展示）。
     *  用 _chipsKey 比对：内容没变直接跳过，避免每敲一个字都重渲染整条话题条。 */
    syncTopicChips(topics) {
      const map = this._catTopicMap || {};
      const list = (topics || []).map(function (n) {
        return { name: String(n), isCat: !!map[String(n)] };
      });
      const key = list.map(function (t) { return (t.isCat ? '1' : '0') + t.name; }).join('');
      if (key === this._chipsKey) return; // 无变化，不打扰渲染
      this._chipsKey = key;
      this.setData({ topics: list });
    },

    /** 提交/收尾兜底：把末尾未完成的 #片段 也算进话题，并收起建议。
     *  页面 confirm()、回车、自然失焦都走这里（语义一致：收尾话题输入）。
     *  【「完成」不在其中】它只在列表没开时收尾（见 collapseAll）：列表开着 = 用户还在挑话题。 */
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

    /** 标记"接下来这个失焦是我们自己造成的"：程序化改值（appendHash / removeTopic）和
     *  聚焦脉冲都会让 textarea 真的失焦，但这不是"用户离开了输入"，不该触发收尾。
     *  见 onBodyBlur —— 认领后不还原图片区、不清建议列表、不收工具栏、也不 flush。
     *  【为什么不能只靠 _btnTapAt 的 300ms 时间窗】那个窗口是给 touchstart→tap 之间用的；
     *  我们自己在 tap 之后造成的 blur，在 iOS 上可能几百毫秒后才送达，落在窗口外就被误判成
     *  自然失焦，一次点击把列表和工具栏全清掉。这里用显式标记认领，不论多久都算自己的。
     *  1s 兜底清零：万一那个 blur 一直没来，别把标记留到下一次真失焦。 */
    markSelfBlur() {
      this._selfBlur = true;
      clearTimeout(this._selfBlurTimer);
      const self = this;
      this._selfBlurTimer = setTimeout(function () { self._selfBlur = false; }, 1000);
    },

    /** 点「#话题」按钮：正文末尾追加 #。末尾是普通文字时先补空格，保证 token 边界。
     *  末尾已是"分隔符/开头 + 空 #"时不重复追加（避免 "##"），但照常弹键盘 + 列表。
     *  【安卓兼容】不能用"正在聚焦的 textarea 上直接 setData value"：安卓原生输入会话
     *  会覆盖/丢弃程序化改的值（表现为点按钮没反应、不显示 #）。必须【失焦 + 改值】同一帧
     *  setData（与 doPick 点选建议同款脉冲），下一帧再聚焦 + 光标贴末尾。
     *  【iOS 不做这个脉冲】iOS 上 focus=false 会【真的把键盘收起来】，紧接着的重新聚焦又把它
     *  弹回去 —— 用户看到的是"键盘收缩 → 列表弹出 → 键盘弹出"的闪动；更糟的是这个由我们自己
     *  造成的 blur 若晚于 300ms 才送达（iOS 原生聚焦切换很慢），会被 onBodyBlur 当成自然失焦，
     *  把建议列表 + 工具栏 + 图片区一起收掉（表现为"点了话题，列表和 # 都没了"）。
     *  iOS 上直接在聚焦态改值即可（覆盖值是安卓原生输入会话的问题，iOS 没有）。 */
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
      // 点按钮本身可能让 textarea 真的失焦（见上），那个 blur 不是"用户离开了输入"，
      // 标记认领：onBodyBlur 见到它就只当没发生（不还原布局、不清建议、不收话题）。
      this.markSelfBlur();
      const self = this;
      if (this._focused && !isIOS()) {
        // 安卓 + 聚焦中：失焦 + 改值（同一帧 setData，值在非聚焦态写入，原生不干扰），
        // 下一帧聚焦 + 光标贴末尾（wx.nextTick 保证改值已渲染）
        this.setData({ body: body, cursor: -1, focusMain: false });
        wx.nextTick(function () {
          self.setData({ focusMain: true, cursor: String(self.data.body || '').length });
        });
      } else if (this._focused) {
        // iOS + 聚焦中：只改值 + 把光标指到末尾，【不碰 focus】，键盘全程不闪。
        this.setData({ body: body, cursor: body.length });
      } else {
        // 未聚焦（两端共通）：本来就是失焦态，复位陈旧 focusMain 后下一帧聚焦
        this.setData({ body: body, cursor: -1, focusMain: false });
        wx.nextTick(function () {
          self.setData({ focusMain: true, cursor: String(self.data.body || '').length });
        });
      }
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
      // 上面那个 300ms 窗口只管得住 touchstart→tap 之间的失焦。tap 之后我们自己造成的 blur
      // （appendHash / removeTopic 的聚焦脉冲、以及点按钮本身）常晚于窗口才送达，
      // 落到这里就会被当成"自然失焦"：收建议列表 + 还原图片区 + 收工具栏，一次点击全清掉。
      // markSelfBlur() 的显式标记不设时限，认领掉它。
      if (this._selfBlur) {
        this._selfBlur = false;
        clearTimeout(this._selfBlurTimer);
        return;
      }
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
        const list = self.markExact(self.filterExcluded(entries), kw).slice(0, 12);
        self.setData({ suggestions: list, showSuggest: true, suggestDone: true });
        self.layoutSuggest();
        // 列表变长可能要往键盘上方再腾地方（候选变多 = wantListH 变大），
        // 只重排不腾地方的话，长出来的那几行会落到键盘底下看不见
        self.ensureInputVisible();
      });
    },

    /** 把"与当前输入完全一致"的那条提到首位并打上确认徽章。
     *  这是给用户的【明确反馈】：输入到什么程度、名字对不对，一眼可见。
     *   - 候选里已有同名项（命中猫咪 / 已有话题）→ 原地提到首位，徽章标明命中类型；
     *   - 候选里没有同名项 → 首位补一条"直接使用"，保证【永远有可点项】，
     *     用户不会因为"名字没被收录"而以为输入失败（话题本就是自由文本，可直接用）。
     *  kw 为空（点「#话题」按钮的固定初始列表）时不加任何东西。
     *  @param {Array} list filterExcluded 之后的候选
     *  @param {String} kw 当前输入的 # 片段
     *  @returns {Array} 新数组（不改原数组） */
    markExact(list, kw) {
      const key = String(kw == null ? '' : kw).trim();
      const out = (list || []).slice();
      if (!key) return out;
      let hit = -1;
      for (let i = 0; i < out.length; i++) {
        if (out[i] && out[i].name === key) { hit = i; break; }
      }
      if (hit >= 0) {
        const item = out.splice(hit, 1)[0];
        out.unshift({
          name: item.name,
          isCat: !!item.isCat,
          exact: true,
          exactLabel: item.isCat ? '已匹配猫咪' : '已有话题',
        });
      } else {
        out.unshift({ name: key, isCat: false, exact: true, exactLabel: '直接使用' });
      }
      return out;
    },

    /** 固定初始列表：优先本地缓存（上次全量查询），无缓存用写死的 HARDCODED_TOPICS；
     *  再排除已选话题；后台节流刷新缓存（不阻塞展示）。 */
    showFixedTopics() {
      const cached = wx.getStorageSync(TOPIC_CACHE_KEY);
      const list = (Array.isArray(cached) && cached.length) ? cached : HARDCODED_TOPICS;
      const out = this.filterExcluded(list);
      this.setData({ suggestions: out, showSuggest: true, suggestDone: true });
      this.layoutSuggest();
      // 点「#话题」进来的主路径：键盘往往还在弹起中（此刻 kbH 可能为 0，这里会空跑），
      // 键盘高度到位后由 kbHeight 订阅回调的 scheduleLayout 再补一次，最终一定会腾出位置。
      this.ensureInputVisible();
      this.refreshTopicCache(); // 后台刷新缓存（节流，秒开优先）
    },

    /** 排除已选话题（从混写正文解析），保留顺序、规范 {name, isCat}。
     *  【必须用 includeTail=false】只排除"后面跟了分隔符"的【已完成】话题。
     *  若传 true，末尾"正在输入、还没敲分隔符"的片段也会被当成已选话题，
     *  于是用户输入完整名称（如 #小海参）时，候选里的「小海参」被自己排除掉 →
     *  列表反而变空（输入 #小海 有候选、输入 #小海参 没候选的怪现象）。
     *  末尾片段是【搜索词】不是已选项，绝不能排除。 */
    filterExcluded(list) {
      const cur = this.extractTopics(this.data.body, false);
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
      // 顺带记录"哪些名字是猫名"，供框下话题条打 🐱（本来就要查这一趟，零额外查询）
      const map = this._catTopicMap || (this._catTopicMap = {});
      list.forEach(function (e) { map[e.name] = !!e.isCat; });
      return list;
    },

    /** 键盘/工具栏几何：布局（layoutSuggest）与可见性（ensureInputVisible）共用同一套边界。
     *  【为什么必须共用】这两个函数原本各算各的：布局按「键盘顶 - 工具栏高 - 12」算列表能有多高，
     *  滚动却按「键盘顶 - 12」算要把输入框滚到哪 —— 滚出来的位置比列表需要的位置低了一整个
     *  工具栏的高度，结果列表被压到 100px 下限、下沿还伸到键盘底下，iPhone 上只看得见一行。
     *  @param {Number} [measuredBarH] 实测的工具栏高度（由调用方在同一次 selector 查询里量到）
     *  @returns {{winH: number, kbH: number, barH: number, bottomLimit: number}}
     *    bottomLimit：输入框底 / 话题条 / 建议列表都不能越过的下边界（px） */
    kbGeom(measuredBarH) {
      const winH = (typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo().windowHeight : 0) || 640;
      const kbH = this._kbH || 0;
      // 键盘上方工具栏（#话题 / 完成）只在「聚焦 + 键盘弹起」时存在，列表与输入框都要给它让位。
      // 【为什么优先用实测值】它的高度写成 96rpx，而 1rpx 不是定值：375 宽屏上 =48px，430 宽屏上
      // =55px。按 48 算，宽屏上列表底边会压进工具栏、盖住「完成」按钮。
      let barH = 0;
      if (this.data.showToolbar && this.data.kbUp) {
        barH = (measuredBarH > 0) ? Math.round(measuredBarH) : 48; // 还没量到（首帧）就先用 48
      }
      return { winH: winH, kbH: kbH, barH: barH, bottomLimit: winH - kbH - barH - 12 };
    },

    /** 建议列表【想要】多高（px，不含与输入框底的间距）：内容全展开、最多 5 行的自然高度，
     *  不受当前可用空间裁剪，列表没展开时返回 0。
     *  【与 suggestH 的区别很关键】suggestH 是"现在有多少空间就占多少"的结果值；这个值是"需要多少"。
     *  ensureInputVisible 必须按【需要值】滚动页面腾地方：按结果值去腾是循环依赖——空间小 → 结果值小
     *  → 只腾一点点 → 空间还是小，收敛在一行上（正是 iPhone 上"只看得见一行"的成因之一）。 */
    wantListH() {
      if (!this.data.showSuggest) return 0;
      const n = (this.data.suggestions || []).length;
      const rowH = this._rowH || SUGGEST_ROW_H;
      return n ? Math.min(n, SUGGEST_MAX_ROWS) * rowH + 4 : 66;
    },

    /** 输入框 + 建议列表联动布局：聚焦（键盘上方工具栏出现）时按「输入框顶 → 键盘顶」的可用高度动态分配：
     *   - 正文 textarea 给最大高 ceMaxH（9999=不限制）：内容再多也只长到"给列表预留位置"为止，
     *     超出在 textarea 内部滚动、光标所在行贴底可见。只有限制住正文高度，建议列表才有位置
     *     展示在 # 号下一行——否则正文一长（auto-height 无限增高）列表就被压成一条/被键盘盖住；
     *   - 建议列表实际高度 suggestH：装得下 = 内容高（刚好展示，列表贴正文底、即 # 号下一行），
     *     装不下 = min(最多 5 行, 「输入框底 → 键盘顶」的剩余空间 suggestMaxH)，超出在列表内部滚动；
     *   - 配合 textarea adjust-position=false：键盘不会自动滚动整页，「完成」栏（position:fixed）
     *     稳定贴在键盘上方（Bug-B：之前正文一长 adjust-position 就把整页顶上去、栏被顶离键盘）。
     *   - 未聚焦（无工具栏）时输入框恢复不限制，列表按可用空间封顶。
     *  【行高自校准】SUGGEST_ROW_H 只是个估算值（rpx 换算、字体行高、🐱 emoji 都会让实际值偏移），
     *  渲染出第一条候选后量一次真实高度记住，之后都用实测值——估算偏大列表底部会留一条
     *  点不动的空白，偏小则会把最后一行裁掉半条。
     *  【只写变化过的字段】高度没变就不 setData：改写 scroll-view 的高度会让这个原生滚动容器
     *  重新渲染，正滑着的列表会当场丢掉这次手势（"有时候滑不动"的来源之一）。 */
    layoutSuggest() {
      const self = this;
      wx.nextTick(function () {
        const q = self.createSelectorQuery();
        q.select('.ce-textarea-wrap').boundingClientRect();
        q.select('.ce-suggest-item').boundingClientRect(); // 顺带量一条候选的真实行高
        q.select('.ce-kb-bar').boundingClientRect();       // 顺带量键盘上方工具栏的真实高度（rpx 随屏宽变）
        q.exec(function (res) {
          const rect = res && res[0];
          if (!rect) return;
          const item = res && res[1];
          if (item && item.height > 0) self._rowH = item.height; // 自校准（样式固定，量到即存）
          const rowH = self._rowH || SUGGEST_ROW_H;
          const barEl = res && res[2]; // 工具栏没渲染出来（未聚焦）时为 null
          // 下边界与 ensureInputVisible 共用（kbGeom）：两边算不到一块去，列表就会被压成一行
          const g = self.kbGeom(barEl && barEl.height);
          const availTop = g.bottomLimit;              // 列表底边界：键盘顶（工具栏顶）再往上留 12px
          const usable = availTop - rect.top;          // 输入框顶 → 列表底边界
          const LIST_RESERVE = 180;                    // 长文时至少给列表预留的高度（≈5 条）
          let ceMaxH = Math.round(usable - LIST_RESERVE);
          if (ceMaxH < 110) ceMaxH = 110;
          if (ceMaxH > 380) ceMaxH = 380;
          // 5 行封顶：再长就盖住整个表单了。下限 100px 保证再挤也露得出一两行
          const rowCapH = Math.max(100, Math.round(SUGGEST_MAX_ROWS * rowH) + 4);
          // 输入框实际底：限制后 = top + ceMaxH（长文），否则 = 当前实测底（短文，还没长到限高）
          const clampedBottom = Math.min(rect.bottom, rect.top + ceMaxH);
          // 下方可用（到键盘顶/工具栏顶）与上方可用（到屏幕顶）——两侧各算一次，谁宽用谁。
          // 【为什么要朝上开】键盘一弹就吃掉大半屏，正文下方往往只剩几十像素。之前"把页面滚上去
          // 给下面腾地方"救不回来：表单内容不够一屏时页面根本滚不动，列表只能露出被键盘盖住的
          // 那一小截（真机表现就是"只有一行"）。而钉在键盘顶边强行 5 行又会盖住正文（看不见自己
          // 打了什么）。朝上开没有这个问题——列表在正文【上方】，那是图片区和标题行的位置，
          // 它们此刻不是用户在操作的东西，而正文必须一直看得见。
          const spaceBelow = Math.round(availTop - clampedBottom - 12);
          const spaceAbove = Math.round(rect.top - 12 - 8); // 顶部留 8px，别顶着状态栏
          const useUp = !!(self.data.showSuggest && g.kbH > 0 && spaceAbove > spaceBelow);
          let suggestMaxH = useUp ? spaceAbove : spaceBelow;
          // 既没聚焦、也没列表：输入框不限高，整页随内容滚（没有浮层需要让位）。
          // 【列表开着时不能走这里】点「完成」会留下"键盘收了、列表还在"的状态（见 collapseAll），
          // 此时若把输入框放开到 9999，长正文会把列表顶到屏幕外——列表必须始终留在视口里。
          if (!self.data.showToolbar && !self.data.showSuggest) {
            ceMaxH = 9999;
            suggestMaxH = Math.round(availTop - rect.top - 12);
          }
          if (suggestMaxH < 100) suggestMaxH = 100;
          if (suggestMaxH > rowCapH) suggestMaxH = rowCapH;
          // 列表高度：最多展示 5 行（boxH），再受可用空间（suggestMaxH）约束
          const n = (self.data.suggestions || []).length;
          const fullH = n ? n * rowH + 4 : 66;      // 全部候选的真实内容高
          const boxH = self.wantListH() || 66;      // 最多 5 行的展示高（与 ensureInputVisible 同源）
          const suggestH = Math.max(66, Math.min(suggestMaxH, Math.round(boxH)));
          // 内容高过容器才滚得动：滚不动时不该按"可滚容器"渲染——它会把上下滑手势
          // 全吃掉，表现为"列表滑不动、页面也带不动"（见 wxml 的 scroll-y 绑定）。
          const scrollable = n > 0 && fullH > suggestH + 1;
          const patch = {};
          if (self.data.suggestH !== suggestH) patch.suggestH = suggestH;
          if (self.data.suggestMaxH !== suggestMaxH) patch.suggestMaxH = suggestMaxH;
          if (self.data.ceMaxH !== ceMaxH) patch.ceMaxH = ceMaxH; // 没变则不重设，避免 textarea 反复重渲染
          if (self.data.suggestScrollable !== scrollable) patch.suggestScrollable = scrollable;
          if (self.data.suggestUp !== useUp) patch.suggestUp = useUp;
          if (Object.keys(patch).length) self.setData(patch);
        });
      });
    },

    /** 防抖重排：键盘弹/收动画期间键盘高度事件很密，不逐帧查布局（layoutSuggest 有查询开销）；
     *  同时按最新键盘高校正输入区可见性（键盘弹起后 input 若仍被盖住，一起处理）。
     *  【手指正在建议列表上时挂起】——键盘一收/一缩就重排，会改写 scroll-view 的高度，
     *  必要时还会 wx.pageScrollTo 滚页；这个原生滚动容器在手指按住期间被改尺寸或被滚页，
     *  会直接丢掉这次滚动手势，表现就是「键盘一缩，列表就滑不动了」。
     *  挂起后由手指离开时的 flushPendingLayout() 补做（键盘确实变过才补，没变就不补）。 */
    scheduleLayout() {
      clearTimeout(this._layoutTimer);
      if (this._suggestInteracting) {
        this._layoutPending = true; // 手指还在列表上：记账，等它离开
        return;
      }
      const self = this;
      this._layoutTimer = setTimeout(function () {
        // 挂起期间可能刚好按下了列表（80ms 防抖窗口内）：同样让位给手指
        if (self._suggestInteracting) { self._layoutPending = true; return; }
        self.layoutSuggest();
        self.ensureInputVisible();
      }, 80);
    },

    /** 手指离开建议列表后补做挂起的重排（按住期间键盘高度变过就必须补一次） */
    flushPendingLayout() {
      if (!this._layoutPending) return;
      this._layoutPending = false;
      this.scheduleLayout();
    },

    /** 保证正文输入区【和它下方的浮层】可见：adjust-position=false 时键盘弹出不会自动滚动
     *  页面（安卓键盘是覆盖式，不压缩视口），正文长文或输入框位置偏低时，末尾/光标会被键盘
     *  盖住——表现为"点「#话题」没反应、不显示 #"（# 追加到了键盘下面）。此方法在确实被盖住时
     *  手动下滚页面，让【输入框底 + 下方浮层】整体落在下边界之上；没被盖住则不动，避免无谓抖动。
     *  【浮层也要腾地方】输入框正下方叠着两样东西：话题条（.ce-chips）和建议列表（.ce-suggest，
     *  展开时盖住话题条）。列表如果是朝【上】开的（键盘弹起时，见 layoutSuggest），它在正文上方，
     *  跟这里无关，不参与；只有朝下开时才按 wantListH() 一并腾出来。
     *  两者是叠加关系不是并列关系（列表盖住话题条），所以取较大值而不是相加。
     *  【注意】用 wx.pageScrollTo（普通滚动，不产生 transform），不会像 adjust-position
     *  那样把 position:fixed 的「完成/话题」栏顶离键盘（Bug-B）。 */
    ensureInputVisible() {
      const self = this;
      wx.nextTick(function () {
        const q = self.createSelectorQuery();
        q.select('.ce-textarea-wrap').boundingClientRect();
        q.selectViewport().scrollOffset();
        // 顺带量一下话题条高度：它紧贴在输入框正下方，必须一并让出空间，
        // 否则键盘弹起时话题条会正好落在键盘下面看不见。
        // 并入同一次 exec（索引 2），不产生额外的查询往返。
        q.select('.ce-chips').boundingClientRect();
        q.select('.ce-kb-bar').boundingClientRect(); // 工具栏真实高度（rpx 随屏宽变，见 kbGeom）
        q.exec(function (res) {
          const rect = res && res[0];
          const viewport = res && res[1];
          if (!rect || !viewport) return;
          const barEl = res && res[3];
          const g = self.kbGeom(barEl && barEl.height); // 与 layoutSuggest 同一套下边界（见 kbGeom 注释）
          // 键盘高度还没拿到：等下一轮事件/轮询（subscribe 回调会重排）。
          // 【列表开着时例外】点「完成」会留下"键盘收了、列表还在"的状态，这时也要把列表滚进视口——
          // 图片区还原是 0.3s 过渡，会把表单卡片连同列表一起往下推，不滚就可能推出屏幕。
          if (g.kbH <= 0 && !self.data.showSuggest) return;
          // 话题条不存在时 select 返回 null → chipsH = 0
          const chips = res && res[2];
          const chipsH = (chips && chips.height) ? chips.height + 8 : 0;
          // 列表【朝下开】时按它想要的高度腾地方。+12 与 layoutSuggest 里
          // 「suggestMaxH = availTop - 输入框底 - 12」用的是同一个余量：这里腾够，
          // 那边算出来的 suggestMaxH 才刚好等于 wantListH，最后一整行不会被裁掉几个像素。
          // 【朝上开时不腾】列表在正文上方，跟键盘毫不相干，腾了反而把正文往上推、
          // 压缩它上方本就不多的空间。朝下开（含点「完成」后键盘收起、列表还留着）才需要：
          // 那时图片区正在还原，会把列表一路往下推，不腾地方就会被推出屏幕。
          const want = self.data.suggestUp ? 0 : self.wantListH();
          const listH = want ? want + 12 : 0;
          const overlayH = Math.max(chipsH, listH);
          const targetBottom = g.bottomLimit - overlayH; // 输入框底边目标：浮层整体落在下边界之上
          if (rect.bottom > targetBottom) {
            const by = rect.bottom - targetBottom;          // 需要往下滚的量
            const capped = Math.min(by, Math.max(0, rect.top - 20)); // 顶多滚到输入框顶在视口 20px
            if (capped > 0) {
              wx.pageScrollTo({
                scrollTop: viewport.scrollTop + capped,
                duration: 100,
                // 滚完再量一次：layoutSuggest 跑在滚动【之前】，按旧位置算出的 suggestH 偏小
                // （空间已被腾出来却没重新分配）。不补这一次，列表要等到下一次键盘事件才展开。
                success: function () {
                  // 手指正按着列表时不重排：改写 scroll-view 高度会当场丢掉这次手势
                  if (self._suggestInteracting) return;
                  self.layoutSuggest();
                },
              });
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
    /** 手指离开建议列表（正常抬起）→ 结束"列表交互"标记，补做按住期间挂起的重排 */
    onItemTouchEnd() {
      this._suggestInteracting = false;
      this.flushPendingLayout();
    },
    /** 触摸被中断（滑动走 / 系统打断）→ 取消本次点选意图 + 结束列表交互标记，补做挂起的重排 */
    onItemTouchCancel() {
      this._picking = false;
      this._pickItem = null;
      this._suggestInteracting = false;
      this.flushPendingLayout();
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
        // 下面复位 focusMain（陈旧 true 时才真会失焦）可能引来一次由我们造成的 blur，
        // 同样先认领，免得它走到 onBodyBlur 的自然失焦分支把刚点上的话题又收掉。
        this.markSelfBlur();
        this.setData({ focusMain: false });
        const self = this;
        wx.nextTick(function () {
          self.setData({ focusMain: true, cursor: String(self.data.body || '').length });
        });
      }
    },

    /** 点话题条胶囊上的 × → 从正文里删掉该话题（连同它前面多余的空格）。
     *  只删"作为【独立话题】出现"的那一处（后面必须是分隔符或字符串结尾），
     *  避免删「#海参」时误伤正文里作为普通文字出现的「#海参崴」——
     *  与 topic.tokenRegex 的边界口径一致。 */
    removeTopic(e) {
      const name = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset.name : '';
      if (!name) return;
      // 顺带吃掉话题前面的一个空白，避免删完留下双空格
      const re = new RegExp('[ \\t　]?[#＃]' + guard.escapeRegExp(name) + '(?=[\\s　，,；;、|#＃]|$)', 'g');
      const before = String(this.data.body || '');
      // 折叠残留空白；只修剪首尾的空格/制表符，不动换行（保留段落结构）
      const after = before.replace(re, '')
        .replace(/[ \t　]{2,}/g, ' ')
        .replace(/^[ \t　]+|[ \t　]+$/g, '');
      if (after === before) return;
      this.markSelfBlur(); // 点 × 也会让 textarea 失焦，别让它被当成"用户离开了输入"
      if (this._focused && !isIOS()) {
        // 安卓 + 聚焦中：直接改值会被原生输入会话覆盖（同 appendHash / doPick），
        // 必须"失焦 + 改值"同一帧 setData，下一帧再聚焦 + 光标贴末尾。
        this.setData({ body: after, cursor: -1, focusMain: false });
        const self = this;
        wx.nextTick(function () {
          self.setData({ focusMain: true, cursor: String(self.data.body || '').length });
        });
      } else {
        // iOS 聚焦中 / 未聚焦：直接改值。iOS 上 focus=false 会真的收起键盘，
        // 紧接着的重新聚焦又是一次"收缩 → 弹出"的闪动，换不来任何东西（见 appendHash）。
        this.setData({ body: after, cursor: -1 });
      }
      this.emitChange(); // 正文 / relative / 话题条 一起刷新
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

    /** 「完成」按钮（键盘上方工具栏右端）：收起键盘 + 还原图片区。与"点页面外部"基本等价，
     *  但由键盘上方工具栏显式触发；并复位 _focused（完成后 textarea 已失焦，
     *  防下次 appendHash 聚焦脉冲用陈旧标记判断）。
     *  【建议列表开着时，列表不收】键盘占着屏幕时列表本来只露得出一两行，用户点「完成」的意图
     *  是"把键盘挪开好看列表"，不是"结束话题输入"。原来这里连列表一起收掉，用户就再没有别的
     *  办法腾地方了——点一下「完成」，正要挑的候选全没了（iOS 键盘不随失焦自动收，更常撞上）。
     *  列表改由"点编辑器外部"关闭（页面 onPageTap → collapseSuggest），语义更清楚。
     *  【此时也不收尾末尾话题】末尾 #片段 一提交就变成已选，再点候选会重复添加；
     *  用户还在挑，就不该当作"说完了"。 */
    collapseAll() {
      clearTimeout(this._pickTimer);
      this._picking = false;
      this._pickItem = null;
      this._suggestInteracting = false;
      this._focused = false;
      kbHeight.reset(); // 点「完成」= 明确收起键盘，显式清零不等事件/轮询
      // 【必须标记】收键盘（focusMain:false 与 wx.hideKeyboard）会让 textarea 真的失焦，
      // 那个 blur 事件稍后送达 onBodyBlur。不认领的话它按"自然失焦"处理 → 调用 flush() →
      // collapseSuggest()，把这里刚决定要留下的建议列表又清掉（"点完成列表就没了"的真凶，
      // 只改 setData 是不够的：blur 是异步来的，晚于本次 setData）。
      this.markSelfBlur();
      const keepSuggest = !!this.data.showSuggest;
      const patch = { focusMain: false, showToolbar: false, kbUp: false };
      if (!keepSuggest) {
        patch.ceMaxH = 9999; // 没有浮层要让位了：输入框放开限高，整页随内容滚
        patch.suggestions = [];
        patch.showSuggest = false;
        patch.suggestDone = false;
        this.emitChange(true); // 收尾：末尾未提交的 #片段 计入 relative
      }
      // 【保留列表时不放开 ceMaxH】列表还在，输入框仍要限高给它让位。这里若先放开到 9999、
      // 等 80ms 后 layoutSuggest 再改回来，正文会先窜高再缩回（一闪）。留着不动，由
      // 紧接着的 layoutSuggest 按"键盘已收"重新分配即可。
      this.setData(patch);
      if (wx.hideKeyboard) wx.hideKeyboard();
      this.triggerEvent('editorblur'); // 通知页面还原图片区
      if (keepSuggest) {
        // 键盘收走后空间变大，重排一次让列表按内容完整展开（kbH 已是 0，不再受键盘挤压）。
        // 【为什么要排三次】页面收到 editorblur 后会还原图片区，那是"300ms 防抖 + 0.3s 过渡"，
        // 表单卡片会被一路往下推。只在开头量一次，量到的是扩张【之前】的坐标，列表会跟着被推走。
        // 350ms 抓过渡中点、750ms 抓过渡结束，配合 ensureInputVisible 把列表滚回视口。
        this.scheduleLayout();
        const self = this;
        clearTimeout(this._focusLayoutTimer);
        clearTimeout(this._expandLayoutTimer);
        this._focusLayoutTimer = setTimeout(function () {
          self.layoutSuggest();
          self.ensureInputVisible();
        }, 350);
        this._expandLayoutTimer = setTimeout(function () {
          self.layoutSuggest();
          self.ensureInputVisible();
        }, 750);
      }
    },
  },
});
