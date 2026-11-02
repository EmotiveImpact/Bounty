// Round 5b in the browser. A member who bought units through a bounty and
// lists them on eBay has them counted twice against the demand for the item
// (as competing listings and as units bought) until their profile gives the
// seller name their listings show and the operator confirms it: the card
// says so to them, they add it in the member form, the operator confirms it
// on the card, and the replacement bounty leaves room for one more unit,
// which another member then claims. And the holder of a claim made before
// the cash for the trip was asked is asked for it under the claim, can
// correct a mistyped figure there, and "Save cash and check my figures"
// reopens the trip; one with no profile either is never stuck, whichever
// they give first. Both at 390 and 1280 px.
//
// The evidence (offers, 26 recent exact sales, asking-price lookups, the
// eBay listings, display permission) is written straight into the throwaway
// database, as the import and lookup commands would; everything else goes
// through the real routes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { atWidths, loadChromium, startApp } from "./harness.mjs";

const chromium = loadChromium();
const DAY = 86400000;
const SPEAKER = "5012345678115";
const LAMP = "5012345678122";
let app;
let browser;

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};
const post = (path, body) => app.api(path, { method: "POST", body });
// SHOTS=<folder> keeps a picture of each step's card (or page part).
const shot = async (target, name) => {
  if (process.env.SHOTS) await target.screenshot({ path: join(process.env.SHOTS, name) });
};

/** Offer, sales, an empty lookup and display permission for one item. */
async function seed(barcode, sourceId, title) {
  const { openDb } = await import("../server/db.mjs");
  const { setPermission, storeLookup, upsertResearch } = await import("../server/evidence.mjs");
  const now = new Date().toISOString();
  const ago = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
  const db = openDb(join(app.dataDir, "desk.sqlite"));
  const base = { title, barcode, size: "one size", pack: "1", model: "M-" + sourceId, condition: "new" };
  upsertResearch(db, "awin", [{ ...base, source_id: sourceId, kind: "Retail offer", price: 1200, observed: now, retailer: "Argos", licence: "Licensed feed" }], { now });
  const sales = Array.from({ length: 26 }, (_, i) => ({ source_id: `${sourceId}-s${i}`, seller: "seller" + i, observed: ago(1 + Math.floor((i * 80) / 26)), listed: ago(5 + i) }));
  upsertResearch(db, "sales", sales.map((s) => ({ ...base, ...s, kind: "Reported completed sale", price: 2800, retailer: "eBay UK", licence: "Self-reported" })), { now });
  storeLookup(db, "ebay", barcode, [], { now });
  setPermission(db, { provider: "awin", display: true }, { now });
  db.close();
  const check = (unitsSeen) =>
    post("/api/research/checks", { barcode, retailer: "Argos", locality: "Camden", method: "in_store", inStock: true, unitsSeen, pricePence: 1200 });
  const bounty = (name) =>
    post("/api/bounties", {
      title: name,
      locality: "Camden",
      retailer: "Argos",
      salesPerWeek: 10,
      sellWindowWeeks: 2,
      expiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      sponsored: false,
      estimate: {
        offer: { provider: "awin", sourceId },
        sales: sales.map((s) => ({ provider: "sales", sourceId: s.source_id })),
        units: 3,
        weightKg: 0.4,
        costs: { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 0, journeyMinutes: 15 },
        hourlyFloor: 800,
        locality: "Camden",
      },
    });
  return { check, bounty, base };
}

const paidUntil = () => new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10);
const member = async (name) =>
  ok(
    await post("/api/members", {
      name,
      alertsOptIn: true,
      alertLocalities: ["Camden"],
      paidTier: "diamond",
      paidUntil: paidUntil(),
      transport: "Car",
      carryKg: 25,
      storageUnits: 50,
    }),
    201,
  ).member;
