// The app loads and every tab opens without a console error or horizontal
// overflow, at phone and desktop widths.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { atWidths, loadChromium, startApp } from "./harness.mjs";

const chromium = loadChromium();
let app;
let browser;
before(async () => {
  if (!chromium) return;
  app = await startApp();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  app?.stop();
});

test("every tab opens cleanly at 390 and 1280 px", { skip: !chromium && "Playwright is not installed" }, async () => {
  await atWidths(browser, app.url, async (page) => {
    const tabs = page.locator("main > nav > button");
    const count = await tabs.count();
    assert.ok(count >= 4, "expected the app's tabs");
    for (let i = 0; i < count; i++) {
      await tabs.nth(i).click();
      await page.waitForLoadState("networkidle");
      assert.equal(await tabs.nth(i).getAttribute("aria-pressed"), "true");
    }
  });
});
