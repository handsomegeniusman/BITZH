/**
 * utils/media.js —— 照片选择（相册 / 拍摄）公共方法
 * ============================================================
 * 【作用】把 addCat / editCat / addBooklet / editBooklet 里重复的
 *        wx.chooseMedia 选图代码集中到这里，并统一处理：
 *        - 用户取消（静默，不打扰）
 *        - 拒绝相册 / 相机权限（弹窗引导去设置）
 *        - 其他失败（toast 提示重试）
 * ============================================================
 */

/**
 * 处理 wx.chooseMedia 的失败回调
 * @param {Object} err fail 返回的错误对象
 */
function onFail(err) {
  const msg = (err && err.errMsg) || '';
  // 用户主动取消，不打扰
  if (msg.indexOf('cancel') >= 0) return;
  // 权限被拒（相机/相册），引导去设置
  if (msg.indexOf('auth deny') >= 0 || msg.indexOf('auth denied') >= 0 ||
      msg.indexOf('permission') >= 0) {
    wx.showModal({
      title: '无法使用相册/相机',
      content: '需要开启相册和相机权限才能上传照片，是否去设置？',
      confirmText: '去设置',
      success: (res) => {
        if (res.confirm) wx.openSetting();
      },
    });
    return;
  }
  // 其他失败
  wx.showToast({ title: '选择图片失败，请重试', icon: 'none' });
}

/**
 * 打开相册/拍摄选择图片，追加到页面某个数组字段
 * @param {Page} page   页面实例（this）
 * @param {String} field data 中的数组字段名，如 'tempFileList' / 'imageUrls'
 * @param {Number} count 最多可选张数（默认 20）
 * @param {Boolean} asPaths true=只存本地路径字符串（编辑页的 imageUrls 用），
 *                          false=存完整的 tempFiles 对象（新增页预览用）
 * @param {Function} onChange 选图完成后的回调（可选；选图是异步的，页面要用回调
 *                            （如标记"内容已变"）才能拿到刚加入的图片）
 */
function chooseImages(page, field, count, asPaths, onChange) {
  wx.chooseMedia({
    count: count || 20,
    mediaType: ['image'],
    sizeType: ['compressed'], // 优先压缩图，减小上传体积
    success: (res) => {
      const added = asPaths
        ? res.tempFiles.map((f) => f.tempFilePath)
        : res.tempFiles;
      const arr = (page.data[field] || []).concat(added);
      // 用临时对象赋值写法，避免计算属性名触发 ES5 编译报错
      const obj = {};
      obj[field] = arr;
      page.setData(obj);
      // 回调放在 setData 之后调用，保证页面已能看到刚加入的图片
      if (typeof onChange === 'function') onChange(res.tempFiles);
    },
    fail: onFail,
  });
}

module.exports = {
  chooseImages: chooseImages,
  onFail: onFail,
};