const TRIP = { journeyCost: 0, journeyMinutes: 15, cashAvailable: 100000 };

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
  "a member's seller name stops their own eBay listings counting twice, and the freed unit can be claimed, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    const item = await seed(SPEAKER, "o1", "Mini Bluetooth speaker black");
    ok(await item.check(10), 201);
    const first = ok(await item.bounty("Mini Bluetooth speaker"), 201);
    assert.match(first.message, /with a cap of 4 units/);
    const ann = await member("Ann");
    await member("Bob");
    const claim = ok(await post(`/api/bounties/${first.bounty.id}/claims`, { memberId: ann.id, units: 3, ...TRIP }), 201);
    ok(await post(`/api/claims/${claim.claim.id}/complete`, { memberId: ann.id }));
    ok(await post(`/api/bounties/${first.bounty.id}/withdraw`, {}));
    // Ann lists her 3 units on eBay as ann_resells; a lookup sees them.
    {
      const { openDb } = await import("../server/db.mjs");
      const { storeLookup, upsertResearch } = await import("../server/evidence.mjs");
      const now = new Date().toISOString();
      const db = openDb(join(app.dataDir, "desk.sqlite"));
      const ids = ["ann-1", "ann-2", "ann-3"];
      upsertResearch(
        db,
        "ebay",
        // Listed after she bought them (eBay gives each listing's creation time).
        ids.map((id) => ({ ...item.base, source_id: id, seller: "ann_resells", kind: "Active asking price", price: 2900, observed: now, listed: now, retailer: "eBay UK", licence: "Self-reported" })),
        { now },
      );
      storeLookup(db, "ebay", SPEAKER, ids, { now });
      db.close();
    }
    ok(await item.check(7), 201);
    const second = ok(await item.bounty("Mini Bluetooth speaker"), 201);
    assert.match(second.message, /the distribution cap is 0/);

    await atWidths(browser, app.url + "/#Bounties", async (page, width) => {
      const card = page.locator("article.bounty:not(.closed)", { hasText: "Mini Bluetooth speaker" });
      const cap = card.locator("dt", { hasText: "Distribution cap" }).locator("xpath=following-sibling::dd[1]");
      if (width === 390) {
        // Ann, with no seller name yet: the card tells her what it costs and how to stop it.
        await page.getByLabel("Acting as").selectOption({ label: "Ann" });
        await card.locator(".seller-note").waitFor();
        await card
          .getByText(
            "You have 3 units of this item bought through bounties and not yet recorded as sold or returned, and your profile has no marketplace seller name. If you list them for sale, they count twice against the demand: as competing listings and as units bought. Add your seller name (for example your eBay user name) to your member profile and ask the operator to confirm it to stop that.",
          )
          .waitFor();
        await card.getByText(/^1 member holding units bought through bounties for this item has given no marketplace seller name/).waitFor();
        assert.equal(await cap.innerText(), "0 units");
        await page.locator("dd[data-seller=none]").waitFor();
        await shot(card, "seller-390-before.png");
        await page.locator("summary", { hasText: "Edit profile, alerts and paid tier" }).click();
        await page.getByLabel("Your marketplace seller name, optional (for example your eBay user name)").fill("ann_resells");
        await page.getByRole("button", { name: "Save member" }).click();
        await page.getByText("Saved.").waitFor();
        await page.locator("dd[data-seller=given]", { hasText: "ann_resells. Waiting for the operator to confirm it is yours" }).waitFor();
        await shot(page.locator(".member-area"), "seller-390-profile.png");
        // Until the operator confirms it, her listings still count in full.
        await card.locator(".seller-note", { hasText: 'the operator has not yet confirmed your seller name "ann_resells"' }).waitFor();
        assert.equal(await cap.innerText(), "0 units");
        // The operator checks it against her eBay profile and confirms it on the card.
        await page.getByLabel("Acting as").selectOption("operator");
        const names = card.locator(".seller-names");
        await names.getByText(/^Ann: "ann_resells", 3 units not yet recorded as sold or returned\. Not confirmed yet/).waitFor();
        await shot(card, "seller-390-operator.png");
        await names.getByRole("button", { name: "Confirm ann_resells as Ann's seller name" }).click();
        await card.getByText(/^Confirmed: "ann_resells" is Ann's seller name\./).waitFor();
        await names.locator("li[data-seller-name=confirmed]").waitFor();
        await names.getByRole("button", { name: "Withdraw the confirmation of ann_resells as Ann's seller name" }).waitFor();
        await card
          .getByText(
            "3 of the 3 competing listings are members' own units bought through bounties for this item (matched by the seller name on their profile, confirmed by the operator), so they are counted once, not again as competing listings",
          )
          .waitFor();
        await page.getByLabel("Acting as").selectOption({ label: "Ann" });
        await page.locator("dd[data-seller=confirmed]", { hasText: "ann_resells, confirmed by the operator on" }).waitFor();
        await page.waitForFunction(() => {
          const cards = [...document.querySelectorAll("article.bounty:not(.closed)")].filter((a) => a.textContent.includes("Mini Bluetooth speaker"));
          const dt = cards[0] && [...cards[0].querySelectorAll("dt")].find((d) => d.textContent === "Distribution cap");
          return dt?.nextElementSibling?.textContent === "1 unit";
        });
        assert.equal(await card.locator(".seller-note").count(), 0, "the note goes once the name is given");
        await shot(card, "seller-390-after.png");
      } else {
        // Bob claims the unit the evidence leaves.
        await page.getByLabel("Acting as").selectOption({ label: "Bob" });
        await card.getByText("3 of the 3 competing listings are members' own units", { exact: false }).waitFor();
        assert.equal(await cap.innerText(), "1 unit");
        const form = card.locator("form.claim-form");
        await form.getByLabel("Your return journey cost (£)").fill("0");
        await form.getByLabel("Your journey time there and back (minutes)").fill("15");
        await form.getByLabel("Cash you can spend on this trip (£)").fill("1000");
        await form.getByRole("button", { name: "Claim" }).click();
        await card.getByText(/^Claim recorded for 1 unit until /).waitFor();
        await shot(card, "seller-1280-claimed.png");
      }
    });
  },
);

