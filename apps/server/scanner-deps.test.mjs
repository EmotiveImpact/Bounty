import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Scan loads the ZXing reader's .wasm from this site (apps/web/src/Scan.tsx). The
// .wasm must be the exact version barcode-detector was built against, or
// every read fails with a WASM memory error.
test("the camera reader's wasm matches the version barcode-detector expects", () => {
  const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
  const app = read("../../package.json");
  const detector = read("../../node_modules/barcode-detector/package.json");
  assert.equal(app.dependencies["zxing-wasm"], detector.dependencies["zxing-wasm"]);
  assert.equal(read("../../node_modules/zxing-wasm/package.json").version, detector.dependencies["zxing-wasm"]);
});
