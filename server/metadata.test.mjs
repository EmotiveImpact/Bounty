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
