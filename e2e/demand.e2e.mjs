// Round 5, finding 2 in the browser: a bounty that replaces a withdrawn one
// shows the units bought through the earlier bounty that still count against
// the demand for the item, and how they stop counting; the operator records
// a reconciliation (at 390 px) and the member who bought them records a sale
// (at 1280 px), and the card follows each release.
//
// The evidence (an offer, 26 recent exact sales, an asking-price lookup that
// found none, display permission) is written straight into the throwaway
// database, as the import commands would; everything else goes through the
// real routes: branch checks, members, bounties, claims and the withdrawal.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { atWidths, loadChromium, startApp } from "./harness.mjs";

const chromium = loadChromium();
const BARCODE = "5012345678115";
const DAY = 86400000;
let app;
let browser;

async function setUp() {
  const { openDb } = await import("../server/db.mjs");
  const { setPermission, storeLookup, upsertResearch } = await import("../server/evidence.mjs");
  const now = new Date().toISOString();
  const ago = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
  const db = openDb(join(app.dataDir, "desk.sqlite"));
  const base = { title: "Mini Bluetooth speaker black", barcode: BARCODE, size: "one size", pack: "1", model: "BTS-20", condition: "new" };
  upsertResearch(db, "awin", [{ ...base, source_id: "o1", kind: "Retail offer", price: 1200, observed: now, retailer: "Argos", licence: "Licensed feed" }], { now });
  const sales = Array.from({ length: 26 }, (_, i) => ({ source_id: "s" + i, seller: "seller" + i, observed: ago(1 + Math.floor((i * 80) / 26)), listed: ago(5 + i) }));
  upsertResearch(db, "sales", sales.map((s) => ({ ...base, ...s, kind: "Reported completed sale", price: 2800, retailer: "eBay UK", licence: "Self-reported" })), { now });
  storeLookup(db, "ebay", BARCODE, [], { now });
  setPermission(db, { provider: "awin", display: true }, { now });
  db.close();

  const ok = (res, status = 200) => {
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const post = (path, body) => app.api(path, { method: "POST", body });
  // The shelf price is recorded on the branch check, so the price applies there.
  const check = (unitsSeen) =>
    post("/api/research/checks", { barcode: BARCODE, retailer: "Argos", locality: "Camden", method: "in_store", inStock: true, unitsSeen, pricePence: 1200 });
  const bounty = () =>
    post("/api/bounties", {
      title: "Mini Bluetooth speaker",
      locality: "Camden",
      retailer: "Argos",
      salesPerWeek: 10,
      sellWindowWeeks: 2,
      expiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      sponsored: false,
      estimate: {
        offer: { provider: "awin", sourceId: "o1" },
        sales: sales.map((s) => ({ provider: "sales", sourceId: s.source_id })),
        units: 3,
        weightKg: 0.4,
        costs: { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 0, journeyMinutes: 15 },
        hourlyFloor: 800,
        locality: "Camden",
      },
    });
  const paidUntil = new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10);
  const member = async (name) =>
    ok(
      await post("/api/members", {
        name,
        alertsOptIn: true,
        alertLocalities: ["Camden"],
        paidTier: "diamond",
        paidUntil,
        // Round 5 (suitability): a member can claim only once their
        // transport, carrying limit and storage are known.
        transport: "Car",
        carryKg: 25,
        storageUnits: 50,
      }),
      201,
    ).member;

  ok(await check(10), 201);
  const first = ok(await bounty(), 201);
  assert.match(first.message, /with a cap of 4 units/);
  const ann = await member("Ann");
  await member("Bob");
  const claim = ok(await post(`/api/bounties/${first.bounty.id}/claims`, { memberId: ann.id, units: 3, journeyCost: 0, journeyMinutes: 15, cashAvailable: 100000 }), 201);
  ok(await post(`/api/claims/${claim.claim.id}/complete`, { memberId: ann.id }));
  ok(await check(7), 201);
  ok(await post(`/api/bounties/${first.bounty.id}/withdraw`, {}));
  const second = ok(await bounty(), 201);
  assert.match(second.message, /with a cap of 1 unit\./);
  return second.bounty.id;
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
  "the replacement bounty's card shows the units an earlier bounty still has against the demand, and a release frees them, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    await setUp();
    await atWidths(browser, app.url + "/#Bounties", async (page, width) => {
      const card = page.locator("article.bounty:not(.closed)");
      const earlier = card.locator("section.earlier", { hasText: "Units from earlier bounties for this item" });
      if (width === 390) {
        // The operator view (the default): the note, the cap without them,
        // how they stop counting, and the reconciliation form.
        await earlier.waitFor();
        await assert.doesNotReject(
          earlier
            .getByText(
              "3 units bought through an earlier bounty for this item have not been recorded as sold or returned, so they still count against the demand for it.",
            )
            .waitFor(),
        );
        await earlier.getByText("Without them the distribution cap would be 4 units.").waitFor();
        await earlier.getByText(/records them as sold or returned, or the operator records a reconciliation with a reason/).waitFor();
        await earlier.getByText(/^Ann bought 3 units through bounty 1 on .*: 3 units not yet recorded as sold or returned\.$/).waitFor();
        assert.equal(await card.locator("dd").filter({ hasText: /^1 unit$/ }).count() > 0, true, "the cap is 1 unit");
        await earlier.getByLabel("Units to release").fill("1");
        await earlier.getByLabel("Reason (kept with the time)").fill("Ann sent the eBay order number for 1 sale");
        await earlier.getByRole("button", { name: "Record reconciliation" }).click();
        await card.getByText(/^Reconciliation recorded: 1 unit released, with the reason given\./).waitFor();
        await earlier
          .getByText(
            "2 units bought through an earlier bounty for this item have not been recorded as sold or returned, so they still count against the demand for it.",
          )
          .waitFor();
        await earlier.getByText(/: 2 units not yet recorded as sold or returned\. So far 1 reconciled by the operator\.$/).waitFor();
      } else {
        // Ann, who bought them, records a sale on the replacement's card.
        await page.getByLabel("Acting as").selectOption({ label: "Ann" });
        await earlier.waitFor();
        await earlier.getByText(/^You bought 3 units through bounty 1 on .*: 2 units not yet recorded as sold or returned\. So far 1 reconciled by the operator\.$/).waitFor();
        assert.equal(await earlier.getByRole("button", { name: "Record reconciliation" }).count(), 0, "members cannot reconcile");
        await earlier.getByLabel("Units sold").fill("1");
        await earlier.getByRole("button", { name: "Record sold or returned" }).click();
        await card.getByText(/^Recorded: 1 unit sold\. 1 unit bought through this claim still counts against the demand for the item/).waitFor();
        await earlier
          .getByText(
            "1 unit bought through an earlier bounty for this item has not been recorded as sold or returned, so it still counts against the demand for it.",
          )
          .waitFor();
        // The boxes are emptied once recorded, and the form never offers more
        // than is outstanding (the server refuses it too:
        // server/round5-demand.test.mjs).
        const sold = earlier.getByLabel("Units sold");
        assert.equal(await sold.inputValue(), "");
        await sold.fill("2");
        assert.equal(await sold.evaluate((el) => el.validity.rangeOverflow), true);
      }
    });
  },
);
