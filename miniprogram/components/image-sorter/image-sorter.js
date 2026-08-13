// ============================================================
// components/image-sorter/image-sorter.js
// 横向滚动图片拖拽排序组件（原生 movable-area + movable-view 实现，兼容 iOS/Android）
//
// 【交互】
//   - 短按：单击预览 wx.previewImage
//   - 长按 350ms：进入拖拽（wx.vibrateShort 震动反馈），拖动时当前图放大 1.1 倍 + 阴影
//   - 其他图片越过中点自动让位（movable-view x 数据驱动 + animation 平滑过渡）
//   - 边缘自动滚动（连续平滑式）：手指进入容器左右 40px 阈值区，列表即以"随贴边
//     程度连续变化"的速度向反方向平滑滚动（贴边 3 张/秒 → 边界 0.8 张/秒），
//     一进边缘区立即起步、无停留等待、无跳格，每帧像素级位移
//   - 松手：图片平滑归位到目标索引（松手时刻 scrollLeft 冻结，无惯性，不跳变）
//   - bind:change 把新顺序写回页面数组
//
// 【让位滞后】进入时覆盖目标图约 1/3 即触发交换（比中点 0.5 灵敏，减少"已拖过去
//     却没反应"的迟滞）；退出时反向退回约 1/2 才恢复（比进入阈值大，提供安全缓冲区，
//     防手指在临界点微小抖动导致图片反复横跳）。用 _hysDir 记忆让位方向区分二者。
//
// 【性能】统一 rAF 帧循环：跟手期仅对被拖图做单字段 setData（脏值 >1px 才刷）；
//         滚动帧把 scrollLeft 与被拖图 x 合并为一次原子 setData，杜绝两条渲染管线
//         时间差导致的抖动。DEBUG_FPS 开关输出 rafFPS + 每帧耗时。
//
// 【防坑】
//   - 不做页面级 disableScroll（长表单需要竖向滚动）：图片条上 catchtouchmove
//     始终绑定拦截原生滚动，未激活时手动滚动接管横滑，拖拽中锁定滑条跟手
//   - catchtouchmove 必须始终绑定，不能靠 setData 条件切换：一次触摸手势进行中
//     微信不会重新绑定 touch 事件（iOS 长按激活后绑定失效 → 图不跟手、滑条原生横滑）
//   - wx:key 用唯一 id（按图片地址生成），绝不用 index
//   - 滚动驱动用纯 setData scroll-left（不用 ScrollContext/enhanced），避免 iOS 边缘
//     区原生 pan 手势接管触发 touchcancel 拖拽中断
//   - movable-view 始终 disabled（只当定位引擎，x 数据驱动），避免"拖拽中途才
//     enabled 不跟手"的 iOS 已知缺陷；out-of-bounds=false + 手动钳制边界
//
// 【用法】页面里
//   <image-sorter items="{{imageUrls}}" tip="{{imgTip}}" invalid="{{formErrors.photo}}"
//                 bind:change="onImgChange" bind:add="getphoto"/>
//   onImgChange(e) { setField(this, this.data.imgField, e.detail.items); draft.markDirty(this); }
// ============================================================

const LPRS_MS = 350;       // 长按判定阈值（毫秒）
const MOVE_THRESHOLD = 10; // 长按激活前允许的位移，超过视为"滑动"

// [AUTO-SCROLL] 连续平滑边缘自动滚动参数（集中于此，方便调参）
const EDGE_ZONE_ENTER = 40; // 手指距容器左右边缘多少 px 内 → 进入自动滚动
const EDGE_ZONE_EXIT = 56;  // 离开自动滚动阈值（位置迟滞：进 40 / 出 56，防临界抖动）
const EDGE_RATE_MAX = 4.5;  // 贴边最快速率（张/秒），×1.5：原 3.0 太慢
const EDGE_RATE_MIN = 1.2;  // 边缘区边界速率（张/秒），×1.5：原 0.8 太慢
const FRAME_MS = 16.6;      // 基准帧时长（60fps），方向抑制阈值按 dt/FRAME_MS 缩放
const DIR_EPS = 1;          // 方向抑制基准阈值（px/帧）：贴边却反向拖 >1px/帧 则不滚
const TRACK_EPS = 1;        // 被拖图 setData 脏值阈值（px）：变化 >1px 才刷
const SCROLL_EPS = 0.5;     // scrollLeft 脏值阈值（px）：连续滚动每帧位移都远超它
const SLOT_ENTER = 1 / 3;   // [让位] 进入：越过槽边界 1/3 即触发（≈覆盖目标图 1/3，比中点 0.5 灵敏）
const SLOT_EXIT = 1 / 2;    // [让位] 退出：退回槽边界 1/2 才恢复（比进入大，防临界抖动横跳）
const SLOT_LOCK_MS = 250;   // [让位] 让位/退回后冷却锁：期间不再让位，防快速滑过时连续换位"自激闪现"

