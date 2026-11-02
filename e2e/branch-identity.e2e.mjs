// Round 5, branch identity in the browser (the verifier's report on
// fc02d8a, finding 1): a Camden branch check whose branch field names the
// Preston shop must not make the Preston Open Prices price count as a
// Camden shelf price. The offer is £12.00 seen at Home Bargains, PR1 2AR,
// Preston (OpenStreetMap node/111). In Research the operator records a
// Camden check naming that shop, by its id at 390 px and by its postcode at
// 1280 px: the price stays unconfirmed with the reason, and the check's
// reply carries the warning for the form. A Preston check naming the same
// shop then confirms it, so a genuine same-shop price still counts.
//
// The second test (the verifier's second report) does the same within
// London: Open Prices gives the city as London across Greater London, so a
// Camden check naming the Croydon shop (node/333, CR0 1AB, city London)
// must leave its price unconfirmed, with a warning that names the boroughs
// CR0 is in, while a Croydon check naming it confirms it.
//
// The third test (the verifier's third report) covers two more mistakes:
// a "Romford, London" or "Stratford, London" check was read as all of
// London, so the Croydon shop counted again; and the real Acton Morrisons
// (way/26295319, W3 9LA), which Open Prices records under the district
// name Acton, was refused for an Ealing check. Now the first stays
// unconfirmed and the second confirms.
//
// The fourth test (the fourth pass) checks the form itself: after a check
// is saved, the form shows the server's branch warning ("Check saved. " and
// the warning), after the older-check warning when both are set. A
// Birmingham check naming the real Stirchley shop (B29 6HH, which Open
// Prices records under the suburb name Stirchley) stays unconfirmed with a
// reason that says Open Prices does not show it is in Birmingham, not that
// it is elsewhere, and a "Romford London" check (no comma) takes a Romford
// shop.
//
// Each width runs on its own app and throwaway database, so a check
// recorded at one width never decides the other. The evidence (the Open
// Prices observation and 26 recent exact sales) is written straight into
// the database, as the import commands would; the checks are recorded
// through the Research form.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { atWidths, loadChromium, startApp } from "./harness.mjs";

const chromium = loadChromium();
const BARCODE = "5012345678115";
const TITLE = "Mini Bluetooth speaker black";
const DAY = 86400000;
let browser;

const PRESTON_OP = { id: 900001, store: "Home Bargains", place: "PR1 2AR", city: "Preston", osm_id: "node/111" };
const CROYDON_OP = { id: 900002, store: "Home Bargains", place: "CR0 1AB", city: "London", osm_id: "node/333" };
// Real Open Prices locations (prices.openfoodfacts.org, fetched 2026-11-01).
const ACTON_OP = { id: 900003, store: "Morrisons", place: "W3 9LA", city: "Acton", osm_id: "way/26295319" };
const STIRCHLEY_OP = { id: 900004, store: "Home Bargains", place: "B29 6HH", city: "Stirchley", osm_id: "node/501" };
const ROMFORD_OP = { id: 900005, store: "Home Bargains", place: "RM1 3ER", city: "Romford", osm_id: "node/503" };

