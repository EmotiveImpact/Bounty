import { test } from "node:test";
import assert from "node:assert/strict";
import { stripJpeg, stripPng, stripMetadata } from "./metadata.mjs";

const segment = (marker, payload) => {
  const body = Buffer.from(payload);
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};

test("JPEG Exif, XMP and comments are removed and pixels kept", () => {
  const exif = segment(0xe1, "Exif\0\0GPSLatitude51.5074");
  const jfif = segment(0xe0, "JFIF\0\x01\x01");
  const comment = segment(0xfe, "taken at 10 Downing Street");
  const quant = segment(0xdb, "\0quant");
  const scan = Buffer.concat([segment(0xda, "\x01\x01\0"), Buffer.from([1, 2, 3, 0xff, 0xd9])]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, exif, comment, quant, scan]);
  const out = stripJpeg(jpeg);
  assert.ok(!out.includes("GPSLatitude"));
  assert.ok(!out.includes("Downing"));
  assert.ok(out.includes("JFIF"));
  assert.ok(out.includes(Buffer.from([1, 2, 3, 0xff, 0xd9])));
  assert.throws(() => stripJpeg(Buffer.from("not an image")));
});

test("PNG text and Exif chunks are removed", () => {
  const chunk = (type, data) => {
    const body = Buffer.from(data);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", "0123456789abc"),
    chunk("eXIf", "GPS 51.5"),
    chunk("tEXt", "Location\0Leeds"),
    chunk("IDAT", "pixels"),
    chunk("IEND", ""),
  ]);
  const out = stripPng(png);
  assert.ok(!out.includes("GPS"));
  assert.ok(!out.includes("Leeds"));
  assert.ok(out.includes("pixels"));
  assert.throws(() => stripPng(png.subarray(0, png.length - 12)));
});

test("unsupported types are refused", () => {
  assert.throws(() => stripMetadata(Buffer.from("GIF89a"), "image/gif"));
});

test("JPEG data after the end of the image is discarded, with its location", () => {
  // A motion photo or MPF file: the primary image, then a second JPEG with
  // its own Exif GPS and a video box with a location atom.
  const exif = segment(0xe1, "Exif\0\0GPSLatitude51.5390");
  const mpf = segment(0xe2, "MPF\0index of secondary images");
  const icc = segment(0xe2, "ICC_PROFILE\0\x01\x01colours");
  const scan = Buffer.concat([segment(0xda, "\x01\x01\0"), Buffer.from([7, 0xff, 0x00, 8, 0xff, 0xd0, 9])]);
  const primary = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, mpf, icc, scan, Buffer.from([0xff, 0xd9])]);
  const secondary = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, scan, Buffer.from([0xff, 0xd9])]);
  const video = Buffer.from("\0\0\0\x18ftypmp42\xa9xyz+51.5390-000.1426/", "latin1");
  const out = stripJpeg(Buffer.concat([primary, secondary, video]));
  assert.ok(!out.includes("GPSLatitude"));
  assert.ok(!out.includes("MPF"));
  assert.ok(!out.includes("ftyp"));
  assert.ok(out.includes("ICC_PROFILE"));
  // Stuffed bytes and restart markers stay inside the scan.
  assert.ok(out.includes(Buffer.from([7, 0xff, 0x00, 8, 0xff, 0xd0, 9, 0xff, 0xd9])));
  assert.deepEqual(out.subarray(-2), Buffer.from([0xff, 0xd9]));
});

test("progressive JPEG scans are kept and segments between them are filtered", () => {
  const scan = (bytes) => Buffer.concat([segment(0xda, "\x01\x01\0"), Buffer.from(bytes)]);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xc2, "frame"),
    segment(0xc4, "huffman one"),
    scan([1, 2]),
    segment(0xfe, "comment between scans"),
    segment(0xe1, "Exif\0\0GPS between scans"),
    segment(0xc4, "huffman two"),
    scan([3, 4]),
    Buffer.from([0xff, 0xd9]),
  ]);
  const out = stripJpeg(jpeg);
  assert.ok(out.includes("huffman one") && out.includes("huffman two"));
  assert.ok(out.includes(Buffer.from([3, 4, 0xff, 0xd9])));
  assert.ok(!out.includes("comment between") && !out.includes("GPS between"));
});

test("a JPEG without an end of image or a scan is refused", () => {
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xdb, "\0quant")]);
  assert.throws(() => stripJpeg(Buffer.concat([head, segment(0xda, "\x01\x01\0"), Buffer.from([1, 2])])));
  assert.throws(() => stripJpeg(Buffer.concat([head, Buffer.from([0xff, 0xd9])])));
});

test("PNG private chunks and data after IEND are dropped", () => {
  const chunk = (type, data) => {
    const body = Buffer.from(data);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", "0123456789abc"),
    chunk("iCCP", "profile"),
    chunk("prVt", "GPS 51.5 private"),
    chunk("caBX", "provenance with location"),
    chunk("IDAT", "pixels"),
    chunk("IEND", ""),
    Buffer.from("trailing GPS 51.5"),
  ]);
  const out = stripPng(png);
  assert.ok(!out.includes("GPS"));
  assert.ok(!out.includes("provenance"));
  assert.ok(out.includes("profile") && out.includes("pixels"));
});
