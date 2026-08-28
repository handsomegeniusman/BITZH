/**
 * utils/exif.js —— JPEG EXIF 拍摄日期提取（零依赖纯函数）
 * ============================================================
 * 【作用】从 JPEG 文件字节中解析 EXIF 的拍摄日期（DateTimeOriginal /
 *        DateTimeDigitized / DateTime），返回 'YYYY-MM-DD'。
 *        纯函数、不碰 wx.*，可在 Node 里直接单测。
 * 【局限】只解析 JPEG（魔数 FFD8）；HEIC / PNG / WebP 等返回 null，
 *        由上层（utils/photoTime.js）降级到文件名 / 修改时间。
 * ============================================================
 */

/** 把 ArrayBuffer / 各种字节视图统一成 Uint8Array；失败返回 null */
function toU8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (buf && buf.buffer instanceof ArrayBuffer) {
    return new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength || buf.buffer.byteLength);
  }
  return null;
}

/** 日期合法性：年 2010-2100，月 1-12，日按当月天数（含闰年） */
function isValidYMD(y, m, d) {
  if (!(y >= 2010 && y <= 2100)) return false;
  if (!(m >= 1 && m <= 12)) return false;
  if (!(d >= 1 && d <= 31)) return false;
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let max = days[m - 1];
  if (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) max = 29;
  return d <= max;
}

/** 按字节序读 u16；越界返回 null */
function u16At(u8, off, le) {
  if (off + 2 > u8.length) return null;
  return le
    ? (u8[off] | (u8[off + 1] << 8))
    : ((u8[off] << 8) | u8[off + 1]);
}

/** 按字节序读 u32；越界返回 null */
function u32At(u8, off, le) {
  if (off + 4 > u8.length) return null;
  const v = le
    ? (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24))
    : ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]);
  return v >>> 0;
}

/**
 * 定位 EXIF 的 APP1（FFE1）段，返回 TIFF 头在字节流中的偏移。
 * 非 JPEG / 找不到返回 -1。
 */
