// ============================================================
// utils/imgEditor.js —— 图片编辑区公共逻辑
// ============================================================
// 【作用】把 editCat / editBooklet / addCat / addBooklet 四个页面
//        图片区重复的交互收拢到这里：
//          1. 长按拖拽排序（长按放大提示可拖 → 相邻图带动画让位 → 松手落位）
//          2. 单击图片 → 微信原生预览 wx.previewImage
//          3. 删除确认（弹窗 + "下次不再询问" 存储标记）
//          4. 设为封面 = 移到最前（方案A：封面永远是第一张）
//        风格对齐 utils/media.js：函数接收页面实例（page）与事件对象（e）。
//        页面里必须用薄封装补 this（微信事件绑定只传 e，方法引用会把 e 当 page 传进来）：
//          onImgTouchStart(e) { imgEditor.touchStart(this, e); }
//        列表字段名：新增页用 tempFileList，编辑页用 imageUrls，
//        页面在 data 里声明 imgField 即可。
// ============================================================

const ITEM_W = 180;       // 每张图片宽度 px（与各页 wxss 的 .image-item 一致）
const GAP = 10;           // 图片间距 px
const STEP = ITEM_W + GAP; // 一个槽位的步进
const LPRS_MS = 350;      // 长按判定阈值（毫秒）
const MOVE_THRESHOLD = 10; // 长按激活前允许的位移，超过视为"滚动"
const MAX_IMGS = 20;      // 图片上限（与 utils/media.js chooseImages 的 count 一致）
const NOASK_KEY = 'imgDeleteNoAsk'; // "删除不再询问"的 storage 标记

// rAF 节流：拖拽中同一帧内多次 touchmove 合并为一次 setData，避免渲染层过载卡顿。
// 逻辑层支持 requestAnimationFrame；低版本缺省时回退到 16ms 定时器，效果相同。
const raf = (typeof requestAnimationFrame === 'function')
  ? requestAnimationFrame
  : function (cb) { return setTimeout(cb, 16); };

/** 当前页面图片列表字段名 */
function fieldOf(page) {
  return page.data.imgField || 'imageUrls';
}

/** 读取图片列表（防御：非数组返回空数组） */
function listOf(page) {
  const list = page.data[fieldOf(page)];
  return Array.isArray(list) ? list : [];
}

/** 写入图片列表（用临时对象赋值，避免计算属性名触发 ES5 编译报错） */
function setList(page, arr) {
  const obj = {};
  obj[fieldOf(page)] = arr;
  page.setData(obj);
}

/** 取一张图片的可预览地址：字符串直接用，对象（tempFiles）取 tempFilePath */
function srcOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item.tempFilePath === 'string') return item.tempFilePath;
  return '';
}

/** 剩余可添加张数（达到 MAX_IMGS 返回 0，getphoto 据此拦截） */
function remaining(page) {
  return Math.max(0, MAX_IMGS - listOf(page).length);
}

// ============ 1. 长按拖拽排序 ============

/** touchstart：记录起点、起按索引，启动长按定时器 */
function touchStart(page, e) {
  // 工具按钮（设封面/删除角标）上的触摸不进拖拽流程：按钮用 catchtap 处理点击，
  // 而微信规定"touchstart 被 catch 后 tap 不再生成"，所以按钮不能挂 catchtouchstart，
  // 只能在这里用 data-tool 标记把长按拖拽挡掉。
  const target = e.target && e.target.dataset;
  if (target && target.tool) return;
  const index = Number(e.currentTarget.dataset.index);
  const list = listOf(page);
  if (!(index >= 0 && index < list.length)) return;
  const touch = e.touches && e.touches[0];
  if (!touch) return;
  const pending = {
    index: index,
    startIndex: index, // 起按槽位（拖拽全程不变，手指位移从它开始累计）
    startX: touch.clientX,
    active: false,
    cancelled: false,
  };
  pending.timer = setTimeout(function () {
    if (!page._dragPending || page._dragPending.cancelled) return;
    page._dragPending.active = true;
    page.setData({ drag: { active: true, index: index, offsetX: 0, step: STEP } });
  }, LPRS_MS);
  page._dragPending = pending;
}

/** touchmove：长按激活后驱动拖拽；未激活且位移过大则取消长按（视为滚动） */
function touchMove(page, e) {
  const p = page._dragPending;
  const touch = e.touches && e.touches[0];
  if (!p || !touch) return;
  if (!p.active) {
    if (Math.abs(touch.clientX - p.startX) > MOVE_THRESHOLD) {
      p.cancelled = true;
      clearTimeout(p.timer);
    }
    return;
  }
  const list = listOf(page);
  if (!list.length) return;

  // 被拖图的期望位置 = 起按槽位 × 步进 + 手指相对起点的横向位移；
  // 整体钳制在轨道内（首槽 ~ 尾槽），不越界、不错位。
  const start = p.startIndex;
  const maxPos = (list.length - 1) * STEP;
  let pos = start * STEP + (touch.clientX - p.startX);
  pos = Math.max(0, Math.min(maxPos, pos));

  // 目标槽位：越过相邻图片的中点 → 邻居让位
  let slot = Math.round(pos / STEP);
  slot = Math.max(0, Math.min(list.length - 1, slot));
  const offsetX = pos - slot * STEP; // 落在目标槽位内的残余位移（跟手量）

  // rAF 节流：只记录最新一次位移，同一帧内多次 touchmove 合并为一次 setData，
  // 避免每帧几十次 setData 导致渲染层过载、拖拽卡顿。
  if (!page._dragFrame) {
    page._dragFrame = { slot: slot, offsetX: offsetX };
    raf(function () {
      const m = page._dragFrame;
      page._dragFrame = null;
      if (m) applyDrag(page, m.slot, m.offsetX);
    });
  } else {
    page._dragFrame.slot = slot;
    page._dragFrame.offsetX = offsetX;
  }
}

