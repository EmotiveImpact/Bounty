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

// Every screen of the app, by its address.
const SCREENS = ["Deals", "Scan", "Bounties", "Ledger", "Goals", "Planner", "Research", "Saved", "Profile", "Plans", "Crew", "Admin"];

test("every screen opens cleanly at 390 and 1280 px", { skip: !chromium && "Playwright is not installed" }, async () => {
  await atWidths(browser, app.url, async (page, width) => {
    // On a phone the bottom bar, on a computer the side rail: both lead to
    // the same five main screens.
    const bar = width < 900 ? page.locator("nav.phone-nav button") : page.locator(".strip .nav");
    assert.ok((await bar.count()) >= 5, "expected the main screens in the menu");
    for (const name of SCREENS) {
      await page.evaluate((h) => (location.hash = h), name);
      await page.waitForLoadState("networkidle");
      const heading = page.locator("main h1").first();
      await heading.waitFor({ timeout: 10000 });
      assert.ok((await heading.innerText()).trim().length > 0, `${name} has a heading`);
    }
  });
});
