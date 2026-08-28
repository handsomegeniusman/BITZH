// 权重 bug 复现 + 修复验证（Node，纯逻辑，不碰 wx）
// 复现：draft.persistLocalImages 把封面本地路径换成 COS 草稿 URL，_photoTimes 缓存
//       键仍挂在本地路径 → 聚合时封面查不到日期（dates[0]=null）→ 新增的 2025 反超。
const photoTime = require('./miniprogram/utils/photoTime.js');
const { weightedPhotoDate } = photoTime;

/** 复刻 recognizeAndFill/reaggregate 的 entries 构建（srcOf = tempFilePath，命中缓存才有日期） */
function buildDates(list, cache) {
  return list.map(function (it) {
    const p = (typeof it === 'string') ? it : (it && it.tempFilePath);
    const e = p && cache[p];
    return (e && e.date) ? e.date : null;
  });
}

const COVER_URL = 'https://cdn/main/images/draft/u/d/img0.jpg'; // 封面已被草稿上传换成的 COS URL
const coverDate = '2026-08-20';
const addedDate = '2025-06-15';
let fail = 0;
function check(name, cond) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name);
  if (!cond) fail++;
}

// ---- 修复前：识别结果挂在本地路径，列表里却已是 COS URL（缓存孤儿） ----
const cacheBefore = {
  'wxfile://cover': { date: coverDate, source: 'name' }, // 封面识别结果（本地键）
  'wxfile://added': { date: addedDate, source: 'name' }, // 刚添加的照片（还没被上传换键）
};
const list = [
  { tempFilePath: COVER_URL },   // 封面：路径已被 draft 上传替换
  { tempFilePath: 'wxfile://added' },
];
const datesBefore = buildDates(list, cacheBefore);
const aggBefore = weightedPhotoDate(datesBefore);
console.log('修复前 dates =', JSON.stringify(datesBefore), '→ agg =', aggBefore);
check('复现 bug：封面键丢失 → 按新添加的 2025 胜出', aggBefore === addedDate);

// ---- 修复后：persistLocalImages 迁移缓存键，COS URL 挂上封面日期 ----
const cacheAfter = Object.assign({}, cacheBefore, { [COVER_URL]: cacheBefore['wxfile://cover'] });
const datesAfter = buildDates(list, cacheAfter);
const aggAfter = weightedPhotoDate(datesAfter);
console.log('修复后 dates =', JSON.stringify(datesAfter), '→ agg =', aggAfter);
check('修复：封面权重 1.5 > 单张 1.0 → 2026 胜出', aggAfter === coverDate);

// ---- 纯函数边界 ----
check('封面 1.5 > 单张 1.0（直接）', weightedPhotoDate([coverDate, addedDate]) === coverDate);
// 2 张 2025 = 2.0 > 封面 1.5 → 数量反超封面（设计如此，确认未被破坏）
check('封面 1.5 < 两张 2025（2.0）→ 2025 反超', weightedPhotoDate([coverDate, addedDate, addedDate]) === addedDate);
// 全是 null → null（不动）
check('全部无日期 → null', weightedPhotoDate([null, null]) === null);

console.log(fail === 0 ? '\n全部通过 ✓' : '\n有 ' + fail + ' 项失败 ✗');
process.exit(fail === 0 ? 0 : 1);