async function setUp(app, observation = PRESTON_OP) {
  const { openDb } = await import("../server/db.mjs");
  const { londonDate } = await import("../server/http.mjs");
  const { storeLookup, upsertObservations, upsertResearch } = await import("../server/evidence.mjs");
  const now = new Date().toISOString();
  const ago = (n) => londonDate(new Date(Date.now() - n * DAY));
  const db = openDb(join(app.dataDir, "desk.sqlite"));
  upsertObservations(
    db,
    [observation].flat().map((o) => ({ ...o, title: TITLE, price: 1200, day: ago(0), barcode: BARCODE })),
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
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

// The branch price line when the price seen at a shop the check names is
// not confirmed: it says the price was seen at that shop, and why Open
// Prices does not place it in the locality (estimate.mjs priceAtBranch with
// audit.mjs branchPlace, since the fourth pass).
const notConfirmedLine = (seenAt, why) =>
  `Price not confirmed at the branch: The £12.00 price was seen at ${seenAt}, the shop the branch check names, but ${why}: record the shelf price on a branch check there.`;
const RECORD_PRICE = "To cost a trip from this check, record the shelf price on it.";

// Records a check through the form and returns the API's reply to it.
async function recordCheck(page, branch, button = "Record check") {
  const form = page.locator("fieldset.stock-check");
  await form.getByLabel("Branch (optional)").fill(branch);
  const reply = page.waitForResponse(
    (r) => r.url().endsWith("/api/research/checks") && r.request().method() === "POST",
  );
  await form.getByRole("button", { name: button }).click();
  const response = await reply;
  assert.equal(response.status(), 201);
  return response.json();
}

// The form's message after a save: with a branch warning, "Check saved. "
// and the warning (after the older-check warning when both are set), shown
// as a warning; without one, the usual "Check saved for ..." sentence.
async function savedMessage(page, saved) {
  const status = page.locator("fieldset.stock-check p[role=status]");
  const warnings = [saved.olderWarning, saved.branchWarning].filter(Boolean);
  if (warnings.length) {
    const text = "Check saved. " + warnings.join(" ");
    await status.filter({ hasText: text }).waitFor();
    assert.equal((await status.textContent()).trim(), text);
    assert.match(await status.getAttribute("class"), /\bwarn\b/);
  } else {
    await status.filter({ hasText: /^Check saved for / }).waitFor();
    assert.doesNotMatch((await status.getAttribute("class")) ?? "", /\bwarn\b/);
  }
}

test(
  "a Camden check naming the Preston shop leaves the price unconfirmed in Research; a Preston check naming it confirms it, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    // The Preston shop named by its OpenStreetMap id, then by retailer and
    // postcode.
    const named = { 390: "node/111", 1280: "Home Bargains PR1 2AR" };
    for (const width of [390, 1280]) {
      const app = await startApp();
      try {
        await setUp(app);
        await atWidths(
          browser,
          app.url + "/#Research",
          async (page) => {
            const branch = named[width];
            await page.locator(".offer-list button", { hasText: TITLE }).first().click();
            await page.getByLabel("Locality for the stock check").fill("Camden");
            const line = page.locator("p.branch-price");
            await line.filter({ hasText: "no branch check in Camden from the last 2 days shows it applies there" }).waitFor();

            // A Camden check that finds stock and names the Preston shop.
            const saved = await recordCheck(page, branch);
            assert.equal(saved.locality, "Camden");
            assert.equal(saved.branch, branch);
            assert.equal(
              saved.branchWarning,
              `Open Prices places the branch named (${branch}) at PR1 2AR, Preston, which does not match the locality Camden, so prices seen there do not count for this check. Check the branch and the locality. ${RECORD_PRICE}`,
            );
            await savedMessage(page, saved);
            await line.filter({ hasText: notConfirmedLine("Home Bargains, PR1 2AR, Preston", "Open Prices places it outside Camden") }).waitFor();
            assert.equal(await line.getAttribute("data-confirmed"), "no");
            assert.match(await line.getAttribute("class"), /\bwarn\b/);
            // The check is listed with the branch as typed.
            const rows = page.locator("fieldset.stock-check tbody tr");
            await rows.filter({ hasText: branch }).filter({ hasText: "Camden" }).waitFor();

            // The same shop named on a Preston check is the same shop.
            await page.getByLabel("Locality for the stock check").fill("Preston");
            const preston = await recordCheck(page, branch);
            assert.equal(preston.branchWarning, null);
            await savedMessage(page, preston);
            await line
              .filter({
                hasText: "Price confirmed at the branch: The £12.00 seen at Home Bargains, PR1 2AR, Preston, the shop the branch check names.",
              })
              .waitFor();
            assert.equal(await line.getAttribute("data-confirmed"), "yes");

            // Back in Camden the price is still not confirmed.
            await page.getByLabel("Locality for the stock check").fill("Camden");
            await line.filter({ hasText: notConfirmedLine("Home Bargains, PR1 2AR, Preston", "Open Prices places it outside Camden") }).waitFor();
            assert.equal(await line.getAttribute("data-confirmed"), "no");
          },
          [width],
        );
      } finally {
        app.stop();
      }
    }
  },
);

test(
  "a Camden check naming the Croydon shop leaves the price unconfirmed in Research; a Croydon check naming it confirms it, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    // The Croydon shop named by its OpenStreetMap id, then by retailer and
    // postcode.
    const named = { 390: "node/333", 1280: "Home Bargains CR0 1AB" };
    for (const width of [390, 1280]) {
      const app = await startApp();
      try {
        await setUp(app, CROYDON_OP);
        await atWidths(
          browser,
          app.url + "/#Research",
          async (page) => {
            const branch = named[width];
            await page.locator(".offer-list button", { hasText: TITLE }).first().click();
            await page.getByLabel("Locality for the stock check").fill("Camden");
            const line = page.locator("p.branch-price");
            await line.filter({ hasText: "no branch check in Camden from the last 2 days shows it applies there" }).waitFor();

            // A Camden check naming the Croydon shop, which Open Prices
            // records with the city London.
            const saved = await recordCheck(page, branch);
            assert.equal(saved.locality, "Camden");
            assert.equal(
              saved.branchWarning,
              `Open Prices places the branch named (${branch}) at CR0 1AB, London, which does not match the locality Camden (the CR0 postcode district is in Croydon, Merton or Sutton), so prices seen there do not count for this check. Check the branch and the locality. ${RECORD_PRICE}`,
            );
            await savedMessage(page, saved);
            await line
              .filter({
                hasText: notConfirmedLine(
                  "Home Bargains, CR0 1AB, London",
                  "Open Prices places it outside Camden (the CR0 postcode district is in Croydon, Merton or Sutton)",
                ),
              })
              .waitFor();
            assert.equal(await line.getAttribute("data-confirmed"), "no");
            assert.match(await line.getAttribute("class"), /\bwarn\b/);

            // In Croydon it is the branch the check names.
            await page.getByLabel("Locality for the stock check").fill("Croydon");
            const croydon = await recordCheck(page, branch);
            assert.equal(croydon.branchWarning, null);
            await savedMessage(page, croydon);
            await line
              .filter({
                hasText: "Price confirmed at the branch: The £12.00 seen at Home Bargains, CR0 1AB, London, the shop the branch check names.",
              })
              .waitFor();
            assert.equal(await line.getAttribute("data-confirmed"), "yes");
          },
          [width],
        );
      } finally {
        app.stop();
      }
    }
  },
);

