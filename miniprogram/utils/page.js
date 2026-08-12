/**
 * utils/page.js —— 页面公共方法
 * ============================================================
 * 【为什么需要它】如果直接写 this.setData({ ['cat.' + key]: value })
 *   这种"计算属性名"写法，微信开发者工具在把代码编译成 ES5 时，
 *   会把它转换成 @babel/runtime 的辅助函数调用，而项目没有安装
 *   该 npm 包，运行时就会报错：
 *     module '@babel/runtime/helpers/toPropertyKey.js' is not defined
 *   用"临时对象赋值"的写法可以完全避开这个问题。
 * ============================================================
 */

/**
 * 通过"路径字符串"给页面 data 的某个字段赋值
 * @param {Page} page 页面实例（调用时传 this）
 * @param {String} path 字段路径，例如 'cat.name'、'listData[3].good'
 * @param {*} value 要设置的值
 */
function setField(page, path, value) {
  const obj = {};
  obj[path] = value;
  page.setData(obj);
}

/**
 * 猫咪缩略图加载失败时逐级回退：.png → 0.jpg → 占位图。
 * 6 个列表/详情页共用（index / catDetail / mydetail / location / 所有 / 花色）。
 * 页面里保留一行薄封装：onCatImgError(e) { onImgError(this, e); }
 */
function onImgError(page, e) {
  const { list, index } = e.currentTarget.dataset;
  const arr = page.data[list];
  if (!arr || !arr[index]) return;
  const fallback = (arr[index]._thumbFallback || 0) + 1;
  if (fallback > 2) return;
  // 用临时对象赋值写法，避免计算属性名触发 ES5 编译报错
  setField(page, list + '[' + index + ']._thumbFallback', fallback);
}

/**
 * 给猫咪列表项补上"带版本号的缩略图 URL"。
 * 【为什么需要它】微信 <image> 按 URL 缓存图片。提交后某只猫的照片变了，
 *   但 URL（如 名.png / 名0.jpg）没变，页面就仍显示旧的缓存图（刷新才正常）。
 *   每只猫在数据库里有个"照片版本号 photoVer"（提交时照片有变就刷新），
 *   这里把它拼进 URL（?v=版本号），版本一变 URL 就变新 → 微信重新下载新图。
 * 【怎么用】页面拿到数据库列表后调一次：stampThumbs(list, this.data.url)，
 *   然后 WXML 的图片 src 改用这两个字段：
 *   src="{{item._thumbFallback == 1 ? item._thumbJpg : (item._thumbFallback > 1 ? '/pages/images/logo.png' : item._thumbUrl)}}"
 *   旧猫没存 photoVer 时不带 ?v=，URL 跟以前一样，不影响老数据。
 */
function stampThumbs(list, url) {
  return (list || []).map(function (item) {
    if (!item || !item.name) return item;
    const ver = item.photoVer ? '?v=' + item.photoVer : '';
    item._thumbUrl = (url || '') + item.name + '.png' + ver;   // 封面缩略图
    item._thumbJpg = (url || '') + item.name + '0.jpg' + ver;  // 缩略图缺失时的兜底主图
    return item;
  });
}

/** 点击作者头像放大预览（4 个推文相关页面共用） */
function showAuthorImg(e) {
  var url = e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.authorimg;
  if (url) wx.previewImage({ urls: [url] });
}

/**
 * 长按推文：管理员或作者本人可进入编辑页。
 * 注意：bookletDetail 页从 listData.authorId 取作者，不适用本方法。
 */
function editBooklet(e) {
  const _id = e.currentTarget.dataset._id;
  const authorId = e.currentTarget.dataset.authorid;
  const userInfo = getApp().globalData.userInfo || {};
  if (getApp().globalData.isAdministrator || userInfo.userId === authorId) {
    wx.navigateTo({ url: '/pages/editBooklet/editBooklet?_id=' + _id });
  }
}

/** 未登录时弹"请先登录 / 去注册"（5 个页面共用） */
function promptRegister(userId) {
  wx.showModal({
    title: '提示',
    content: '请先登录',
    showCancel: true,
    confirmText: '去登录',
    success: (res) => {
      if (res.confirm) {
        wx.navigateTo({ url: '/pages/regist/regist?userId=' + (userId || '') });
      }
    },
  });
}

module.exports = {
  setField: setField,
  onImgError: onImgError,
  stampThumbs: stampThumbs,
  showAuthorImg: showAuthorImg,
  editBooklet: editBooklet,
  promptRegister: promptRegister,
};
