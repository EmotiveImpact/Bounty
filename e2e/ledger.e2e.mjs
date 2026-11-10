// Ledger workflows recorded through the interface, at phone and desktop
// widths (round five, findings 3 and 5):
//   - a trip bought and worked on in October and paid out in November shows
//     £38.40 an hour (the whole trip, £80 over 125 minutes) in November and
//     no hourly figure in October (the month figures are read from the API);
//   - a unit refunded and sent back by the buyer can be sold again with no
//     discrepancy and the trade reaches verified with its proofs; a refund
//     where the buyer kept the item leaves nothing to sell, so a second sale
//     is flagged.
// Round five, fix b (the verifier's R3, R5 and L6):
//   - the refund form asks for the date the item came back (only when it
//     came back); given, a resale before the refund was paid is not flagged;
//   - a sale refunded before it was paid out is not pending, and the trip
//     says so;
//   - a closed trip that sold stock with no purchase receipt is left out of
//     earnings per hour, on the trip and in the month, in plain words.
// Second pass (the verifier's report on the first):
//   - the refund form's reference asks for the order number of the sale;
//   - a closed no-receipt trip is never told to record its receipt (a closed
//     trip takes no entries); an open one is;
//   - a no-receipt trip that lost money is counted where it lowers earnings
//     per hour, in the month and in the measures, and says so.
// Third pass (the verifier's report on the second):
//   - an open trip that sold more than its receipt covers is asked for the
//     purchase of the extra units (it has a receipt) or a check of a kept
//     refund, and for its work time when it has none; it is never told that
//     the monthly figure counts it while it has no work time;
//   - the month names such a trip, once completed, the same way;
//   - an open no-receipt trip with work time is still asked for its receipt;
//   - the refund form's reference placeholder fits the field.
// Fix 5 (the last verifier's report), in a test of its own below:
//   - a resale before its refund was paid, on an open trip, is told to remove
//     the refund and record it again with the date the item came back (no
//     entry can be edited), and doing that clears it; on a closed trip it is
//     told the trip is closed and its entries cannot change;
//   - the date the item came back cannot be before 2000-01-01 in the form,
//     and the server's message for it names the field in words.
// Each width gets its own app and data directory, so both record the same
// trips from scratch.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { atWidths, loadChromium, startApp } from "./harness.mjs";

const chromium = loadChromium();
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