/** 每帧真正落地一次拖拽位移：数组重排 + 拖拽状态同批 setData，保证渲染一致、被拖图始终跟手 */
function applyDrag(page, slot, offsetX) {
  const p = page._dragPending;
  if (!p) return; // 已松手，丢弃本帧（松手前的中间位移不渲染）
  if (slot !== p.index) {
    const arr = listOf(page).slice();
    const item = arr.splice(p.index, 1)[0];
    arr.splice(slot, 0, item);
    p.index = slot;
    const obj = {};
    obj[fieldOf(page)] = arr;
    obj['drag.index'] = slot;
    obj['drag.offsetX'] = offsetX;
    page.setData(obj);
  } else {
    page.setData({ 'drag.offsetX': offsetX });
  }
}

/** touchend / touchcancel：松手落位，清拖拽状态（被拖图带 transition 归位） */
function touchEnd(page) {
  const p = page._dragPending;
  page._dragPending = null;
  page._dragFrame = null; // 丢弃未落地的一帧（applyDrag 会因 _dragPending 为空直接跳过）
  if (!p) return;
  clearTimeout(p.timer);
  if (p.active) {
    page._justDragged = true; // 300ms 内忽略 tap，防误触预览
    page.setData({ drag: { active: false, index: -1, offsetX: 0, step: STEP } });
    setTimeout(function () { page._justDragged = false; }, 300);
  }
}

// ============ 2. 单击预览 ============

/** 单击图片 → 微信原生全屏预览（可左右滑动、长按保存） */
function tap(page, e) {
  if (page._justDragged) return; // 拖拽松手后的误触保护
  const list = listOf(page);
  const index = Number(e.currentTarget.dataset.index);
  if (!(index >= 0 && index < list.length)) return;
  const urls = list.map(srcOf).filter(Boolean);
  if (!urls.length) return;
  const current = srcOf(list[index]) || urls[0];
  wx.previewImage({ urls: urls, current: current });
}

// ============ 3. 删除确认 ============

/** 点删除角标：已勾"不再询问"直接删；否则弹确认框 */
function onDelete(page, e) {
  const index = Number(e.currentTarget.dataset.index);
  const list = listOf(page);
  if (!(index >= 0 && index < list.length)) return;
  if (wx.getStorageSync(NOASK_KEY)) {
    doDelete(page, index);
    return;
  }
  page.setData({ delModal: { show: true, index: index, noAsk: false } });
}

/** 真正从列表移除（只改前端列表，提交时才动 COS，误删可恢复） */
function doDelete(page, index) {
  const list = listOf(page);
  if (!(index >= 0 && index < list.length)) return;
  const arr = list.slice();
  arr.splice(index, 1);
  setList(page, arr);
}

/** 确认删除 */
function delConfirm(page) {
  const m = page.data.delModal || {};
  if (m.noAsk) wx.setStorageSync(NOASK_KEY, true);
  doDelete(page, m.index);
  page.setData({ 'delModal.show': false });
}

/** 取消删除 */
function delCancel(page) {
  page.setData({ 'delModal.show': false });
}

/** 切换"下次不再询问" */
function toggleNoAsk(page) {
  page.setData({ 'delModal.noAsk': !(page.data.delModal || {}).noAsk });
}

// ============ 4. 设为封面（方案A：封面 = 第一张） ============

/** 点"设封面"：把该张移到第一位，成为封面（角标高亮随动） */
function setCover(page, e) {
  const index = Number(e.currentTarget.dataset.index);
  const list = listOf(page);
  if (!(index > 0 && index < list.length)) return; // 第一张已是封面
  const arr = list.slice();
  const item = arr.splice(index, 1)[0];
  arr.unshift(item);
  setList(page, arr);
}

/** 空操作（用于 catch 阻止事件冒泡，如按钮不触发父级预览/拖拽） */
function noop() {}

module.exports = {
  // 拖拽排序
  touchStart: touchStart,
  touchMove: touchMove,
  touchEnd: touchEnd,
  // 单击预览
  tap: tap,
  // 删除确认
  onDelete: onDelete,
  delConfirm: delConfirm,
  delCancel: delCancel,
  toggleNoAsk: toggleNoAsk,
  // 设为封面
  setCover: setCover,
  // 工具
  noop: noop,
  remaining: remaining,
  MAX_IMGS: MAX_IMGS,
  // 列表读写（草稿自动保存 utils/draft.js 靠这三个读取/写回图片列表：
  // 新增页是对象数组 {tempFilePath}，编辑页是 URL 字符串数组，srcOf 都能取到地址）
  listOf: listOf,
  setList: setList,
  srcOf: srcOf,
};
