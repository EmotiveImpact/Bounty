// Round 5 (Edem): travel is an added layer, not a blocker. By public
// transport with the fare left blank, the Planner still shortlists the items
// inside the buying thresholds before travel, ranked by profit per unit
// before the fare, with the fare shown as not known yet and every figure that
// needs it labelled "before your fare" (or "plus your fare" for cash). Goals
// builds baskets the same way and recommends none. Entering a fare brings
// back the figures after travel exactly as before.
//
// Everything goes through the real app: the profile is the Planner's own
// form, and the expected figures come from the plan route.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
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

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const money = (pence) => gbp.format(pence / 100);
// SHOTS=<folder> keeps a picture of each step.
const shot = async (target, name) => {
  if (process.env.SHOTS) await target.screenshot({ path: join(process.env.SHOTS, name), fullPage: name.startsWith("page") });
};
// The value beside a label in a figures list.
const figure = (scope, label) => scope.locator("dl.planner-figures dt", { hasText: label }).first().locator("xpath=following-sibling::dd[1]");
// The same for figures inside a closed "See the figures" (not rendered, so read as text).
const hiddenFigure = async (scope, label) => ((await figure(scope, label).textContent()) || "").replace(/\s+/g, " ").trim();

test(
  "a blank public transport fare still gives a shortlist and baskets before travel, then a fare brings the figures after travel, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    // What the Planner's starting profile sends by public transport.
    const profile = {
      area: "London", budget: 10000, target: 1200, transport: "Public transport", carry: 5, quantity: 4,
      fare: null, perMile: 45, extra: 0, storage: 10, feeRate: 0.13, feeFixed: 40, returnsRate: 0.05, rules: {},
    };
    const blank = await app.api("/api/plan", { method: "POST", body: profile });
    assert.equal(blank.status, 200);
    const jacket = blank.body.trips.find((t) => t.sku === "jacket");
    const bottle = blank.body.trips.find((t) => t.sku === "bottle");
    assert.ok(jacket && bottle, "both are shortlisted with a blank fare");
    const fare = await app.api("/api/plan", { method: "POST", body: { ...profile, fare: 450 } });
    const jacketFare = fare.body.trips.find((t) => t.sku === "jacket");
    const bottleOut = fare.body.rejected.find((r) => r.sku === "bottle");

    await atWidths(browser, app.url + "/#Planner", async (page, width) => {
      // The full planner, with the basket plan under it, sits below My trip.
      await page.getByRole("button", { name: "Show the full planner" }).click();
      // The buying profile is edited in a window opened from its bar.
      const editProfile = page.locator(".planner-profilebar").getByRole("button", { name: "Edit profile" });
      const doneProfile = page.locator("#planner-profile").getByRole("button", { name: "Done" });
      await editProfile.click();
      await page.getByRole("combobox", { name: /^Transport/ }).selectOption("Public transport");
      const fareField = page.getByLabel("Public transport return fare (£)");
      assert.equal(await fareField.inputValue(), "", "the fare starts blank");
      await page.locator("#planner-profile").getByText(/A blank fare is never counted as free\. Trips are still shortlisted/).waitFor();
      await doneProfile.click();
      await page.locator(".planner-chips li.warn", { hasText: "Fare not entered" }).waitFor();

      // The shortlist: both items, ranked by profit per unit before the fare.
      const cards = page.locator("button.planner-trip");
      await page.locator(".planner-ranking", { hasText: "Ranked by profit per unit before your fare" }).waitFor();
      await cards.filter({ hasText: "Children's waterproof jacket" }).waitFor();
      assert.equal(await cards.count(), 2);
      assert.match(await cards.nth(0).innerText(), /Children's waterproof jacket/);
      assert.match(await cards.nth(1).innerText(), /Insulated steel water bottle/);
      for (const i of [0, 1]) await cards.nth(i).locator(".planner-fit", { hasText: "Fits before your fare is added" }).waitFor();
      await shot(page, `page-planner-blank-${width}.png`);

      // The trip details: the travel is visible and not known yet; every
      // figure that needs it says so.
      const trip = page.locator("article.planner-detail");
      await trip.locator(".planner-travel-note", { hasText: "Travel cost still to be added" }).waitFor();
      assert.equal(await figure(trip, "Cash required before payout").innerText(), `${money(jacket.beforeTravel.cashRequired)} plus your fare`);
      assert.equal(await figure(trip, "Earnings per hour").innerText(), `${money(jacket.beforeTravel.hourly)} an hour before your fare`);
      await trip.locator("ul.checks li.pass", { hasText: "Inside your buying thresholds before your fare" }).first().waitFor();
      await trip.locator("ul.checks li.planner-pending", { hasText: "Travel cost still to be added" }).first().waitFor();
      // "What changes if I drive?": the public transport side is before its fare.
      const travelRow = trip.locator("table.planner-compare tr", { has: page.locator("th", { hasText: /^Travel cost$/ }) });
      assert.equal(await travelRow.locator("td").nth(0).innerText(), "not known yet");
      await page.locator(".planner-rejected", { hasText: "3 offers outside your buying thresholds" }).waitFor();
      assert.match((await page.locator(".planner-rejected").innerText()).replace(/\s+/g, " "), /even before your public transport fare/);
      await shot(trip, `trip-blank-${width}.png`);

      // The baskets, under the planner: before the fare and under the cash limit, none recommended.
      await page.getByRole("heading", { name: "Top baskets before your fare" }).waitFor();
      const first = page.locator(".planner-basket").first();
      assert.match(await first.innerText(), /3 × Children's waterproof jacket and 1 × Insulated steel water bottle/);
      await first.locator(".badge", { hasText: "Fare not known yet" }).waitFor();
      assert.match(await hiddenFigure(first, "Cash required before payout"), /^£[\d.,]+ plus your fare$/);
      assert.match(await hiddenFigure(first, "Contribution if every unit sells"), /^£[\d.,]+ before your fare$/);
      assert.equal(await hiddenFigure(first, "Travel (one journey)"), "not known yet");
      assert.match(await hiddenFigure(first, "Loss if nothing sells"), /before your fare$/);
      await page.getByText(/while your fare is not known yet, before it: these fail even before your fare/).waitFor();
      assert.equal(await page.locator(".planner-basket .badge", { hasText: "Best fit for your profile" }).count(), 0);
      await shot(first, `basket-blank-${width}.png`);

      // Entering a fare: the figures after travel, and the baskets follow without a reload.
      await editProfile.click();
      await fareField.fill("4.50");
      await doneProfile.click();
      await page.locator(".planner-head", { hasText: "1 trip shortlisted" }).first().waitFor();
      assert.equal(await cards.count(), 1, "the bottle falls below £5 a unit after its share of the fare");
      const tripFare = page.locator("article.planner-detail");
      assert.equal(await figure(tripFare, "Cash required before payout").innerText(), money(jacketFare.economics.cashRequired));
      await tripFare.locator("ul.checks li.pass", { hasText: /^Inside your buying thresholds$/ }).first().waitFor();
      await page.locator(".planner-rejected .planner-reason", { hasText: bottleOut.reasons[0] }).first().waitFor();
      await shot(page, `page-planner-fare-${width}.png`);
      await page.locator(".planner-basket .badge", { hasText: "Best fit for your profile" }).first().waitFor();
      assert.equal(await page.locator(".planner-basket .badge", { hasText: "Fare not known yet" }).count(), 0);
      assert.equal(await page.locator(".planner-ranking").count(), 0, "no ranking before the fare, in the trips or the baskets");
    });
  },
);
