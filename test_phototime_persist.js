// 逐图日期持久化验证：exportPhotoDates/seedPhotoDates 往返 + 草稿恢复后权重判定恢复
// 复现场景：封面 2026，添加 2025 后应保持 2026。跨会话（草稿/数据库）恢复逐图日期后不失效。
global.wx = {
  showToast() {},
  getFileSystemManager() { return { stat() {}, readFile() {} }; },
  onKeyboardHeightChange() {},
};
global.getApp = () => ({ globalData: {} });

const photoTime = require('./miniprogram/utils/photoTime.js');

// 模拟页面：setData 支持点路径
function makePage(imgField, list, photoTimeVal) {
  const data = { imgField: imgField, listData: { photoTime: photoTimeVal } };
  data[imgField] = list || []; // 列表放进对应字段（imgEditor.listOf 读取处）
  return {
    data: data,
    _photoTimes: {},
    _photoTimeAutoFilled: false,
    _photoTimeTouched: false,
    setData(obj) {
      Object.keys(obj).forEach(function (k) {
        const parts = k.split('.');
        let cur = this.data;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = obj[k];
      }, this);
    },
  };
}

let fail = 0;
function check(name, cond) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name);
  if (!cond) fail++;
}

const COVER_URL = 'https://cdn/main/images/draft/u/d/img0.jpg';
const coverDate = '2026-08-20';
const addedDate = '2025-06-15';

// ---- 1. exportPhotoDates / seedPhotoDates 往返 ----
const pageA = makePage('tempFileList', [
  { tempFilePath: COVER_URL }, { tempFilePath: 'wxfile://added' },
]);
pageA._photoTimes[COVER_URL] = { date: coverDate, source: 'name' };
pageA._photoTimes['wxfile://added'] = { date: addedDate, source: 'name' };
const dates = photoTime.exportPhotoDates(pageA, pageA.data.tempFileList);
check('导出按顺序对齐 [' + dates + ']', dates[0] === coverDate && dates[1] === addedDate);

// 新页面（模拟跨会话恢复）：seed 后缓存重建，条目与列表一一对应
const pageB = makePage('tempFileList', [
  { tempFilePath: COVER_URL }, { tempFilePath: 'wxfile://added' },
]);
photoTime.seedPhotoDates(pageB, pageB.data.tempFileList, dates);
check('seed 回填缓存', pageB._photoTimes[COVER_URL].date === coverDate);

// ---- 2. 恢复后加一张 2025 照片，reaggregate → 封面仍 2026 ----
const pageC = makePage('tempFileList', [
  { tempFilePath: COVER_URL },      // 封面：已恢复日期
  { tempFilePath: 'wxfile://added' }, // 2025 照片：已恢复日期
], coverDate);
photoTime.seedPhotoDates(pageC, pageC.data.tempFileList, dates);
pageC.setData({ listData: { photoTime: coverDate } }); // 发布记录/草稿的聚合值
// 触发一次空聚合（等价恢复后某次重算）：entries 用缓存构建，封面应保持 2026
photoTime.reaggregate(pageC);
check('恢复后聚合仍为封面 2026', pageC.data.listData.photoTime === coverDate);

// ---- 3. 直接验证：恢复后 entries 顺序正确，加权 1.5 > 1.0 ----
const entries = pageC.data.tempFileList.map(function (it) {
  const p = (typeof it === 'string') ? it : it.tempFilePath;
  const e = pageC._photoTimes[p];
  return e && e.date ? e.date : null;
});
check('恢复后 entries = [' + entries + '] 封面不丢', entries[0] === coverDate);
check('加权聚合 = 封面', photoTime.weightedPhotoDate(entries) === coverDate);

// ---- 4. 老草稿（无 photoDates/photoTimes）→ seed 安全跳过，不崩 ----
const pageD = makePage('imageUrls', [COVER_URL]);
photoTime.seedPhotoDates(pageD, pageD.data.imageUrls, undefined);
check('老数据无 photoDates → 不崩、不产生缓存', Object.keys(pageD._photoTimes).length === 0);

console.log(fail === 0 ? '\n全部通过 ✓' : '\n有 ' + fail + ' 项失败 ✗');
process.exit(fail === 0 ? 0 : 1);