/** Polls a locator's text until it matches, failing with the text last seen. */
async function waitText(locator, pattern, what, ms = 10000) {
  const until = Date.now() + ms;
  let seen = "";
  for (;;) {
    seen = (await locator.count()) ? await locator.first().innerText() : "(not on the page)";
    if (pattern.test(seen)) return seen;
    if (Date.now() > until) throw new Error(`${what}: expected ${pattern}, saw ${JSON.stringify(seen)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Stock opens on the new summary; the full records the ledger tests use
// sit behind "Show full records".
async function openRecords(page) {
  const show = page.getByRole("button", { name: "Show full records" });
  if (await show.isVisible().catch(() => false)) await show.click();
}

async function newTrip(page, name) {
  await openRecords(page);
  const details = page.locator("details", { has: page.locator("summary", { hasText: "New trip" }) });
  if (!(await details.evaluate((d) => d.open))) await details.locator("summary").click();
  await details.locator('input[name="label"]').fill(name);
  await details.locator('select[name="kind"]').selectOption("resale");
  await details.getByRole("button", { name: "Create trip" }).click();
  await waitText(page.locator(".ledger-heading h2").first(), new RegExp("^" + name + "$"), "the new trip opens");
}

const entryRows = (page) => page.locator("table", { has: page.locator("th", { hasText: /^Entry$/ }) }).locator("tbody tr");

/** Adds one entry with the entry form and waits for its row. */
async function addEntry(page, { type, amount, units, minutes, date, refund, returnedOn }) {
  const form = page.getByRole("group", { name: "Add an entry" });
  const rows = entryRows(page);
  const before = await rows.count();
  await form.locator("select").first().selectOption(type);
  if (type === "refund")
    assert.equal(await form.locator('input[name="reference"]').getAttribute("placeholder"), "Order number of the sale");
  if (refund) {
    const choice = form.getByRole("group", { name: "Did the buyer send the item back?" });
    await choice.getByRole("radio", { name: refund === "returned" ? /Yes, it came back to me/ : /No, the buyer kept it/ }).check();
    // Units, and the date the item came back, are asked for only when it came back.
    assert.equal(await form.locator('input[name="units"]').count(), refund === "returned" ? 1 : 0, "units field for " + refund);
    const backField = form.getByLabel("Date the item came back (optional)");
    assert.equal(await backField.count(), refund === "returned" ? 1 : 0, "date-back field for " + refund);
    if (refund === "returned") assert.equal(await backField.getAttribute("min"), "2000-01-01", "the date back has the ledger's floor");
    if (returnedOn) await backField.fill(returnedOn);
  }
  if (minutes !== undefined) await form.locator('input[name="minutes"]').fill(String(minutes));
  if (amount !== undefined) await form.locator('input[name="amount"]').fill(String(amount));
  if (units !== undefined) await form.locator('input[name="units"]').fill(String(units));
  await form.locator('input[name="occurred"]').fill(date);
  await form.getByRole("button", { name: "Save entry" }).click();
  const until = Date.now() + 10000;
  while ((await rows.count()) <= before) {
    const alert = form.locator('[role="alert"]');
    if (await alert.count()) throw new Error(`Saving the ${type} entry failed: ${await alert.innerText()}`);
    if (Date.now() > until) throw new Error(`The ${type} entry did not appear`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Stores a small PDF as the proof for the entry whose option text is given. */
async function attachProof(page, entryLabel, body) {
  const group = page.getByRole("group", { name: "Private proofs" });
  const stored = group.locator(".ledger-proofs li");
  const before = await stored.count();
  await group.locator('input[name="file"]').setInputFiles({
    name: body + ".pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%" + body + "\n%%EOF\n", "latin1"),
  });
  await group.locator('select[name="entryId"]').selectOption({ label: entryLabel });
  await group.getByRole("button", { name: "Store proof" }).click();
  const until = Date.now() + 10000;
  while ((await stored.count()) <= before) {
    const alert = group.locator('form [role="alert"]');
    if (await alert.count()) throw new Error(`Storing the proof for ${entryLabel} failed: ${await alert.innerText()}`);
    if (Date.now() > until) throw new Error(`The proof for ${entryLabel} did not appear`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The ledger figure (dd) after the term (dt) matching the pattern. */
const figure = (page, pattern) => page.locator(".ledger-figures dt", { hasText: pattern }).first().locator("xpath=following-sibling::dd[1]");

// The month summary is no longer repeated on the full records (it lives on
// the Stock and Money screens), so the month figures are read from the API.
const month = async (app, m) => (await app.api("/api/ledger/summary?month=" + m)).body;

async function closeTrip(page) {
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Close trip" }).click();
  await waitText(page.locator("p.badges"), /closed /i, "trip closed");
}


test(
  "ledger: cross-month earnings per hour and a returned unit sold again, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed", timeout: 360000 },
  async () => {
    for (const width of [390, 1280]) {
      const app = await startApp();
      try {
        await atWidths(
          browser,
          app.url + "/#Ledger",
          async (page) => {
            await page.waitForLoadState("networkidle");

            // Finding 3: £100 and 2 h in October; £180 and 5 minutes in November.
            await newTrip(page, "Cross-month kettle");
            await addEntry(page, { type: "receipt", amount: 100, units: 1, date: "2026-10-10" });
            await addEntry(page, { type: "work", minutes: 120, date: "2026-10-10" });
            await addEntry(page, { type: "sale", amount: 200, units: 1, date: "2026-11-01" });
            await addEntry(page, { type: "payout", amount: 180, units: 1, date: "2026-11-01" });
            await addEntry(page, { type: "work", minutes: 5, date: "2026-11-01" });

            // November: the whole trip, £80 over 125 minutes, is £38.40 an hour.
            const nov = await month(app, "2026-11");
            assert.equal(nov.realisedHourly, 3840, "November per hour");
            assert.equal(nov.hourly.trips, 1);
            assert.equal(nov.hourly.earnings, 8000);
            assert.equal(nov.hourly.minutes, 125);
            assert.equal(nov.realisedEarnings, 18000, "November cash");
            // October: no hourly figure; the trip counts in November.
            const oct = await month(app, "2026-10");
            assert.equal(oct.realisedHourly, null, "October per hour");
            assert.equal(oct.hourly.completedLater, 1, "October: completed in a later month");
            assert.equal(oct.realisedEarnings, -10000, "October cash");

            // The trip's own figure is the whole trip too.
            await waitText(figure(page, /^Realised earnings per hour/), /£38\.40 per hour/, "trip per hour");
            await waitText(figure(page, /^Realised earnings per hour/), /counts in November 2026's earnings per hour/, "trip completion");

            // Finding 5: buy 1, sell it, the buyer sends it back, sell it again.
            await newTrip(page, "Returned and resold");
            await addEntry(page, { type: "receipt", amount: 10, units: 1, date: "2026-10-01" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-03" });
            await addEntry(page, { type: "payout", amount: 22, units: 1, date: "2026-10-05" });
            await addEntry(page, { type: "refund", amount: 25, refund: "returned", units: 1, date: "2026-10-07" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-09" });
            await addEntry(page, { type: "payout", amount: 22, units: 1, date: "2026-10-12" });
            await addEntry(page, { type: "work", minutes: 30, date: "2026-10-12" });
            await waitText(figure(page, /^Units bought, sold, returned$/), /^1 \/ 2 \/ 1$/, "units");
            await waitText(figure(page, /^Unsold units$/), /^0$/, "unsold");
            await waitText(entryRows(page).filter({ hasText: "Refund to a buyer" }), /Item came back into stock/, "refund row");
            assert.equal(await page.getByText("Discrepancies to check").count(), 0);
            await waitText(page.locator("b", { hasText: /^Reconciliation/ }), /^Reconciliation\s+Complete$/i, "reconciliation");
            await attachProof(page, "Purchase receipt, 1 Oct 2026, £10.00", "till receipt " + width);
            await attachProof(page, "Payout, 5 Oct 2026, £22.00", "payout one " + width);
            await attachProof(page, "Payout, 12 Oct 2026, £22.00", "payout two " + width);
            await waitText(page.locator("b", { hasText: /^Verification/ }), /^Verification\s+Verified$/i, "verification");
            assert.equal(await page.locator("b", { hasText: /^Verification/ }).locator(".badge.ok").count(), 1);

            // The buyer kept the item: nothing comes back, so a second sale is flagged.
            await newTrip(page, "Buyer kept it");
            await addEntry(page, { type: "receipt", amount: 10, units: 1, date: "2026-10-01" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-03" });
            await addEntry(page, { type: "payout", amount: 22, units: 1, date: "2026-10-05" });
            await addEntry(page, { type: "refund", amount: 25, refund: "kept", date: "2026-10-07" });
            await waitText(entryRows(page).filter({ hasText: "Refund to a buyer" }), /Buyer kept the item/, "kept refund row");
            await waitText(figure(page, /^Unsold units$/), /^0$/, "nothing to resell");
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-09" });
            await waitText(
              page.locator("ul.checks li", { hasText: "The sale on 9 Oct 2026" }),
              /is for 1 unit, but none was in stock at that point/,
              "short sale flagged",
            );
            // Sold 2 against 1 bought, still open and no work time: it has a
            // receipt, so it is asked for the purchase of the extra unit (or
            // a check of the kept refund) and for its work time, and never
            // told that the monthly figure counts it.
            const keptNote = await waitText(
              figure(page, /^Realised earnings per hour/),
              /^no work time recorded\s+This trip sold 2 units against 1 bought, so what the rest of the stock cost is not known and its real result can only be lower than recorded\. Monthly earnings per hour leave it out, as they leave out every trip without work time\. Record the purchase of the units sold beyond those bought and the work time to count it\. If a buyer sent an item back but its refund says they kept it, delete that refund and record it again with the item back\.$/,
              "open part-bought trip without work time: what to record",
            );
            assert.doesNotMatch(keptNote, /Record the purchase receipt|only where that lowers/);

            // Fix b, R3: the item came back and was sold again on 6 Oct; the
            // refund was paid on 7 Oct. With the date it came back, nothing is flagged.
            await newTrip(page, "Back before the refund");
            await addEntry(page, { type: "receipt", amount: 10, units: 1, date: "2026-10-01" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-03" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-06" });
            await addEntry(page, { type: "refund", amount: 25, refund: "returned", units: 1, date: "2026-10-07", returnedOn: "2026-10-06" });
            await addEntry(page, { type: "payout", amount: 44, units: 2, date: "2026-10-08" });
            await waitText(entryRows(page).filter({ hasText: "Refund to a buyer" }), /Item came back into stock on 6 Oct 2026/, "refund row with the date back");
            await waitText(figure(page, /^Unsold units$/), /^0$/, "date back: unsold");
            assert.equal(await page.getByText("Discrepancies to check").count(), 0, "a resale before the refund date is not flagged");

            // Fix b, R5: refunded and sent back before any payout, sold again,
            // one unit paid out: nothing is left pending.
            await newTrip(page, "Refunded before payout");
            await addEntry(page, { type: "receipt", amount: 10, units: 1, date: "2026-10-01" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-03" });
            await addEntry(page, { type: "refund", amount: 25, refund: "returned", units: 1, date: "2026-10-05" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-08" });
            await addEntry(page, { type: "payout", amount: 22, units: 1, date: "2026-10-10" });
            await waitText(
              figure(page, /^Pending payout/),
              /^£0\.00\s+Not counted: £25\.00 for 1 unit refunded, with the item sent back, before it was paid out\./,
              "refunded sale not pending",
            );
            assert.equal(await page.getByText("Discrepancies to check").count(), 0);

            // Fix b, L6: sold and paid out with no purchase receipt, then closed.
            await newTrip(page, "Sold with no receipt");
            await addEntry(page, { type: "sale", amount: 200, units: 1, date: "2026-10-02" });
            await addEntry(page, { type: "payout", amount: 180, units: 1, date: "2026-10-04" });
            await addEntry(page, { type: "work", minutes: 30, date: "2026-10-04" });
            // Open, with work time and no receipt at all: asked for the receipt.
            await waitText(
              figure(page, /^Realised earnings per hour/),
              /^not known\s+This trip sold stock with no purchase recorded for it, so what the stock cost is not known and its real result can only be lower than recorded\. Monthly earnings per hour count it only where that lowers the figure\. Record the purchase receipt to count it in full\.$/,
              "open no-receipt trip with work time told to record the receipt",
            );
            await closeTrip(page);
            const closedNote = await waitText(
              figure(page, /^Realised earnings per hour/),
              /^not known\s+This trip sold stock with no purchase recorded for it, so what the stock cost is not known and its real result can only be lower than recorded\..*The trip is closed, so the purchase can no longer be added\.$/s,
              "closed trip: not known, and no advice it cannot follow",
            );
            assert.doesNotMatch(closedNote, /Record the purchase receipt/);
            // Only "Returned and resold" counts in October: £9.00 over 30 minutes.
            const octLeftOut = await month(app, "2026-10");
            assert.equal(octLeftOut.realisedHourly, 1800, "October per hour without the no-receipt trip");
            assert.equal(octLeftOut.hourlyNoPurchase.trips, 1, "month leaves out the no-receipt trip");
            assert.equal(octLeftOut.hourlyNoPurchase.earnings, 18000);
            assert.equal(octLeftOut.hourlyNoPurchase.open ?? 0, 0, "the trip left out is closed");
            await waitText(
              page.locator("dd", { has: page.locator('[data-hourly-left-out="no purchase"]') }).last(),
              /over 0 closed trips with work time\s+Left out: 1 closed trip that sold stock with no purchase recorded \(\+£180\.00\)/,
              "measures name the trip left out",
            );

            // Second pass (verifier A4): a no-receipt trip that lost money
            // (the buyer kept the item after a full refund) lowers the figure,
            // so it counts; leaving it out would raise earnings per hour.
            await newTrip(page, "Kept after a full refund, no receipt");
            await addEntry(page, { type: "sale", amount: 100, units: 1, date: "2026-10-08" });
            await addEntry(page, { type: "payout", amount: 90, units: 1, date: "2026-10-08" });
            await addEntry(page, { type: "refund", amount: 100, refund: "kept", date: "2026-10-08" });
            await addEntry(page, { type: "work", minutes: 60, date: "2026-10-08" });
            await closeTrip(page);
            // And a measured closed trip: £15.00 over 30 minutes.
            await newTrip(page, "Measured and closed");
            await addEntry(page, { type: "receipt", amount: 10, units: 1, date: "2026-10-20" });
            await addEntry(page, { type: "sale", amount: 30, units: 1, date: "2026-10-20" });
            await addEntry(page, { type: "payout", amount: 25, units: 1, date: "2026-10-21" });
            await addEntry(page, { type: "work", minutes: 30, date: "2026-10-21" });
            await closeTrip(page);
            // (£9 + £15 - £10) over 2 hours; the £180 gain stays out.
            const octLoss = await month(app, "2026-10");
            assert.equal(octLoss.hourly.trips, 3, "October counts 3 trips with the loss");
            assert.equal(octLoss.realisedHourly, 700, "October per hour with the loss counted");
            assert.equal(octLoss.hourly.earnings, 1400);
            assert.equal(octLoss.hourly.minutes, 120);
            assert.equal(octLoss.hourlyNoPurchase.countedTrips, 1, "the loss-making no-receipt trip is counted");
            assert.equal(octLoss.hourlyNoPurchase.countedEarnings, -1000);
            assert.equal(octLoss.hourlyNoPurchase.trips, 1, "the £180 gain stays out");
            assert.equal(octLoss.hourlyNoPurchase.earnings, 18000);
            // The measures (closed trips): £15 over 30 minutes and -£10 over an hour.
            await waitText(
              page.locator("dd", { has: page.locator('[data-hourly-counted="no purchase"]') }),
              /^£3\.33 over 2 closed trips with work time\s+Counted: 1 closed trip that sold stock with no purchase recorded \(-£10\.00\), at the recorded result, because that lowers the figure\..*Left out: 1 closed trip that sold stock with no purchase recorded \(\+£180\.00\)/s,
              "measures name the trip counted and the one left out",
            );

            // Third pass (verifier E1): an open trip that bought 1, sold it,
            // refunded a buyer who kept it, sold again and was paid out
            // twice, with no work time. It completes in October with part of
            // its purchase missing: the month asks for the purchase of the
            // extra unit (or a correction) and its work time, and the figure
            // is unchanged.
            await newTrip(page, "Sold beyond its receipt");
            await addEntry(page, { type: "receipt", amount: 10, units: 1, date: "2026-10-01" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-03" });
            await addEntry(page, { type: "payout", amount: 22, units: 1, date: "2026-10-04" });
            await addEntry(page, { type: "refund", amount: 25, refund: "kept", date: "2026-10-05" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-06" });
            await addEntry(page, { type: "payout", amount: 22, units: 1, date: "2026-10-08" });
            await waitText(figure(page, /^Realised earnings per hour/), /Monthly earnings per hour leave it out, as they leave out every trip without work time\. Record the purchase of the units sold beyond those bought and the work time to count it\./, "E1 trip: what to record");
            const octE1 = await month(app, "2026-10");
            assert.equal(octE1.realisedHourly, 700, "October per hour unchanged by a trip without work time");
            assert.equal(octE1.hourlyNoPurchase.trips, 2, "October leaves out both no-receipt trips");
            assert.equal(octE1.hourlyNoPurchase.earnings, 18900);
            assert.equal(octE1.hourlyNoPurchase.open, 1, "one of them is still open");
            assert.equal(octE1.hourlyNoPurchase.openNoWork, 1, "and has no work time");
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
  "ledger: a resale before its refund gets advice the trip allows, and the date back has a floor, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed", timeout: 240000 },
  async () => {
    const R3_FACTS =
      "The sale on 6 Oct 2026 is for 1 unit, but none was in stock at that point " +
      "(units bought, less units sold, plus units buyers sent back).";
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const width of [390, 1280]) {
      const app = await startApp();
      try {
        // The verifier's R3, recorded with no date back, on a trip that is then closed.
        const closedId = (await app.api("/api/ledger/trips", { method: "POST", body: { label: "Resold before the refund, closed", source: "manual", kind: "resale" } })).body.id;
        for (const body of [
          { type: "receipt", amount: 1000, units: 1, occurred: "2026-10-01" },
          { type: "sale", amount: 2500, units: 1, occurred: "2026-10-03" },
          { type: "sale", amount: 2500, units: 1, occurred: "2026-10-06" },
          { type: "refund", amount: 2500, units: 1, itemReturned: true, occurred: "2026-10-07" },
          { type: "payout", amount: 4400, units: 2, occurred: "2026-10-08" },
        ])
          assert.equal((await app.api(`/api/ledger/trips/${closedId}/entries`, { method: "POST", body })).status, 201);
        assert.equal((await app.api(`/api/ledger/trips/${closedId}/close`, { method: "POST", body: {} })).status, 200);

        await atWidths(
          browser,
          app.url + "/#Ledger",
          async (page) => {
            await page.waitForLoadState("networkidle");
            const flagged = page.locator("ul.checks li", { hasText: "The sale on 6 Oct 2026" });

            // Open: the same records through the form, with no date back.
            await newTrip(page, "Resold before the refund");
            await addEntry(page, { type: "receipt", amount: 10, units: 1, date: "2026-10-01" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-03" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-06" });
            await addEntry(page, { type: "refund", amount: 25, refund: "returned", units: 1, date: "2026-10-07" });
            await addEntry(page, { type: "payout", amount: 44, units: 2, date: "2026-10-08" });
            const openText = await waitText(
              flagged,
              new RegExp(
                "^" +
                  escape(
                    R3_FACTS +
                      " Check the units, or record the purchase or the return the stock came from." +
                      " If an item a buyer sent back came back before its refund was paid, remove that refund and record it again with the date the item came back.",
                  ) +
                  "$",
              ),
              "open trip: remove the refund and record it again",
            );
            assert.doesNotMatch(openText, /give the date it came back on that refund/);
            assert.equal(await page.getByRole("button", { name: /^Edit/ }).count(), 0, "entries have no edit control");

            // Do what it says: remove the refund ...
            const rows = entryRows(page);
            const before = await rows.count();
            page.once("dialog", (d) => d.accept());
            await rows.filter({ hasText: "Refund to a buyer" }).getByRole("button", { name: "Remove" }).click();
            for (const until = Date.now() + 10000; (await rows.count()) >= before; ) {
              if (Date.now() > until) throw new Error("The refund was not removed");
              await new Promise((r) => setTimeout(r, 100));
            }
            // ... and record it again with the date it came back. A date
            // before 2000 is stopped by the form, so it never reaches the server.
            const form = page.getByRole("group", { name: "Add an entry" });
            await form.locator("select").first().selectOption("refund");
            await form.getByRole("group", { name: "Did the buyer send the item back?" }).getByRole("radio", { name: /Yes, it came back to me/ }).check();
            await form.locator('input[name="amount"]').fill("25");
            await form.locator('input[name="units"]').fill("1");
            await form.locator('input[name="occurred"]').fill("2026-10-07");
            const backField = form.getByLabel("Date the item came back (optional)");
            assert.equal(await backField.getAttribute("min"), "2000-01-01");
            await backField.fill("1999-12-31");
            const requests = [];
            const onRequest = (r) => r.method() === "POST" && r.url().includes("/api/ledger/") && requests.push(r.url());
            page.on("request", onRequest);
            await form.getByRole("button", { name: "Save entry" }).click();
            await new Promise((r) => setTimeout(r, 500));
            page.off("request", onRequest);
            assert.equal(await backField.evaluate((el) => el.validity.rangeUnderflow), true, "1999-12-31 is below the field's floor");
            assert.deepEqual(requests, [], "the form does not send a date back before 2000");
            assert.equal(await rows.count(), before - 1, "nothing was recorded");
            await backField.fill("2026-10-06");
            await form.getByRole("button", { name: "Save entry" }).click();
            await waitText(rows.filter({ hasText: "Refund to a buyer" }), /Item came back into stock on 6 Oct 2026/, "the refund recorded again with the date back");
            for (const until = Date.now() + 10000; await page.getByText("Discrepancies to check").count(); ) {
              if (Date.now() > until) throw new Error("The discrepancy did not clear: " + (await flagged.allInnerTexts()).join(" | "));
              await new Promise((r) => setTimeout(r, 100));
            }
            // What the server says to a caller that skips the form's floor: plain words.
            const openId = (await app.api("/api/ledger/trips")).body.trips.find((t) => t.label === "Resold before the refund").id;
            const early = await app.api(`/api/ledger/trips/${openId}/entries`, {
              method: "POST",
              body: { type: "refund", amount: 2500, units: 1, itemReturned: true, occurred: "2026-10-07", returnedOn: "1999-12-31" },
            });
            assert.equal(early.status, 400);
            assert.equal(early.body.error, "The date the item came back must be on or after 2000-01-01");

            // Closed: nothing can change, and it says so instead of advising a change.
            await page.locator("button.ledger-trip", { has: page.locator("b", { hasText: /^Resold before the refund, closed$/ }) }).click();
            await waitText(page.locator(".ledger-heading h2").first(), /^Resold before the refund, closed$/, "the closed trip opens");
            const closedText = await waitText(
              flagged,
              new RegExp("^" + escape(R3_FACTS + " The trip is closed, so its entries cannot change.") + "$"),
              "closed trip: its entries cannot change",
            );
            assert.doesNotMatch(closedText, /remove that refund|record the purchase|give the date/);
            assert.equal(await page.getByRole("button", { name: "Remove" }).count(), 0, "a closed trip's entries have no Remove");
            assert.equal(await page.getByRole("group", { name: "Add an entry" }).count(), 0, "a closed trip takes no entries");
          },
          [width],
        );
      } finally {
        app.stop();
      }
    }
  },
);

// A real server commits the synthetic write, then the browser loses its reply.
// Retrying the still-open form must use the same intent.
test('ledger: lost acknowledgements do not duplicate money or stock',
  { skip: !chromium && 'Playwright is not installed', timeout: 180000 }, async () => {
    const app = await startApp();
    try {
      await atWidths(browser, app.url + '/#Ledger', async page => {
        await openRecords(page);
        const details = page.locator('details', { has: page.locator('summary', { hasText: 'New trip' }) });
        await details.locator('summary').click();
        await details.locator('input[name="label"]').fill('Synthetic lost reply ' + page.viewportSize().width);
        let loseTrip = true;
        await page.route('**/api/ledger/trips', async route => {
          if (route.request().method() !== 'POST' || !loseTrip) return route.continue();
          loseTrip = false;
          const committed = await route.fetch(); assert.equal(committed.status(), 201);
          await route.abort('failed');
        });
        await details.getByRole('button', { name: 'Create trip' }).click();
        await details.getByRole('alert').waitFor();
        await details.getByRole('button', { name: 'Create trip' }).click();
        await waitText(page.locator('.ledger-heading h2').first(), /Synthetic lost reply/, 'retried trip');
        const trips = (await app.api('/api/ledger/trips')).body.trips;
        const match = trips.filter(t => t.label === 'Synthetic lost reply ' + page.viewportSize().width);
        assert.equal(match.length, 1);
        const id = match[0].id;
        let loseEntry = true;
        await page.route('**/api/ledger/trips/' + id + '/entries', async route => {
          if (!loseEntry) return route.continue();
          loseEntry = false;
          const committed = await route.fetch(); assert.equal(committed.status(), 201);
          await route.abort('failed');
        });
        const form = page.getByRole('group', { name: 'Add an entry' });
        await form.locator('select').first().selectOption('receipt');
        await form.locator('input[name="amount"]').fill('12.50');
        await form.locator('input[name="units"]').fill('1');
        await form.locator('input[name="occurred"]').fill('2026-01-01');
        await form.getByRole('button', { name: 'Save entry' }).click();
        await form.getByRole('alert').waitFor();
        await form.getByRole('button', { name: 'Save entry' }).click();
        await waitText(entryRows(page), /12.50/, 'retried receipt');
        const result = (await app.api('/api/ledger/trips/' + id)).body;
        assert.equal(result.entries.length, 1);
        assert.equal(result.entries[0].amount, 1250);
        // An acknowledged, reset form represents a genuinely new entry.
        await addEntry(page, { type: 'receipt', amount: 12.50, units: 1, date: '2026-01-01' });
        assert.equal((await app.api('/api/ledger/trips/' + id)).body.entries.length, 2);
      }, undefined, { expectedConsoleErrors: [/Failed to load resource: net::ERR_FAILED/] });
    } finally { app.stop(); }
  });

test('stock: malformed prices are rejected and retrying a failed proof keeps one receipt',
  { skip: !chromium && 'Playwright is not installed', timeout: 180000 }, async () => {
    const app = await startApp();
    try {
      await atWidths(browser, app.url + '/#Ledger', async page => {
        const label = 'Synthetic proof retry ' + page.viewportSize().width;
        const { body: { id } } = await app.api('/api/ledger/trips', {
          method: 'POST', body: JSON.stringify({ label, source: 'manual', kind: 'resale' }),
        });
        await page.reload();
        const card = page.locator('.sk-card', { has: page.getByRole('button', { name: label, exact: true }) });
        await card.getByRole('button', { name: 'Add what you bought', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Item', { exact: true }).fill('Synthetic kettle');
        await dialog.getByLabel('You paid in total', { exact: true }).fill('1,2');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await dialog.getByText('Type the amount in pounds, like 9.50.', { exact: true }).waitFor();
        assert.equal((await app.api('/api/ledger/trips/' + id)).body.entries.length, 0);
        await dialog.getByLabel('You paid in total', { exact: true }).fill('12.50');
        await dialog.locator('input[name="proof"]').setInputFiles({
          name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%synthetic retry\n%%EOF\n'),
        });
        let refuse = true;
        await page.route('**/api/ledger/trips/' + id + '/proofs', route => {
          if (!refuse) return route.continue();
          refuse = false;
          return route.fulfill({ status: 503, json: { error: 'Synthetic proof outage' } });
        });
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await dialog.getByText('Entry saved; proof not attached.', { exact: true }).waitFor();
        assert.equal((await app.api('/api/ledger/trips/' + id)).body.entries.length, 1);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        const result = (await app.api('/api/ledger/trips/' + id)).body;
        assert.equal(result.entries.length, 1);
        assert.equal(result.entries[0].amount, 1250);
        assert.equal(result.proofs.length, 1);
      }, undefined, { expectedConsoleErrors: [/Failed to load resource: the server responded with a status of 503/] });
    } finally { app.stop(); }
  });