function findExifApp1(u8) {
  const n = u8.length;
  if (n < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return -1; // 非 JPEG
  let i = 2;
  while (i < n - 1) {
    if (u8[i] !== 0xFF) { i++; continue; } // 容忍 FF 填充
    const marker = u8[i + 1];
    if (marker === 0xD8) { i += 2; continue; } // 冗余 SOI
    if (marker === 0xDA || marker === 0xD9) break; // SOS / EOI：EXIF APP1 必在其前，可停
    if (i + 3 >= n) break;
    const segLen = (u8[i + 2] << 8) | u8[i + 3];
    if (segLen < 2) break;
    // 校验 APP1 负载以 "Exif\0\0" 开头（0x45 0x78 0x69 0x66 0x00 0x00）
    if (marker === 0xE1 && segLen >= 8 && i + 10 <= n &&
        u8[i + 4] === 0x45 && u8[i + 5] === 0x78 && u8[i + 6] === 0x69 &&
        u8[i + 7] === 0x66 && u8[i + 8] === 0x00 && u8[i + 9] === 0x00) {
      return i + 10; // TIFF 头偏移
    }
    i += 2 + segLen;
  }
  return -1;
}

/** 解析 TIFF 头：字节序（II/MM）、魔数 42、IFD0 偏移；失败返回 null */
function parseTiff(u8, tiffOff) {
  const n = u8.length;
  if (tiffOff + 8 > n) return null;
  const b0 = u8[tiffOff];
  const b1 = u8[tiffOff + 1];
  let le;
  if (b0 === 0x49 && b1 === 0x49) le = true;      // "II" 小端
  else if (b0 === 0x4D && b1 === 0x4D) le = false; // "MM" 大端
  else return null;
  const magic = u16At(u8, tiffOff + 2, le);
  if (magic !== 42) return null;
  const ifd0Off = u32At(u8, tiffOff + 4, le);
  if (ifd0Off === null) return null;
  return { le: le, tiffOff: tiffOff, ifd0Off: ifd0Off, n: n };
}

/** IFD 条目数硬限：防非标准/恶意结构声称超长条目数导致大循环耗 CPU */
const IFD_MAX_ENTRIES = 200;

/** 读一个 IFD 的条目数组；每条约 12 字节（tag/type/count/valueOffset） */
function readEntries(u8, tiff, ifdOff) {
  if (ifdOff + 2 > tiff.n) return null;
  const count = u16At(u8, ifdOff, tiff.le);
  if (count === null || count > IFD_MAX_ENTRIES) return null;
  const entries = [];
  for (let k = 0; k < count; k++) {
    const e = ifdOff + 2 + k * 12;
    if (e + 12 > tiff.n) break;
    const tag = u16At(u8, e, tiff.le);
    const type = u16At(u8, e + 2, tiff.le);
    const cnt = u32At(u8, e + 4, tiff.le);
    if (tag === null || type === null || cnt === null) break;
    entries.push({ tag: tag, type: type, count: cnt, valueOffset: e + 8 });
  }
  return entries;
}

/** 读 ASCII 条目值：count≤4 内联在 4 字节里，否则按相对 TIFF 的偏移读 */
function readAscii(u8, tiff, entry) {
  if (entry.type !== 2) return null; // 只处理 ASCII
  const len = entry.count;
  let start;
  if (len <= 4) {
    start = entry.valueOffset;
  } else {
    const rel = u32At(u8, entry.valueOffset, tiff.le);
    if (rel === null) return null;
    start = tiff.tiffOff + rel;
  }
  if (start + len > tiff.n) return null;
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = u8[start + i];
    if (c === 0) break; // 字符串以 \0 结束
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * 取拍摄时间字符串：IFD0 读 ExifIFD 指针（0x8769）→ ExifIFD 读
 * DateTimeOriginal（0x9003）/ DateTimeDigitized（0x9004）；
 * 都没有则回落 IFD0 的 DateTime（0x0132）。
 */
function getDateTime(u8, tiff) {
  // 注意：tiff.ifd0Off 是相对 TIFF 头的偏移，readEntries 用的是缓冲区绝对偏移，须加 tiffOff
  const ifd0 = readEntries(u8, tiff, tiff.tiffOff + tiff.ifd0Off);
  if (!ifd0) return null;
  let dateTime0 = null; // IFD0 DateTime 兜底
  let exifOff = -1;     // ExifIFD 绝对偏移
  for (let i = 0; i < ifd0.length; i++) {
    const en = ifd0[i];
    if (en.tag === 0x0132) {
      const s = readAscii(u8, tiff, en);
      if (s) dateTime0 = s;
    } else if (en.tag === 0x8769 && en.count === 1) {
      const rel = u32At(u8, en.valueOffset, tiff.le);
      if (rel !== null) exifOff = tiff.tiffOff + rel;
    }
  }
  if (exifOff >= 0) {
    const exifIfd = readEntries(u8, tiff, exifOff);
    if (exifIfd) {
      for (let i = 0; i < exifIfd.length; i++) {
        const en = exifIfd[i];
        if (en.tag === 0x9003 || en.tag === 0x9004) {
          const s = readAscii(u8, tiff, en);
          if (s) return s;
        }
      }
    }
  }
  return dateTime0;
}

/**
 * 主入口：从 JPEG 字节提取拍摄日期。
 * @param {ArrayBuffer|Uint8Array} buf JPEG 文件字节
 * @returns {String|null} 'YYYY-MM-DD' 或 null（非 JPEG / 无 EXIF / 解析失败）
 */
function extractPhotoDate(buf) {
  try {
    const u8 = toU8(buf);
    if (!u8) return null;
    const tiffOff = findExifApp1(u8);
    if (tiffOff < 0) return null;
    const tiff = parseTiff(u8, tiffOff);
    if (!tiff) return null;
    const s = getDateTime(u8, tiff);
    if (!s) return null;
    const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    if (!isValidYMD(+m[1], +m[2], +m[3])) return null;
    return m[1] + '-' + m[2] + '-' + m[3];
  } catch (e) {
    return null; // 任何异常都降级，不向上抛
  }
}

module.exports = {
  extractPhotoDate: extractPhotoDate,
};