test(
  "a claim made before the cash was asked asks for it under the claim, a mistyped figure can be corrected there, and the trip reopens, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    const item = await seed(LAMP, "o2", "LED desk lamp white");
    ok(await item.check(10), 201);
    const bounty = ok(await item.bounty("LED desk lamp"), 201).bounty;
    const cat = await member("Cat");
    const made = ok(await post(`/api/bounties/${bounty.id}/claims`, { memberId: cat.id, units: 1, ...TRIP }), 201);
    // As a claim made before round 5 stored it: no cash in its terms, then
    // the next re-check.
    const asOldClaim = async () => {
      const { openDb } = await import("../server/db.mjs");
      const db = openDb(join(app.dataDir, "desk.sqlite"));
      db.prepare("UPDATE claims SET terms = json_remove(terms, '$.cashAvailable') WHERE id = ?").run(made.claim.id);
      db.close();
      ok(await post(`/api/bounties/${bounty.id}/recheck`, {}));
    };

    await atWidths(browser, app.url + "/#Bounties", async (page, width) => {
      await asOldClaim();
      await page.reload();
      await page.getByLabel("Acting as").selectOption({ label: "Cat" });
      const card = page.locator("article.bounty:not(.closed)", { hasText: "LED desk lamp" });
      await card.locator(".badge", { hasText: "Confirm the cash you can spend" }).waitFor();
      await card
        .locator("p.stop")
        .first()
        .getByText(/^Don't make the trip yet: confirm the cash you can spend on this trip\. Your claim stores no cash figure \(it was made before the cash was asked for\)/)
        .waitFor();
      assert.equal(await card.getByText(/no longer pass|now fail/).count(), 0, "never told the figures failed");
      const form = card.locator("form.claim-cash");
      await form.waitFor();
      await shot(card, `cash-${width}-asked.png`);
      // A typo: £1 is too little, and is said so.
      await form.getByLabel("Cash you can spend on this trip (£)").fill("1");
      await form.getByRole("button", { name: "Save cash and check my figures" }).click();
      await card.getByText(/^Saved: £1\.00 you can spend on this trip\. Your figures for 1 unit were checked again on the latest evidence and now fail: The trip needs £/).waitFor();
      await card.locator(".badge", { hasText: "Your figures no longer pass" }).waitFor();
      await card.getByText(/^The cash you can spend on this trip is the £1\.00 stored with your claim/).waitFor();
      await shot(card, `cash-${width}-typo.png`);
      // The field stays under the claim with the stored figure, so it can be corrected.
      assert.equal(await form.getByLabel("Cash you can spend on this trip (£)").inputValue(), "1");
      await form.getByLabel("Cash you can spend on this trip (£)").fill("1000");
      await form.getByRole("button", { name: "Save cash and check my figures" }).click();
      await card
        .getByText("Saved: £1000.00 you can spend on this trip. Your figures for 1 unit were checked again on the latest evidence and every check passes.")
        .waitFor();
      await card.locator(".badge.ok", { hasText: "Open for trips" }).waitFor();
      assert.equal(await form.getByLabel("Cash you can spend on this trip (£)").inputValue(), "1000", "kept under the claim to change");
      await shot(card, `cash-${width}-checked.png`);
    });
  },
);

