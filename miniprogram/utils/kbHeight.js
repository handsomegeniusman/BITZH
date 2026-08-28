// ============================================================
// utils/kbHeight.js —— 可靠的键盘高度获取（跟随键盘的完成栏 / 正文工具栏共用）
// 背景：wx.onKeyboardHeightChange 在两端都有已知缺陷，直接用它定位「完成」栏会出错：
//   - iOS：键盘弹起时【首次回调高度为 0】；页面先聚焦 input 再聚焦 textarea/editor 时
//     全局事件可能完全不触发（个别机型）；搜狗/百度等输入法内部收起键盘后不再触发事件；
//   - 安卓：弹起时首次回调值【偏小】（非实际键盘高度）；点键盘外空白处收起时不触发事件。
// 本模块统一规避（以下规则来自社区实测，微信官方暂无统一修复）：
//   1. 弹起只认非 0 高度 —— 高度 >0 才视为弹起，>0 期间重置一切收起判定；
//      收起【不等】1s 轮询：收到 0 高度事件先进 200ms 确认窗口 + getKeyboardHeight 同步复核
//      （iOS 弹起首回调可能是 0，不能见 0 就收；复核仍 >0 说明键盘其实还弹着，取消收起），
//      复核属实才判定收起；事件全失灵时轮询连续 2 次读 0（约 0.5s）也能兜底收起；
//   2. 多源并收 —— wx.onKeyboardHeightChange 全局事件 + feed()（各输入框的
//      bindkeyboardheightchange 逐元素事件，iOS 上比全局事件可靠）+ getKeyboardHeight
//      轮询兜底，三路走同一套规则合并；
//   3. 去抖通知 —— 高度变化 50ms 后再通知订阅方：iOS/安卓首次值都会被后续事件纠正，
//      去抖避免"栏先跳到错误位置再跳回来"的闪动；
//   4. resetSoon / cancelResetSoon —— 页面"自然失焦"（切输入框/点外部，键盘可能不真收）时
//      用 resetSoon(delay) 延迟清零：delay 内又有新高度或又聚焦（cancelResetSoon）则维持弹起，
//      真收起（无任何非 0 来源进来）则延迟后复位——比只靠事件/轮询更快、更稳。
// 单位：px（与事件高度、fixed bottom 定位一致）。
// ============================================================
const POLL_MS = 250;   // 轮询间隔（ms）
const ZERO_HIDE = 2;   // 连续读到 0 的次数阈值（约 0.5s），超过才判定键盘收起
const EMIT_DELAY = 50; // 高度变化合并去抖（ms）
const COLLAPSE_CONFIRM_MS = 200; // 收到 0 高度事件后的确认窗口（ms）：窗口内同步复核
                          // getKeyboardHeight 仍 >0 说明键盘其实还弹着（iOS 弹起首回调 0），取消收起
const SUPPRESS_MS = 400; // reset()/doCollapse() 后抑制非 0 来源的时长（ms）：收键盘动画期间
                        // getKeyboardHeight 可能仍读残高，防止「完成/收起」后栏闪回

let kbH = 0;          // 当前可靠键盘高度（px；0 = 未弹起）
let kbUp = false;     // 键盘是否弹起
let zeroCount = 0;    // 连续读 0 次数（任何非 0 来源都会清零）
let kbRegistered = false; // 全局事件是否已注册（去重）
let suppressUntil = 0;    // 显式清零后的抑制截止时间（内部）
let pollTimer = null;
let emitTimer = null;
let collapseTimer = null; // 0 高度事件后的"确认收起"定时器
let resetTimer = null;    // resetSoon 的延迟清零定时器
const subs = [];      // 订阅回调 [(kbH, kbUp) => void]

function doEmit() {
  const h = kbH;
  const up = kbUp;
  subs.slice().forEach(function (cb) { if (typeof cb === 'function') cb(h, up); });
}

/** 高度变化合并：50ms 内只通知一次（等被纠正后的最终值） */
function scheduleEmit() {
  if (emitTimer) clearTimeout(emitTimer);
  emitTimer = setTimeout(doEmit, EMIT_DELAY);
}

/** 取消"确认收起"定时器（键盘仍弹起 / 已收起 / 显式清零时调用） */
function cancelCollapse() {
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
}

/** 正式判定收起：清状态 + 开启短时抑制（防收键盘动画期间读到的残高把栏闪回） */
function doCollapse() {
  cancelCollapse();
  kbH = 0;
  kbUp = false;
  zeroCount = 0;
  suppressUntil = Date.now() + SUPPRESS_MS;
  doEmit();
}

/** 收到 0 高度事件（且当前判为弹起）→ 200ms 确认 + 同步复核 getKeyboardHeight：
 *  iOS 弹起首回调是 0，窗口内复核到真高度就取消收起；真收起（复核仍 0）才判定。
 *  确认窗口内又有非 0 来源进来（accept(h>0)）也会 cancelCollapse 取消。 */
function scheduleCollapseConfirm() {
  if (!kbUp) return;
  cancelCollapse();
  collapseTimer = setTimeout(function () {
    collapseTimer = null;
    if (!kbUp) return; // 期间已被 reset()/resetSoon()/doCollapse() 处理
    // 同步复核：getKeyboardHeight 仍 >0 → 键盘其实还弹着（弹起首回调 0 的假象），取消收起
    if (typeof wx.getKeyboardHeight === 'function' && wx.getKeyboardHeight() > 0) return;
    doCollapse();
  }, COLLAPSE_CONFIRM_MS);
}

