// Round 5, finding 1 in the browser: the price an estimate uses must apply
// at the branch the stock check covers. The offer is an Open Prices price
// of £12.00 seen at Home Bargains in Preston. In Research the operator
// records a branch check in another locality without a shelf price (the
// price stays unconfirmed there, with the reason), then one that names the
// branch and records the shelf price (the price is confirmed, and the
// figures use the shelf price), at 390 and 1280 px.
//
// The evidence (the Open Prices observation and 26 recent exact sales) is
// written straight into the throwaway database, as the import commands
// would; the checks are recorded through the Research form.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { atWidths, loadChromium, startApp } from "./harness.mjs";

const chromium = loadChromium();
const BARCODE = "5012345678115";
const TITLE = "Mini Bluetooth speaker black";
const DAY = 86400000;
let app;
let browser;

async function setUp() {
  const { openDb } = await import("../apps/server/db.mjs");
  const { londonDate } = await import("../apps/server/http.mjs");
  const { storeLookup, upsertObservations, upsertResearch } = await import("../apps/server/evidence.mjs");
  const now = new Date().toISOString();
  const ago = (n) => londonDate(new Date(Date.now() - n * DAY));
  const db = openDb(join(app.dataDir, "desk.sqlite"));
  upsertObservations(
    db,
    [
      {
        id: 900001,
        title: TITLE,
        store: "Home Bargains",
        place: "PR1 2AR",
        city: "Preston",
        osm_id: "node/111",
        price: 1200,
        day: ago(0),
        barcode: BARCODE,
      },
    ],
    { now },
  );
  const base = { title: TITLE, barcode: BARCODE, size: "one size", pack: "1", model: "BTS-20", condition: "new" };
  const sales = Array.from({ length: 26 }, (_, i) => {
    const sold = 1 + Math.floor((i * 80) / 26);
    return { source_id: "s" + i, seller: "seller" + i, observed: ago(sold), listed: ago(sold + 4) };
  });
  upsertResearch(
    db,
    "sales",
    sales.map((s) => ({ ...base, ...s, kind: "Reported completed sale", price: 2800, retailer: "eBay UK", licence: "Self-reported" })),
    { now },
  );
  storeLookup(db, "ebay", BARCODE, [], { now });
  db.close();
}

before(async () => {
  if (!chromium) return;
  app = await startApp();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  app?.stop();
});

test(
  "Research shows the price unconfirmed at a branch checked without a shelf price, and confirmed once the check records it, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    await setUp();
    // Each width checks a different locality and branch, so the checks
    // recorded at one width do not decide the other.
    const places = {
      390: { locality: "Camden", branch: "Home Bargains, Camden High Street NW1 7JE", price: "12.50", pounds: "£12.50" },
      1280: { locality: "Hackney", branch: "Home Bargains, Mare Street E8 1HE", price: "13.10", pounds: "£13.10" },
    };
    await atWidths(browser, app.url + "/#Research", async (page, width) => {
      const { locality, branch, price, pounds } = places[width];
      await page.locator(".offer-list button", { hasText: TITLE }).first().click();
      await page.getByLabel("Locality for the stock check").fill(locality);
      const line = page.locator("p.branch-price");
      const seen = "the £12\\.00 seen at Home Bargains, PR1 2AR, Preston";

      // No check yet: the price is not confirmed there.
      await line
        .filter({ hasText: `no branch check in ${locality} from the last 2 days shows it applies there` })
        .waitFor();
      assert.equal(await line.getAttribute("data-confirmed"), "no");

      // A check that finds stock but records no shelf price.
      const form = page.locator("fieldset.stock-check");
      await form.getByRole("button", { name: "Record check" }).click();
      await form.getByText(/No shelf price recorded, so the price is confirmed at this branch only if the offer is an Open Prices price from the shop this check names\./).waitFor();
      await line
        .filter({
          hasText: `Price not confirmed at the branch: The £12.00 price was seen at Home Bargains, PR1 2AR, Preston, not at the branch checked in ${locality}: record the shelf price on a branch check there.`,
        })
        .waitFor();
      assert.equal(await line.getAttribute("data-confirmed"), "no");
      assert.match(await line.getAttribute("class"), /\bwarn\b/);

      // The same branch again, named and with the shelf price.
      await form.getByLabel("Branch (optional)").fill(branch);
      await form.getByLabel("Shelf price for one unit, £ (optional)").fill(price);
      await form.getByRole("button", { name: "Record check" }).click();
      await form.getByText(new RegExp(`Shelf price ${pounds.replace(".", "\\.")} recorded\\.`)).waitFor();
      await line.filter({ hasText: "Price confirmed at the branch:" }).waitFor();
      assert.equal(await line.getAttribute("data-confirmed"), "yes");
      const text = (await line.innerText()).replace(/\s+/g, " ");
      assert.match(
        text,
        new RegExp(
          `^Price confirmed at the branch: ${pounds.replace(".", "\\.")} shelf price recorded on the branch check in ${locality} \\(${branch}\\) at .+\\. The figures use it, not ${seen}\\.$`,
        ),
      );
      // The chosen offer is costed at the shelf price and still shows the
      // price as listed.
      const summary = page.locator(".offer-summary");
      await summary.getByText("Shelf price at the branch").waitFor();
      await summary.getByText(new RegExp(`^${pounds.replace(".", "\\.")} on the branch check in ${locality}`)).waitFor();
      await summary.getByText(/£12\.00 at Home Bargains, PR1 2AR, Preston, observed/).waitFor();
      // Both checks are listed with their branch and shelf price.
      const rows = form.locator("tbody tr");
      await rows.filter({ hasText: branch }).filter({ hasText: pounds }).waitFor();
      await rows.filter({ hasText: locality }).filter({ hasText: "not named" }).filter({ hasText: "not recorded" }).waitFor();
      // The shelf price box is emptied once recorded, and a price of nothing
      // is refused (the server refuses it too: server/round5-branch-price.test.mjs).
      const shelf = form.getByLabel("Shelf price for one unit, £ (optional)");
      assert.equal(await shelf.inputValue(), "");
      assert.equal(await form.getByLabel("Branch (optional)").inputValue(), branch, "the branch stays for the next check");
      await shelf.fill("0");
      assert.equal(await shelf.evaluate((el) => el.validity.rangeUnderflow), true);
      await shelf.fill("");
    });
  },
);
