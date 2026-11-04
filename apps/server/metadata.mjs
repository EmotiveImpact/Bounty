// Removes embedded metadata from uploaded images before they are stored, so
// a shelf photo or receipt picture never keeps GPS coordinates, device
// details or timestamps. Files are rebuilt from an allowlist of the parts
// needed to display them; pixel data is copied unchanged. Unsupported or
// malformed files are rejected rather than stored with metadata intact.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// PNG chunks that carry only image data or colour handling. Every other
// chunk (eXIf, text, time, private and provenance chunks) is dropped.
const PNG_KEEP = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP",
  "sBIT", "pHYs", "bKGD", "cICP", "mDCV", "cLLI", "hIST", "sPLT",
]);

// JPEG segments needed to decode the image. Application segments are kept
// only for the JFIF header, an ICC colour profile and the Adobe colour
// transform flag; Exif, XMP, MPF, maker notes and comments are dropped.
function keepJpegSegment(marker, payload) {
  const tag = (text) => payload.subarray(0, text.length).toString("latin1") === text;
  if (marker === 0xe0) return tag("JFIF\0");
  if (marker === 0xe2) return tag("ICC_PROFILE\0");
  if (marker === 0xee) return tag("Adobe");
  if (marker >= 0xe0 && marker <= 0xef) return false; // other APPn
  if (marker === 0xfe) return false; // comment
  // Frame headers, Huffman and quantisation tables, restart interval,
  // arithmetic coding conditioning, define number of lines.
  return (
    (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) ||
    marker === 0xdb || marker === 0xdd || marker === 0xdc
  );
}

/**
 * Rebuilds a JPEG from the segments needed to decode it. Exif (with GPS),
 * XMP, MPF, comments and every other application segment are dropped, and
 * anything after the end-of-image marker (motion photo video, secondary
 * MPF images, trailers) is discarded. Progressive files with several scans
 * are followed scan by scan. Exif orientation is lost, so a photo may
 * display rotated; that is preferable to keeping location data.
 */
export function stripJpeg(input) {
  const buf = Buffer.from(input);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8)
    throw Error("Not a JPEG image");
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  let scans = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw Error("Malformed JPEG image");
    const marker = buf[i + 1];
    if (marker === undefined) throw Error("Malformed JPEG image");
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      if (!scans) throw Error("Malformed JPEG image");
      parts.push(buf.subarray(i, i + 2));
      // Everything after the end of the image is discarded.
      return Buffer.concat(parts);
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
      throw Error("Malformed JPEG image");
    if (i + 4 > buf.length) throw Error("Malformed JPEG image");
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) throw Error("Malformed JPEG image");
    const end = i + 2 + length;
    if (marker === 0xda) {
      // Start of scan: copy the header, then the entropy-coded data up to
      // the next marker. Stuffed bytes (FF 00) and restart markers belong
      // to the scan.
      parts.push(buf.subarray(i, end));
      let j = end;
      while (j < buf.length) {
        if (buf[j] === 0xff && j + 1 < buf.length) {
          const next = buf[j + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            j += 2;
            continue;
          }
          if (next === 0xff) {
            j++;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= buf.length) throw Error("Malformed JPEG image");
      parts.push(buf.subarray(end, j));
      scans++;
      i = j;
      continue;
    }
    if (keepJpegSegment(marker, buf.subarray(i + 4, end))) parts.push(buf.subarray(i, end));
    i = end;
  }
  throw Error("Malformed JPEG image");
}

/**
 * Rebuilds a PNG from the chunks needed to display it. Exif, text, time and
 * any unknown or private chunk are dropped, as is anything after IEND.
 */
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
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(i, end));
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