const DEBUG_FPS = false;    // [AUTO-SCROLL] 性能观测开关：true 时每秒输出 rafFPS + 每帧耗时
const NOASK_KEY = 'imgDeleteNoAsk'; // 删除"不再询问"的 storage 标记
const TOOLS_H = 30;        // 每张图下方工具行高度（px）

// rAF：逻辑层支持 requestAnimationFrame；低版本回退到 16ms 定时器
const raf = (typeof requestAnimationFrame === 'function')
  ? requestAnimationFrame
  : function (cb) { return setTimeout(cb, 16); };
const caf = (typeof cancelAnimationFrame === 'function')
  ? cancelAnimationFrame
  : function (id) { clearTimeout(id); };

/** 取一张图片的可预览地址（字符串直接用，对象取 tempFilePath，兼容草稿/存档 URL） */
function srcOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item.tempFilePath === 'string') return item.tempFilePath;
  if (item && typeof item.url === 'string') return item.url;
  return '';
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

Component({
  properties: {
    items: { type: Array, value: [] },        // 页面图片数组（字符串 或 {tempFilePath}）
    size: { type: Number, value: 340 },        // 图片边长 rpx（默认340≈170px@375pt，贴近旧版180px）
    gap: { type: Number, value: 16 },          // 图片间距 rpx
    tip: { type: String, value: '' },          // 顶部提示文案
    showTools: { type: Boolean, value: true }, // 显示"设封面/删除"工具行
    showAdd: { type: Boolean, value: true },   // 显示末尾"+"新增位
    invalid: { type: Boolean, value: false },  // 表单校验红框（猫页"未选照片"）
  },

  data: {
    internalItems: [],       // 内部列表：[{id, src, raw, x, err}]
    scrollLeft: 0,           // scroll-view 滚动位置（仅初始/结束/滚动同步；跟手期不动它）
    areaW: 0, areaH: 0,      // movable-area 尺寸（px）
    cardW: 0, cardH: 0, itemPx: 0, stepPx: 0,
    addX: 0,                 // 末尾"+"的左偏移
    drag: { active: false, id: '', x: 0 }, // 拖拽态（active 用于条件绑定 catchtouchmove / 放大）
    settle: { id: '' },      // 松手归位动画期间仍保持放大态的图 id
    delModal: { show: false, id: '', noAsk: false },
  },

  observers: {
    'items, size, gap, showAdd': function () {
      this.measure();
      this.syncItems();
    },
  },

  lifetimes: {
    ready() {
      this.measure();
      this.syncItems();
    },
    detached() {
      this.stopAutoScroll();
      if (this._dragTimer) clearTimeout(this._dragTimer);
    },
  },

  // [AUTO-SCROLL] 切后台/跳页立即归位，避免拖拽状态残留
  pageLifetimes: {
    hide() { this.cancelDrag(); },
  },

  methods: {
    // ============ 尺寸与数据同步 ============

    /** rpx → px 换算，供 movable-view x / 轨道宽度使用（用 getWindowInfo 替代已弃用的 getSystemInfoSync） */
    measure() {
      const info = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const rpx = (info.windowWidth || 375) / 750;
      const itemPx = Math.max(40, Math.round(this.data.size * rpx));
      const gapPx = Math.round(this.data.gap * rpx);
      this._rpx = rpx;
      this._itemPx = itemPx;
      this._gapPx = gapPx;
      this._step = itemPx + gapPx;
      this._cardH = itemPx + TOOLS_H;
      this.setData({
        itemPx,
        cardW: itemPx,
        cardH: this._cardH,
        stepPx: this._step,
      });
    },

    /** 把页面 items 归一化成内部列表（id 按图片地址生成，稳定唯一） */
    syncItems() {
      const raw = Array.isArray(this.data.items) ? this.data.items : [];
      const old = this.data.internalItems || [];
      const byId = {};
      old.forEach((it) => { if (it) byId[it.id] = it; });
      const used = {};
      const next = raw.map((r, i) => {
        const src = srcOf(r) || '';
        let id = src || ('img__' + i);
        if (used[id] != null) id = src + '__' + i; // 同地址重复（罕见）：加序号防 key 冲突
        used[id] = true;
        const prev = byId[id];
        return { id, src, raw: r, x: prev ? prev.x : i * this._step, err: prev ? !!prev.err : false };
      });
      // [AUTO-SCROLL] 拖拽中外部改了 items 数量（如草稿恢复/删除）→ 立即归位，不带半套状态继续
      if (this._drag && this._drag.active && next.length !== old.length) {
        this.cancelDrag();
      }
      // 非拖拽中：位置对齐当前顺序（追加/删除/恢复后重排）
      if (!(this._drag && this._drag.active)) {
        next.forEach((it, i) => { it.x = i * this._step; });
      }
      this.setData({
        internalItems: next,
        areaW: (next.length + (this.data.showAdd ? 1 : 0)) * this._step,
        areaH: this._cardH,
        addX: next.length * this._step,
      });
    },

    // ============ 长按 / 拖拽 ============

    onTouchStart(e) {
      // 工具按钮（设封面/删除角标）上的触摸不进拖拽流程：按钮用 catchtap 处理点击，
      // touchstart 仍会冒泡到这里，用 data-tool 标记挡掉（与旧 imgEditor 一致）
      const target = e.target && e.target.dataset;
      if (target && target.tool) return;
      const id = e.currentTarget.dataset.id;
      const list = this.data.internalItems;
      if (list.length < 2) return; // 空/单张不可拖
      const startSlot = list.findIndex((it) => it.id === id);
      if (startSlot < 0) return;
      if (this._drag && this._drag.active) return; // 已在拖拽
      const touch = e.touches && e.touches[0];
      if (!touch) return;
      this._drag = {
        id,
        active: false,
        cancelled: false,
        startClientX: touch.clientX,
        startSlot,
        slot: startSlot,
        scrollLeft0: this._scrollLeft || 0,
        reordered: false,
      };
      this._clientX = touch.clientX;
      this._edge = null;     // [AUTO-SCROLL] 当前边缘滚动方向（'left'/'right'/null）
      this._xMap = null;     // [AUTO-SCROLL] 已提交到渲染层的 x（脏值检查用）
      this._hysDir = null;   // [让位] 滞后方向记忆（'right'/'left'/null）
      this._slotLockUntil = 0; // [让位] 冷却锁截止时间戳（0=未锁定）
      this._dragTimer = setTimeout(() => this.activateDrag(), LPRS_MS);
      this.measureSwiper(); // 顺手量容器尺寸（异步）：空闲滑动钳制 / 拖拽边缘自动滚动用
    },

    /**
     * 卡片上【始终绑定】的 catchtouchmove（与旧 imgEditor 同一套机制）：
     * 拦截滑条/页面原生滚动，这里完全接管横向滚动 + 拖拽。
     *   - 未激活（滑动 / 长按未判定）：手指往哪滑，滑条往哪滚（手动滚动）
     *   - 已激活（拖拽中）：只记录手指位置，滚动/跟手交给统一 rAF 帧循环逐帧接管
     * 必须始终绑定，不能靠 setData 条件切换（{{drag.active ? 'x' : ''}}）：
     * 微信在一次触摸手势进行中不会重新绑定 touch 事件（iOS 长按激活后
     * catchtouchmove 绑定失效 → 图不跟手、滑条原生横滑），旧版就是这么踩过。
     */
    onCatchMove(e) {
      const p = this._drag;
      const touch = e.touches && e.touches[0];
      if (!touch) return;
      // [AUTO-SCROLL] 多指：拖拽中出现第二根手指 → 立即归位（防坐标错乱/误操作）
      if (e.touches && e.touches.length > 1) {
        if (p && p.active) this.finishDrag(p);
        return;
      }
      this._clientX = touch.clientX; // [AUTO-SCROLL] 只更新手指位置；位移/方向由 rAF 帧循环每帧算
      if (!p) return;
      if (p.active) return; // 拖拽中：滚动/跟手交给统一 rAF 帧循环
      // ===== 未激活：手动滚动（接管滑条横向滚动） =====
      const dx = touch.clientX - p.startClientX;
      if (!p.cancelled && Math.abs(dx) > MOVE_THRESHOLD) {
        p.cancelled = true; // 位移过大 → 判为滑动，本次触摸不进拖拽
        if (this._dragTimer) { clearTimeout(this._dragTimer); this._dragTimer = null; }
      }
      let sl = (p.scrollLeft0 || 0) - dx;
      sl = clamp(sl, 0, this.currentMaxScrollLeft());
      if (sl !== (this._scrollLeft || 0)) {
        this._scrollLeft = sl;
        this.setData({ scrollLeft: sl });
      }
    },

    /** 350ms 长按判定通过：激活拖拽 */
    activateDrag() {
      this._dragTimer = null;
      const p = this._drag;
      if (!p || p.active || p.cancelled) return; // 已判定为滑动则不激活
      if (this.data.internalItems.length < 2) { this._drag = null; return; }
      p.active = true;
      // 震动反馈（长按进入拖拽）
      if (wx.vibrateShort) wx.vibrateShort({ type: 'heavy', fail: () => {} });
      this._geo = null;
      this._edge = null;
      this._xMap = null;
      this._hysDir = null;     // [让位] 滞后方向记忆（'right'/'left'/null）
      this._slotLockUntil = 0; // [让位] 冷却锁截止时间戳（0=未锁定）
      this._prevFrameTime = 0; // [AUTO-SCROLL] 上一帧时间戳（0 表示"首帧"，dt 用基准值）
      this.measureSwiper(); // 量容器尺寸（异步）
      this.setData({ 'drag.active': true, 'drag.id': p.id, 'drag.x': p.startSlot * this._step });
      this.startAutoScrollLoop();
    },

    onTouchEnd(e) {
      const p = this._drag;
      if (this._dragTimer) { clearTimeout(this._dragTimer); this._dragTimer = null; }
      if (!p) { this.resetTouchState(); return; }
      if (p.active) {
        this.finishDrag(p); // [AUTO-SCROLL] 松手：停滚动→冻结 scrollLeft→算 slot→归位（同帧闭合）
      } else {
        this._drag = null;
        this.resetTouchState();
      }
    },

    // ============ [AUTO-SCROLL] 拖拽引擎：统一 rAF 帧循环（连续平滑式） ============

    /** 清空本次触摸的运行时状态（手指位置/边缘方向/帧计时/让位方向） */
    resetTouchState() {
      this._clientX = null;
      this._edge = null;
      this._xMap = null;
      this._clientXPrev = null;
      this._prevFrameTime = 0;
      this._hysDir = null;
      this._slotLockUntil = 0;
    },

    /** 当前最大可滚动距离：由已知 areaW 与可视宽直接算出（不依赖 scrollOffset 的 scrollWidth） */
    currentMaxScrollLeft() {
      const w = (this._geo && this._geo.width) || 0;
      return Math.max(0, (this.data.areaW || 0) - w);
    },

    /**
     * 统一帧循环单步（连续平滑滚动 + 连续跟手）：
     *   每帧算一次滚动位移（速度随贴边程度连续变化，无首步等待/无跳格）与被拖图 x；
     *   只做一次 setData（脏值 >1px 才刷）；滚动帧把 scrollLeft 与被拖图 x 合并成
     *   一次原子 setData，避免"scrollLeft 与 item.x 两条渲染管线时间差"导致的抖动。
     */
    frameStep(now) {
      const p = this._drag;
      if (!p || !p.active) return;
      if (!this._geo) { this.measureSwiper(); return; } // 首次先量尺寸
      const n = this.data.internalItems.length;
      if (n < 2) return;

      // 1) 每帧重读最大可滚动距离（items 增删时 areaW 会变，不缓存旧值）
      this._geo.maxScrollLeft = this.currentMaxScrollLeft();
      this._scrollLeft = clamp(this._scrollLeft || 0, 0, this._geo.maxScrollLeft);

      // 2) 帧时长 + 手指本帧位移（方向抑制用）
      const dt = (this._prevFrameTime === 0) ? FRAME_MS : Math.max(1, now - this._prevFrameTime);
      this._prevFrameTime = now;
      const prevX = (this._clientXPrev == null) ? this._clientX : this._clientXPrev;
      const dxFrame = this._clientX - prevX; // px，+ 向右
      this._clientXPrev = this._clientX;

      // 3) 方向抑制阈值：低帧率时按 dt 比例放大，避免微抖动误判为"拖离边缘"
      const dirTh = Math.max(DIR_EPS, dt / FRAME_MS);

      // 4) 边缘连续滚动：位置迟滞 + 方向抑制，速度随贴边程度连续变化
      const edge = this.edgeState(dxFrame, dirTh);
      const oldSL = this._scrollLeft || 0;
      let newScrollLeft = oldSL;
      if (edge) {
        const speed = this.edgeSpeed(edge);              // px/s（连续，非离散）
        const dir = (edge === 'left') ? -1 : 1;
        newScrollLeft = clamp(oldSL + speed * dir * (dt / 1000), 0, this._geo.maxScrollLeft);
      }
      const didScroll = Math.abs(newScrollLeft - oldSL) > SCROLL_EPS;
      if (didScroll) this._scrollLeft = newScrollLeft;

      // 5) 被拖图跟手（连续）：trackX = 起按槽位 + 手指位移 + 滚动补偿
      const scrollDelta = newScrollLeft - p.scrollLeft0;
      const maxX = (n - 1) * this._step;
      const trackX = clamp(
        p.startSlot * this._step + (this._clientX - p.startClientX) + scrollDelta,
        0, maxX
      );
      const slot = this.settleSlot(trackX, p.slot, n, now);
      if (slot !== p.slot) p.reordered = true;
      p.slot = slot;

      // 6) 最小化 setData：跟手帧单字段（脏值 >1px），滚动/重排帧合并为一次
      this.applyFrame(newScrollLeft, trackX, slot, didScroll);
    },

    /**
     * 边缘方向判定（位置迟滞 + 方向抑制）：
     *   - 位置迟滞：进 EDGE_ZONE_ENTER、出 EDGE_ZONE_EXIT
     *   - 方向抑制：贴左缘但手指向右拖（dxFrame > 阈值）不触发/退出；停住 dxFrame≈0 触发
     *   - 贴右缘但向左拖同理
     */
    edgeState(dxFrame, dirTh) {
      if (typeof this._clientX !== 'number' || !this._geo) return null;
      const g = this._geo;
      const cx = this._clientX;
      const dLeft = cx - g.containerLeft;
      const dRight = (g.containerLeft + g.width) - cx;
      const movingRight = dxFrame > dirTh;
      const movingLeft = dxFrame < -dirTh;

      let edge = this._edge || null;
      if (edge === 'left') {
        if (dLeft > EDGE_ZONE_EXIT || movingRight) edge = null;
      } else if (edge === 'right') {
        if (dRight > EDGE_ZONE_EXIT || movingLeft) edge = null;
      }
      if (!edge) {
        if (dLeft >= 0 && dLeft < EDGE_ZONE_ENTER && !movingRight) edge = 'left';
        else if (dRight >= 0 && dRight < EDGE_ZONE_ENTER && !movingLeft) edge = 'right';
      }
      this._edge = edge;
      return edge;
    },

    /**
     * [让位] 槽位吸附（带滞后）：进入灵敏（覆盖目标图约 1/3 即触发）、退出迟钝（退回约 1/2 才恢复）。
     * 用 _hysDir 记忆上次让位方向，区分"继续让位"与"反方向退回"，防手指在临界点抖动导致图片反复横跳。
     * 每帧最多 ±1 格（手指/滚动一帧位移远小于半格），返回钳制后的新槽位。
     */
    settleSlot(trackX, slot, n, now) {
      const step = this._step;
      if (step <= 0 || n < 2) return slot;
      // [槽位锁定] 让位/退回后冷却 SLOT_LOCK_MS：快速滑过多张图时不再连续换位，
      // 消除"越过下一张 1/3 又立即让位"的自激闪现；冷却结束才解锁进入下一轮判断。
      if (this._slotLockUntil && now < this._slotLockUntil) return slot;

      const raw = trackX / step; // 连续浮点槽位（itemPx≈step，gap 很小，误差 <5%）
      const hys = this._hysDir;
      let s = slot;

      if (hys === 'right') {
        // 刚向右让位：继续向右（灵敏 SLOT_ENTER），向左退回（迟钝 SLOT_EXIT）
        if (raw > s + SLOT_ENTER && s < n - 1) {
          s += 1; // hys 保持 'right'
        } else if (raw < s - (1 - SLOT_EXIT)) {
          s -= 1; this._hysDir = null; // 退回到左邻，恢复稳定
        }
      } else if (hys === 'left') {
        // 刚向左让位：继续向左（灵敏 SLOT_ENTER），向右退回（迟钝 SLOT_EXIT）
        if (raw < s - SLOT_ENTER && s > 0) {
          s -= 1; // hys 保持 'left'
        } else if (raw > s + (1 - SLOT_EXIT)) {
          s += 1; this._hysDir = null; // 退回到右邻，恢复稳定
        }
      } else {
        // 稳定态：左右首次让位都灵敏（SLOT_ENTER）
        if (raw > s + SLOT_ENTER && s < n - 1) { s += 1; this._hysDir = 'right'; }
        else if (raw < s - SLOT_ENTER && s > 0) { s -= 1; this._hysDir = 'left'; }
      }

      if (s !== slot) this._slotLockUntil = now + SLOT_LOCK_MS; // 本次发生换位 → 进入冷却锁
      return clamp(s, 0, n - 1);
    },

    /**
     * 连续滚动速度（px/s）：贴边最快（EDGE_RATE_MAX 张/秒），边界最慢（EDGE_RATE_MIN 张/秒），
     * 用 t² 曲线让"越贴边加速越猛"，同时保证边界处（d≈40px）速度仍明显、一进边缘区即平滑起步。
     */
    edgeSpeed(edge) {
      const g = this._geo;
      const cx = this._clientX;
      const d = (edge === 'left') ? (cx - g.containerLeft) : ((g.containerLeft + g.width) - cx);
      const t = clamp(1 - d / EDGE_ZONE_ENTER, 0, 1); // 1=贴边(最快)，0=边界(最慢)
      return (EDGE_RATE_MIN + (EDGE_RATE_MAX - EDGE_RATE_MIN) * t * t) * this._step;
    },

    /**
     * 落地一帧：把 scrollLeft（滚动帧）与被拖图 x（跟手帧）合并为一次原子 setData。
     *   - 滚动帧 + 重排帧：patch 同时含 scrollLeft 与 internalItems → 一次 setData
     *   - 纯跟手帧：仅被拖图 x 单字段（脏值 >1px 才刷，key 约 20B + 1 number，<256B）
     */
    applyFrame(newScrollLeft, trackX, slot, didScroll) {
      const p = this._drag;
      const arr = this.data.internalItems.slice();
      const dragIdx = arr.findIndex((it) => it.id === p.id);
      if (dragIdx < 0) return;

      const patch = {};
      if (didScroll) patch.scrollLeft = newScrollLeft;

      let cur = dragIdx;
      if (dragIdx !== slot) {
        const item = arr.splice(dragIdx, 1)[0];
        arr.splice(slot, 0, item);
        cur = slot;
        // 重排帧（越过中点才发生，低频）：整数组一次性落地，重算所有 x
        arr.forEach((it, i) => { it.x = it.id === p.id ? trackX : i * this._step; });
        patch.internalItems = arr;
        this._xMap = {};
        arr.forEach((it) => { this._xMap[it.id] = it.x; });
      } else {
        // 纯跟手帧：仅被拖图 x 变化 → 单字段 setData（脏值 >1px）
        const oldX = this._xMap ? this._xMap[p.id] : undefined;
        if (typeof oldX === 'undefined' || Math.abs(trackX - oldX) > TRACK_EPS) {
          if (!this._xMap) this._xMap = {};
          this._xMap[p.id] = trackX;
          patch['internalItems[' + cur + '].x'] = trackX;
        }
      }

      if (Object.keys(patch).length) this.setData(patch);
    },

    /**
     * 松手 / 多指 / 切后台 共用的归位逻辑（三件事同帧闭合）：
     *   ① stopAutoScroll 停 rAF（连续滚动无惯性，列表即停）
     *   ② 沿用拖拽中已过滞后的 p.slot（frameStep 每帧已精算，松手不重算避免滞后丢失）
     *   ③ 重排数组 + 全部 x 归位到 slot，setData 启动平滑动画
     * 纯 setData scroll-left 无惯性，scrollLeft 在松手瞬间即定格，slot 直接取拖拽末帧结果，无二次运动/跳变。
     */
    finishDrag(p) {
      this.stopAutoScroll();
      const arr = this.data.internalItems.slice();
      const n = arr.length;
      const slot = clamp(p.slot, 0, n - 1); // 拖拽末帧已过滞后的稳定槽位（松手不重新四舍五入）
      const wasReorder = p.reordered || slot !== p.startSlot;
      const dragIdx = arr.findIndex((it) => it.id === p.id);
      if (dragIdx >= 0 && dragIdx !== slot) {
        const item = arr.splice(dragIdx, 1)[0];
        arr.splice(slot, 0, item);
      }
      arr.forEach((it, i) => { it.x = i * this._step; }); // 全部归位到槽位（animation=true 平滑滑入）
      const settleId = p.id;
      this._drag = null;
      this.resetTouchState();
      // 先清 active（恢复 animation=true → 平滑滑入目标槽位），settle 保持放大态到动画结束
      this.setData({
        internalItems: arr,
        drag: { active: false, id: '', x: 0 },
        settle: { id: settleId },
        scrollLeft: this._scrollLeft || 0,
      });
      this._justDragged = true; // 300ms 内忽略 tap，防拖拽松手误触预览
      setTimeout(() => {
        this._justDragged = false;
        this.setData({ 'settle.id': '' });
        if (wasReorder) this.emitChange('drag'); // 排序变化 → 写回页面数组
      }, 240);
    },

    /** 切后台 / 组件卸载时兜底归位（不做排序提交，只让视觉状态回正） */
    cancelDrag() {
      const p = this._drag;
      if (this._dragTimer) { clearTimeout(this._dragTimer); this._dragTimer = null; }
      if (p && p.active) this.finishDrag(p);
      else if (p) { this._drag = null; this.resetTouchState(); }
    },

    // ============ 滚动 / 测量 ============

    /** scroll-view 滚动回调：只记录位置，不 setData（避免滚↔set 循环） */
    onScroll(e) {
      const sl = e && e.detail && e.detail.scrollLeft;
      if (typeof sl === 'number') this._scrollLeft = sl;
    },

    /** 测量滑条容器：可视区左右边界（屏幕坐标）+ 最大可滚动距离 */
    measureSwiper() {
      this.createSelectorQuery().select('#isScroll').boundingClientRect().exec((res) => {
        if (res && res[0]) {
          const w = res[0].width;
          this._geo = {
            containerLeft: res[0].left,
            width: w,
            maxScrollLeft: Math.max(0, (this.data.areaW || 0) - w),
          };
        } else {
          this._geo = null;
        }
      });
    },

    /** 激活拖拽时启动 rAF 循环：每帧做「连续滚动 + 跟手 + 重排 + 最小 setData」，可选输出性能 */
    startAutoScrollLoop() {
      if (this._rafId) return;
      this._clientXPrev = this._clientX;
      if (DEBUG_FPS) {
        this._dbg = { frames: 0, start: Date.now(), frameTotal: 0, frameMax: 0 };
      }
      const tick = () => {
        if (!this._drag || !this._drag.active) { this._rafId = null; return; }
        if (DEBUG_FPS) {
          const t0 = Date.now();
          this.frameStep(t0);
          this.logFrame(t0, Date.now());
        } else {
          this.frameStep(Date.now());
        }
        this._rafId = raf(tick);
      };
      this._rafId = raf(tick);
    },

    stopAutoScroll() {
      if (this._rafId) { caf(this._rafId); this._rafId = null; }
    },

    /** [AUTO-SCROLL] 性能观测：每秒输出 rafFPS + 每帧耗时（avg/max） */
    logFrame(t0, t1) {
      if (!this._dbg) return;
      const d = this._dbg;
      const dt = t1 - t0;
      d.frames += 1;
      d.frameTotal += dt;
      if (dt > d.frameMax) d.frameMax = dt;
      const elapsed = t1 - d.start;
      if (elapsed >= 1000) {
        const fps = d.frames * 1000 / elapsed;
        console.log('[image-sorter][FPS] rafFPS=' + fps.toFixed(1) +
          ' frameAvg=' + (d.frameTotal / d.frames).toFixed(2) +
          'ms frameMax=' + d.frameMax.toFixed(2) + 'ms');
        d.frames = 0;
        d.frameTotal = 0;
        d.frameMax = 0;
        d.start = t1;
      }
    },

    // ============ 删除 / 设封面 / 预览 ============

    onDelete(e) {
      const id = e.currentTarget.dataset.id;
      const idx = this.data.internalItems.findIndex((it) => it.id === id);
      if (idx < 0) return;
      if (wx.getStorageSync(NOASK_KEY)) { this.doDelete(id); return; }
      this.setData({ delModal: { show: true, id, noAsk: false } });
    },

    doDelete(id) {
      const arr = this.data.internalItems.slice();
      const idx = arr.findIndex((it) => it.id === id);
      if (idx < 0) return;
      arr.splice(idx, 1);
      arr.forEach((it, i) => { it.x = i * this._step; });
      this.setData({
        internalItems: arr,
        areaW: (arr.length + (this.data.showAdd ? 1 : 0)) * this._step,
        addX: arr.length * this._step,
      });
      this.emitChange('delete');
    },

    delConfirm() {
      const m = this.data.delModal;
      if (m.noAsk) wx.setStorageSync(NOASK_KEY, true);
      this.setData({ 'delModal.show': false });
      if (m.id) this.doDelete(m.id);
    },

    delCancel() { this.setData({ 'delModal.show': false }); },

    toggleNoAsk() { this.setData({ 'delModal.noAsk': !this.data.delModal.noAsk }); },

    noop() {},

    onSetCover(e) {
      const id = e.currentTarget.dataset.id;
      const arr = this.data.internalItems.slice();
      const idx = arr.findIndex((it) => it.id === id);
      if (idx <= 0) return; // 第一张已是封面
      const item = arr.splice(idx, 1)[0];
      arr.unshift(item);
      arr.forEach((it, i) => { it.x = i * this._step; });
      this.setData({ internalItems: arr });
      this.emitChange('cover');
    },

    onItemTap(e) {
      if (this._justDragged) return; // 拖拽松手后的误触保护
      const id = e.currentTarget.dataset.id;
      const list = this.data.internalItems;
      const idx = list.findIndex((it) => it.id === id);
      if (idx < 0) return;
      const urls = list.map((it) => it.src).filter(Boolean);
      if (!urls.length) return;
      wx.previewImage({ urls, current: list[idx].src || urls[0] });
    },

    onImgError(e) {
      const id = e.currentTarget.dataset.id;
      const arr = this.data.internalItems.slice();
      const idx = arr.findIndex((it) => it.id === id);
      if (idx < 0) return;
      arr[idx].err = true;
      this.setData({ internalItems: arr });
    },

    onAddTap() {
      this.triggerEvent('add', {});
    },

    // ============ 对外 ============

    /** 把内部顺序映射回页面原始数组（bind:change 通知页面写回字段） */
    emitChange(source) {
      const raw = this.data.internalItems.map((it) => it.raw);
      this.triggerEvent('change', { items: raw, source });
    },
  },
});