test(
  "a 'Romford, London' or 'Stratford, London' check naming the Croydon shop leaves the price unconfirmed in Research; an Ealing check naming the Acton Morrisons confirms it, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    const localities = { 390: "Romford, London", 1280: "Stratford, London" };
    const warnings = {
      390: `Open Prices places the branch named (node/333) at CR0 1AB, London, which does not match the locality Romford, London (the CR0 postcode district is in Croydon), so prices seen there do not count for this check. Check the branch and the locality. ${RECORD_PRICE}`,
      1280: `Open Prices places the branch named (node/333) at CR0 1AB, London, but Stratford, London is not a London borough, so that does not show the branch is there, and prices seen there do not count for this check. Enter the London borough, or London, as the locality. ${RECORD_PRICE}`,
    };
    const why = {
      390: "Open Prices places it outside Romford, London (the CR0 postcode district is in Croydon)",
      1280: "Stratford, London is not a London borough, so Open Prices does not show the shop is there",
    };
    for (const width of [390, 1280]) {
      const app = await startApp();
      try {
        await setUp(app, [CROYDON_OP, ACTON_OP]);
        await atWidths(
          browser,
          app.url + "/#Research",
          async (page) => {
            const locality = localities[width];
            const line = page.locator("p.branch-price");
            await page.locator(".offer-list button", { hasText: TITLE }).filter({ hasText: "Home Bargains" }).first().click();
            await page.getByLabel("Locality for the stock check").fill(locality);
            await line.filter({ hasText: `no branch check in ${locality} from the last 2 days shows it applies there` }).waitFor();
            const saved = await recordCheck(page, "node/333");
            assert.equal(saved.locality, locality);
            assert.equal(saved.branchWarning, warnings[width]);
            await savedMessage(page, saved);
            await line.filter({ hasText: notConfirmedLine("Home Bargains, CR0 1AB, London", why[width]) }).waitFor();
            assert.equal(await line.getAttribute("data-confirmed"), "no");
            assert.match(await line.getAttribute("class"), /\bwarn\b/);

            // The Acton Morrisons, which Open Prices records under the
            // district name Acton, is in Ealing by its postcode.
            await page.locator(".offer-list button", { hasText: TITLE }).filter({ hasText: "Morrisons" }).first().click();
            await page.getByLabel("Locality for the stock check").fill("Ealing");
            await line.filter({ hasText: "no branch check in Ealing from the last 2 days shows it applies there" }).waitFor();
            const ealing = await recordCheck(page, "way/26295319");
            assert.equal(ealing.retailer, "Morrisons");
            assert.equal(ealing.branchWarning, null);
            await savedMessage(page, ealing);
            await line
              .filter({
                hasText: "Price confirmed at the branch: The £12.00 seen at Morrisons, W3 9LA, Acton, the shop the branch check names.",
              })
              .waitFor();
            assert.equal(await line.getAttribute("data-confirmed"), "yes");
          },
          [width],
        );
      } finally {
        app.stop();
      }
    }
  },
);