test(
  "a claim made before round 5 with no profile and no cash is never stuck: cash first, then the profile, reopens the trip, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    const item = await seed("5012345678139", "o3", "Steel water bottle");
    ok(await item.check(10), 201);
    const bounty = ok(await item.bounty("Steel water bottle"), 201).bounty;
    const fay = await member("Fay");
    const made = ok(await post(`/api/bounties/${bounty.id}/claims`, { memberId: fay.id, units: 1, ...TRIP }), 201);
    // As a claim and member from before round 5 were stored: no cash with
    // the claim and no transport, carry limit or room on the profile.
    const asOld = async () => {
      const { openDb } = await import("../server/db.mjs");
      const db = openDb(join(app.dataDir, "desk.sqlite"));
      db.prepare("UPDATE claims SET terms = json_remove(terms, '$.cashAvailable') WHERE id = ?").run(made.claim.id);
      db.prepare("UPDATE members SET transport = NULL, carry_kg = NULL, storage_units = NULL WHERE id = ?").run(fay.id);
      db.close();
      ok(await post(`/api/bounties/${bounty.id}/recheck`, {}));
    };

    await atWidths(browser, app.url + "/#Bounties", async (page, width) => {
      await asOld();
      await page.reload();
      await page.getByLabel("Acting as").selectOption({ label: "Fay" });
      const card = page.locator("article.bounty:not(.closed)", { hasText: "Steel water bottle" });
      await card.locator(".badge", { hasText: "Confirm your transport, carrying limit, storage and cash" }).waitFor();
      const form = card.locator("form.claim-cash");
      await form.getByLabel("Cash you can spend on this trip (£)").fill("1000");
      await form.getByRole("button", { name: "Save cash and check my figures" }).click();
      await card.getByText(/^Saved: £1000\.00 you can spend on this trip\. Your figures were checked again\. Don't make the trip yet: confirm your transport, carrying limit and storage at home in your member profile\./).waitFor();
      // The cash is stored, so the badge no longer asks for it, and the
      // controls stay under the claim.
      await card.locator(".badge", { hasText: /^Confirm your transport, carrying limit and storage$/ }).waitFor();
      await form.getByText("Your figures also wait on your transport, carrying limit and storage in your member profile", { exact: false }).waitFor();
      await form.getByRole("button", { name: "Save cash and check my figures" }).waitFor();
      await shot(card, `stuck-${width}-cash-first.png`);
      // Saving the profile checks the claim again at once.
      await page.locator("summary", { hasText: "Edit profile, alerts and paid tier" }).click();
      const profile = page.locator("form.member-form");
      await profile.getByLabel("How you travel").selectOption("Car");
      await profile.getByLabel("How much you can carry (kg)").fill("25");
      await profile.getByLabel("Room at home for units, in all").fill("50");
      await profile.getByRole("button", { name: "Save member" }).click();
      await page.getByText("Saved. Your live claim was checked again against your profile now.").waitFor();
      await card.locator(".badge.ok", { hasText: "Open for trips" }).waitFor();
      await shot(card, `stuck-${width}-reopened.png`);
    });
  },
);

test(
  "a refused seller name is shown next to its field in plain words, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    const taken = await member("Gus");
    ok(await app.api(`/api/members/${taken.id}`, { method: "PATCH", body: { sellerName: "gus_resells" } }));
    await member("Hana");
    // The refusals are 400 and 409 replies, which the browser logs as failed
    // loads; those two lines are expected here, anything else fails.
    const expected = /^Failed to load resource: the server responded with a status of (400 \(Bad Request\)|409 \(Conflict\))$/;
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("console", (m) => m.type() === "error" && !expected.test(m.text()) && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(app.url + "/#Bounties");
      await page.getByLabel("Acting as").selectOption({ label: "Hana" });
      await page.locator("summary", { hasText: "Edit profile, alerts and paid tier" }).click();
      const field = page.getByLabel("Your marketplace seller name, optional (for example your eBay user name)");
      for (const [typed, said] of [
        ["listing:123", "Your marketplace seller name must be the name your listings show, such as your eBay user name, in 64 characters or fewer."],
        ["ＧＵＳ_resells", "Another member already gave this seller name. Each member's listings are matched by their own seller name, so check the spelling."],
      ]) {
        await field.fill(typed);
        await field.press("Enter");
        await page.locator("label", { has: field }).locator(".field-error").getByText(said, { exact: true }).waitFor();
        assert.equal(await field.getAttribute("aria-invalid"), "true");
        await page.getByText("Not saved: check your marketplace seller name.").waitFor();
        await shot(page.locator("label", { has: field }), `seller-${width}-error-${typed.startsWith("listing") ? "bad" : "taken"}.png`);
      }
      await field.fill("hana_sells");
      await page.getByRole("button", { name: "Save member" }).click();
      await page.getByText("Saved.").waitFor();
      assert.equal(await page.locator(".field-error").count(), 0);
      ok(await app.api(`/api/members/${(await app.api("/api/members")).body.members.find((m) => m.name === "Hana").id}`, { method: "PATCH", body: { sellerName: "" } }));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.close();
      assert.equal(overflow, 0, `no horizontal overflow at ${width}px`);
      assert.deepEqual(errors, [], `no other console errors at ${width}px`);
    }
  },
);