// ============================================================
// 改动清单（对应用例编号，供 diff 审查）
// ============================================================
// [用例3 边缘自动滚动]  连续平滑式：edgeSpeed 速度随贴边程度连续变化（贴边 3 张/秒 →
//                       边界 0.8 张/秒，t² 曲线），一进边缘区立即平滑起步、无停留/无跳格；
//                       maxScrollLeft 由 areaW 计算。
// [用例2 长按横移跟手]  frameStep 每帧重算 trackX = 起按槽位 + 手指位移 + 滚动补偿，
//                       被拖图始终钉在手指下（含手指停在边缘、列表连续滚动的场景）。
// [用例2 让位灵敏度]    settleSlot 槽位吸附带滞后：进入覆盖约 1/3 触发（比 50% 中点灵敏，
//                       减少"已拖过去却没反应"的迟滞）、退出退回约 1/2 恢复（比进入大，
//                       防手指临界抖动横跳）；_hysDir 记忆让位方向区分"继续/退回"。
// [用例4 松手归位]      finishDrag 三件事同帧闭合：停 rAF → 取末帧已过滞后的 slot →
//                       重排归位；纯 setData 滚动无惯性，松手不跳变。
// [用例5 拖到最右不滚过头] 每帧 clamp(scrollLeft, 0, maxScrollLeft)，滚到尽头即停。
// [用例1 长按350ms震动放大] activateDrag 保留 wx.vibrateShort + 放大态（drag/settle 机制未动）。
// [用例6 单击预览不误触]  _justDragged 300ms 防误触（未动，finishDrag 内保留）。
// [用例7 设封面/删除不再询问] onSetCover/doDelete/delConfirm/NOASK_KEY（未动）。
// [用例9 +新增走getphoto] onAddTap → triggerEvent('add')（未动）。
// [用例10 iOS长按不弹菜单] 依赖 wxml/wxss 的 catchlongpress + user-select:none（未动）。
// [方向抑制]            edgeState 用每帧位移 dxFrame（无 EMA/无衰减），阈值 dirTh =
//                       Math.max(DIR_EPS, dt/FRAME_MS)，低帧率按 dt 放大不误判；停住触发。
// [多指触摸]            onCatchMove 检测 touches.length>1 → finishDrag 立即归位。
// [切后台归位]          pageLifetimes.hide → cancelDrag；detached 兜底 stopAutoScroll。
// [性能可观测]          DEBUG_FPS 开关 + logFrame 每秒输出 rafFPS + 每帧耗时（avg/max）。
// [性能·最小setData]    applyFrame 跟手帧单字段 setData（脏值 >1px 才刷）；滚动/重排帧合并一次。
// [修复抖动]            滚动帧把 scrollLeft 与被拖图 x 合并为一次原子 setData，消除
//                       scrollLeft 与 item.x 两条渲染管线时间差导致的反复抖动。
// [修复iOS边缘手势中断] 滚动驱动改用纯 setData scroll-left，移除 ScrollContext；配合
//                       wxml 移除 enhanced，避免 iOS 边缘区原生 pan 手势接管触发 touchcancel。
// [修复弃用警告]        measure 用 wx.getWindowInfo（回退 getSystemInfoSync）。
// [拖拽中items变更]     syncItems 检测数量变化 → cancelDrag 归位，避免半套状态继续。
// ============================================================
