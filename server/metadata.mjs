// Removes embedded metadata from uploaded images before they are stored, so
// a shelf photo or receipt picture never keeps GPS coordinates, device
// details or timestamps. Pixel data is copied unchanged. Unsupported or
// malformed files are rejected rather than stored with metadata intact.

const JPEG_KEEP_APP = new Set([0xe0, 0xe2]); // JFIF header and ICC colour profile
const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Strips APP1 (Exif, XMP) and the other application segments except JFIF and
 * ICC, plus comment segments, from a JPEG. Exif orientation is lost, so a
 * photo may display rotated; that is preferable to keeping location data.
 */
export function stripJpeg(input) {
  const buf = Buffer.from(input);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8)
    throw Error("Not a JPEG image");
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw Error("Malformed JPEG image");
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) throw Error("Malformed JPEG image");
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) throw Error("Malformed JPEG image");
    const end = i + 2 + length;
    if (marker === 0xda) {
      // Start of scan: the entropy-coded image follows; copy the rest as is.
      parts.push(buf.subarray(i));
      i = buf.length;
      break;
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const drop = (isApp && !JPEG_KEEP_APP.has(marker)) || marker === 0xfe;
    if (!drop) parts.push(buf.subarray(i, end));
    i = end;
  }
  return Buffer.concat(parts);
}

/** Drops Exif, text and time chunks from a PNG, keeping image chunks. */
export function stripPng(input) {
  const buf = Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE))
    throw Error("Not a PNG image");
  const parts = [PNG_SIGNATURE];
  let i = 8;
  let ended = false;
  while (i < buf.length) {
    if (i + 12 > buf.length) throw Error("Malformed PNG image");
    const length = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const end = i + 12 + length;
    if (end > buf.length) throw Error("Malformed PNG image");
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended) throw Error("Malformed PNG image");
  return Buffer.concat(parts);
}

/**
 * Returns a copy of an image without metadata. PDFs are returned unchanged:
 * they carry document properties rather than photo location data, and the
 * caller should say so.
 */
export function stripMetadata(buffer, mediaType) {
  if (mediaType === "image/jpeg") return stripJpeg(buffer);
  if (mediaType === "image/png") return stripPng(buffer);
  if (mediaType === "application/pdf") return Buffer.from(buffer);
  throw Error("Unsupported file type");
}