/** 核心合并规则：
 *  高度 >0 = 弹起（重置全部收起判定与抑制）→ 记录最新高度；
 *  高度 <=0 且当前判为弹起 → 进"确认收起"流程（200ms 复核，不立即收起）；
 *  reset()/doCollapse() 的抑制期内忽略非 0 高度（收键盘动画残高不算弹起）。 */
function accept(h) {
  if (h > 0) {
    if (Date.now() < suppressUntil) return; // 抑制期内（点完成/收起后）非 0 不算弹起
    cancelResetSoon();
    cancelCollapse();
    zeroCount = 0;
    if (h !== kbH || !kbUp) {
      kbH = h;
      kbUp = true;
      scheduleEmit();
    }
    return;
  }
  // 高度 0：当前认为弹起才进确认（未弹起时的 0 无意义，忽略）
  if (kbUp) scheduleCollapseConfirm();
}

/** 全局事件：键盘弹起时首次回调在 iOS 是 0、安卓偏小，都交给 accept 过滤/后续纠正 */
function onGlobalKb(res) {
  accept((res && res.height) || 0);
}

/** 轮询兜底：事件全失灵时仍能拿到高度；连续 0 达到阈值才判定收起（防单次误读闪动） */
function pollOnce() {
  if (typeof wx.getKeyboardHeight !== 'function') return; // 旧基础库：只靠事件 + 显式清零
  const h = wx.getKeyboardHeight() || 0;
  if (h > 0) {
    accept(h);
    return;
  }
  if (!kbUp) { zeroCount = 0; return; } // 未弹起时的 0 不算"连续收起"
  zeroCount += 1;
  if (zeroCount >= ZERO_HIDE) {
    doCollapse();
  }
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(pollOnce, POLL_MS);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ============ 对外方法（模块级函数声明：accept()/resetSoon() 内部裸调用
// cancelResetSoon()/reset() 必须能命中作用域，不能收进 exports 对象里
// —— 那会变成"对象方法"，模块顶层裸调用 ReferenceError） ============

/** 逐元素事件喂进来：<input|textarea bindkeyboardheightchange="..."> 的 e.detail.height，
 *  iOS 上全局事件失灵时（如先聚焦 input 再聚焦 textarea）这是可靠的来源。 */
function feed(height) {
  accept(Number(height) || 0);
}

/** 显式清零（点「完成」/明确收起键盘时调用），不等轮询与事件。
 *  同时开启短时抑制：收键盘动画期间轮询读到的残高不算数（防"栏收起后又闪回"）。 */
function reset() {
  cancelCollapse();
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  zeroCount = 0;
  suppressUntil = Date.now() + SUPPRESS_MS;
  if (kbH !== 0 || kbUp) {
    kbH = 0;
    kbUp = false;
    doEmit();
  }
}

/** 延迟清零（"自然失焦"用）：页面切输入框 / 点外部时键盘可能不真收，delay 内没有
 *  新的非 0 高度进来（且没有 cancelResetSoon）才复位；期间又聚焦/有高度则维持弹起。
 *  @param {Number} [delay] 延迟毫秒数（缺省 300） */
function resetSoon(delay) {
  const ms = (typeof delay === 'number' && delay > 0) ? delay : 300;
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(function () {
    resetTimer = null;
    reset();
  }, ms);
}

/** 取消 resetSoon 的延迟清零（聚焦回来 / 有新的非 0 高度时调用，见 accept） */
function cancelResetSoon() {
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
}

module.exports = {
  /** 订阅键盘状态变化；立即以当前状态回调一次。返回取消订阅函数。 */
  subscribe(cb) {
    subs.push(cb);
    if (!kbRegistered && wx.onKeyboardHeightChange) {
      kbRegistered = true;
      wx.onKeyboardHeightChange(onGlobalKb);
    }
    startPoll();
    if (typeof cb === 'function') cb(kbH, kbUp);
    return function () {
      const i = subs.indexOf(cb);
      if (i >= 0) subs.splice(i, 1);
      if (!subs.length) {
        stopPoll();
        if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
        cancelCollapse();
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        if (kbRegistered && wx.offKeyboardHeightChange) {
          wx.offKeyboardHeightChange(onGlobalKb);
          kbRegistered = false;
        }
        kbH = 0;
        kbUp = false;
        zeroCount = 0;
        suppressUntil = 0; // 清掉抑制标记，下次订阅从干净状态开始
      }
    };
  },

  /** 逐元素事件喂进来：<input|textarea bindkeyboardheightchange="..."> 的 e.detail.height，
   *  iOS 上全局事件失灵时（如先聚焦 input 再聚焦 textarea）这是可靠的来源。 */
  feed: feed,

  /** 显式清零（点「完成」/明确收起键盘时调用），不等轮询与事件。
   *  同时开启短时抑制：收键盘动画期间轮询读到的残高不算数（防"栏收起后又闪回"）。 */
  reset: reset,

  /** 延迟清零（"自然失焦"用）：页面切输入框 / 点外部时键盘可能不真收，delay 内没有
   *  新的非 0 高度进来（且没有 cancelResetSoon）才复位；期间又聚焦/有高度则维持弹起。
   *  @param {Number} [delay] 延迟毫秒数（缺省 300） */
  resetSoon: resetSoon,

  /** 取消 resetSoon 的延迟清零（聚焦回来 / 有新的非 0 高度时调用，见 accept） */
  cancelResetSoon: cancelResetSoon,

  /** 当前键盘状态 */
  get: function () { return { kbH: kbH, kbUp: kbUp }; },
};
