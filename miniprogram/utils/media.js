/**
 * utils/media.js —— 照片选择（相册 / 拍摄 / 聊天）公共方法
 * ============================================================
 * 【作用】把 addCat / editCat / addBooklet / editBooklet 里重复的
 *        wx.chooseMedia / wx.chooseMessageFile 选图代码集中到这里，并统一处理：
 *        - 用户取消（静默，不打扰）
 *        - 拒绝相册 / 相机权限（弹窗引导去设置）
 *        - 其他失败（toast 提示重试）
 * 【自动识别拍摄时间】booklet 页传入 opts.sizeType=['original','compressed']
 *        （相册勾「原图」才有 EXIF）+ opts.onTime 回调（在 setData 之后、
 *        onChange 之前拿到刚加入的图片，交给 photoTime.recognizeAndFill）。
 *        聊天入口 chooseImagesFromChat 能拿到原始文件名 name / 发送时间 time，
 *        这两个字段只经 onTime 传给识别逻辑，不写进列表（防草稿丢字段）。
 * ============================================================
 */

/** 开发者工具：缓存判断结果（chooseMessageFile 在纯工具模式下不可用，用于隐藏聊天入口）。
 *  注意：工具模拟器切成 iPhone/Android 时 platform 会返回 ios/android，此判断只能覆盖
 *  「devtools」模式；其余环境靠 chooseImagesFromChat 的失败兜底提示（见 onChatFail）。 */
let _isDevtools = null;
function isDevtools() {
  if (_isDevtools !== null) return _isDevtools;
  try {
    // wx.getDeviceInfo 替代已弃用的 getSystemInfoSync（getSystemInfoSync 在工具里会打弃用警告）
    let platform = '';
    if (typeof wx.getDeviceInfo === 'function') platform = wx.getDeviceInfo().platform;
    else platform = wx.getSystemInfoSync().platform; // 低基础库兜底
    _isDevtools = platform === 'devtools';
  } catch (e) {
    _isDevtools = false;
  }
  return _isDevtools;
}

/**
 * chooseMessageFile 专用失败处理：取消静默；隐私未声明 / 环境不支持给明确提示。
 * 与 onFail 分开：chooseMessageFile 的隐私错误不含相册权限语义，弹「去设置」会误导。
 */
function onChatFail(err) {
  const msg = (err && err.errMsg) || '';
  if (msg.indexOf('cancel') >= 0) return; // 用户取消，静默
  console.error('[chooseMessageFile]', err); // 保留原始错误，方便真机/工具排查
  if (msg.indexOf('privacy') >= 0 || msg.indexOf('authorize') >= 0 || msg.indexOf('permission') >= 0) {
    // 隐私未授权 / 授权被关（拒绝、后台未声明「选中的文件」等）→ 引导去小程序设置页开启
    wx.showModal({
      title: '无法从聊天记录选图',
      content: '需要在设置中开启「选中的文件」授权后才能选择聊天图片，是否去设置？',
      confirmText: '去设置',
      success: (res) => {
        if (res.confirm) wx.openSetting();
      },
    });
    return;
  }
  // 工具模拟器（模拟成 ios/android 时 isDevtools 拦不住）/ PC 端微信等环境不支持
  wx.showModal({
    title: '无法从聊天记录选图',
    content: '当前环境不支持选择聊天图片，请改用相册或相机。',
    showCancel: false,
  });
}

/**
 * 处理 wx.chooseMedia / wx.chooseMessageFile 的失败回调
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
 * @param {Object} opts 可选配置（老 5 参调用完全不受影响）：
 *                      opts.sizeType 传给 chooseMedia 的 sizeType，默认 ['compressed']；
 *                      传 ['original','compressed'] 时相册可勾「原图」（原图才带 EXIF）。
 *                      opts.sourceType 传给 chooseMedia 的 sourceType，默认 ['album','camera']；
 *                      传 ['camera'] 直接打开相机，['album'] 只开相册（配合三项平铺选图）。
 *                      opts.onTime 在 setData 之后、onChange 之前调用，
 *                      参数 = 刚加入图片的 {tempFilePath, size} 数组（供识别拍摄时间）。
 */
function chooseImages(page, field, count, asPaths, onChange, opts) {
  const opt = opts || {};
  const sizeType = Array.isArray(opt.sizeType) ? opt.sizeType : ['compressed'];
  const sourceType = Array.isArray(opt.sourceType) ? opt.sourceType : ['album', 'camera'];
  wx.chooseMedia({
    count: count || 20,
    mediaType: ['image'],
    sizeType: sizeType, // 默认压缩图，减小上传体积
    sourceType: sourceType, // 默认相册+相机；「相机/相册」单独入口时只传对应值，免二次选择
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
      if (typeof opt.onTime === 'function') {
        opt.onTime(res.tempFiles.map((f) => ({ tempFilePath: f.tempFilePath, size: f.size })));
      }
      if (typeof onChange === 'function') onChange(res.tempFiles);
    },
    fail: onFail,
  });
}

/** 判断 chooseMessageFile 返回的文件是否是图片（type 前缀 + 扩展名双保险） */
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i;
function isImageFile(f) {
  if (!f) return false;
  if (typeof f.type === 'string' && f.type.toLowerCase().indexOf('image') === 0) return true;
  return !!(f.name && IMAGE_EXT_RE.test(f.name));
}

/**
 * 从微信聊天记录选择图片（能拿到原始文件名 name / 发送时间 time，
 * 供"文件名时间戳 / 发送时间"层识别拍摄时间）。
 * 注意：wx.chooseMessageFile 在开发者工具里不可用（fail），真机才正常。
 * @param {Page} page   页面实例（this）
 * @param {String} field data 中的数组字段名
 * @param {Number} count 最多可选张数
 * @param {Boolean} asPaths true=只存本地路径字符串，false=存 {tempFilePath, name, size, type, time}
 * @param {Function} onChange 选图完成后的回调（同 chooseImages）
 * @param {Function} onTime 识别回调（同 opts.onTime）；参数带 name/time，
 *                          这两个字段只进识别逻辑，不写进列表
 */
function chooseImagesFromChat(page, field, count, asPaths, onChange, onTime) {
  wx.chooseMessageFile({
    count: count || 20,
    type: 'image',
    success: (res) => {
      // 归一化：补 tempFilePath（对齐 srcOf），保留 name/time 供识别
      const normalized = (res.tempFiles || [])
        .map((f) => ({
          tempFilePath: f.path,
          name: f.name,
          size: f.size,
          type: f.type,
          time: f.time,
        }))
        .filter((f) => isImageFile(f)); // 二次过滤非图片，防异常文件混入
      // 去掉被过滤掉的非图片数（防超过页面剩余张数）
      const room = Math.max(0, count || 0);
      const picked = room > 0 && normalized.length > room ? normalized.slice(0, room) : normalized;
      if (picked.length < normalized.length) {
        wx.showToast({ title: '已跳过非图片文件', icon: 'none' });
      }
      const added = asPaths ? picked.map((f) => f.tempFilePath) : picked;
      const arr = (page.data[field] || []).concat(added);
      const obj = {};
      obj[field] = arr;
      page.setData(obj);
      if (typeof onTime === 'function') onTime(picked); // name/time 只进识别，不写进列表
      if (typeof onChange === 'function') onChange(picked);
    },
    fail: onChatFail, // 取消静默；隐私未声明 / 工具、PC 端不支持给明确提示
  });
}

module.exports = {
  chooseImages: chooseImages,
  chooseImagesFromChat: chooseImagesFromChat,
  isDevtools: isDevtools,
  onFail: onFail,
};