test(
  "the form shows the branch warning after a check is saved, after the older-check warning when both are set: a Birmingham check naming the real Stirchley shop stays unconfirmed with a true reason, and a 'Romford London' check takes a Romford shop, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    // The Stirchley shop named by its OpenStreetMap id, then by retailer
    // and postcode.
    const named = { 390: "node/501", 1280: "Home Bargains B29 6HH" };
    for (const width of [390, 1280]) {
      const app = await startApp();
      try {
        await setUp(app, [STIRCHLEY_OP, ROMFORD_OP]);
        await atWidths(
          browser,
          app.url + "/#Research",
          async (page) => {
            const branch = named[width];
            const form = page.locator("fieldset.stock-check");
            const line = page.locator("p.branch-price");
            await page.locator(".offer-list button", { hasText: TITLE }).filter({ hasText: "Stirchley" }).first().click();
            await page.getByLabel("Locality for the stock check").fill("Birmingham");
            await line.filter({ hasText: "no branch check in Birmingham from the last 2 days shows it applies there" }).waitFor();

            // A Birmingham check naming the Stirchley shop: Open Prices
            // records it under Stirchley, which does not show it is in
            // Birmingham (nor that it is elsewhere).
            const warning = `Open Prices records the branch named (${branch}) under Stirchley, which does not show it is in Birmingham, so prices seen there do not count for this check. ${RECORD_PRICE}`;
            const saved = await recordCheck(page, branch);
            assert.equal(saved.branchWarning, warning);
            assert.equal(saved.olderWarning, null);
            await savedMessage(page, saved);
            assert.equal(
              (await form.locator("p[role=status]").textContent()).trim(),
              "Check saved. " + warning,
            );
            await line
              .filter({
                hasText: notConfirmedLine(
                  "Home Bargains, B29 6HH, Stirchley",
                  "Open Prices records it under Stirchley, which does not show it is in Birmingham",
                ),
              })
              .waitFor();
            assert.equal(await line.getAttribute("data-confirmed"), "no");
            assert.match(await line.getAttribute("class"), /\bwarn\b/);

            // An earlier check at the same shop: both warnings, the
            // older-check one first.
            await form.locator("tbody tr").filter({ hasText: "Birmingham" }).first().waitFor();
            const earlier = await page.evaluate(() => {
              const d = new Date(Date.now() - 3 * 3600000);
              const p = (n) => String(n).padStart(2, "0");
              return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
            });
            await form.getByLabel("Checked at (your local time)").fill(earlier);
            const older = await recordCheck(page, branch, "Record this older check anyway");
            assert.match(older.olderWarning, /^This check is dated .+, earlier than the branch check at .+, so the newer one still decides what bounties show for this shelf\./);
            assert.equal(older.branchWarning, warning);
            await savedMessage(page, older);
            assert.equal(
              (await form.locator("p[role=status]").textContent()).trim(),
              "Check saved. " + older.olderWarning + " " + warning,
            );

            // "Romford London" with no comma is Romford: the Romford shop is
            // the branch, with no warning.
            await page.locator(".offer-list button", { hasText: TITLE }).filter({ hasText: "Romford" }).first().click();
            await page.getByLabel("Locality for the stock check").fill("Romford London");
            await line.filter({ hasText: "no branch check in Romford London from the last 2 days shows it applies there" }).waitFor();
            const romford = await recordCheck(page, width === 390 ? "node/503" : "Home Bargains RM1 3ER");
            assert.equal(romford.locality, "Romford London");
            assert.equal(romford.branchWarning, null);
            await savedMessage(page, romford);
            await line
              .filter({
                hasText: "Price confirmed at the branch: The £12.00 seen at Home Bargains, RM1 3ER, Romford, the shop the branch check names.",
              })
              .waitFor();
            assert.equal(await line.getAttribute("data-confirmed"), "yes");
          },
          [width],
        );
      } finally {
        app.stop();
      }
    }
  },
);
