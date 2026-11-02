import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findDeals,
  latestFinds,
  parseProductList,
  parseRss,
  readScreen,
  runCost,
  saveFinds,
  screenPrompt,
  soldLink,
  toPence,
} from "./finder.mjs";

const RSS = `<rss><channel><title>HotUKDeals</title>
<item><category><![CDATA[Home & Living]]></category><pepper:merchant name="Screwfix" price="£39.99"/><title><![CDATA[Milwaukee M12 B6 12V 6.0Ah battery £39.99 &amp; free C&amp;C]]></title><description><![CDATA[<strong>£39.99 - Screwfix</strong><p>Click and collect.</p>]]></description><link>https://www.hotukdeals.com/deals/milwaukee-1</link><pubDate>Mon, 02 Nov 2026 07:10:49 +0000</pubDate></item>
<item><category><![CDATA[Groceries]]></category><pepper:merchant name="Tesco"/><title><![CDATA[Crisps multipack]]></title><description><![CDATA[Cheap crisps]]></description><link>https://www.hotukdeals.com/deals/crisps-2</link><pubDate>Mon, 02 Nov 2026 07:00:00 +0000</pubDate></item>
<item><title><![CDATA[]]></title><link></link></item>
</channel></rss>`;

const PAGE = `<html><script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[
{"@type":"Product","url":"https://www.diy.com/departments/oven/1_BQ.prd","name":"Candy Built-in Oven &amp; grill","sku":"8059019047256","offers":{"price":149}},
{"@type":"Product","url":"https://www.diy.com/departments/stirrer/2_BQ.prd","name":"Paint stirrer","sku":"BQ-2","offers":{"price":1}},
{"@type":"Product","name":"No link"}]}</script>
<script type="application/ld+json">{not json</script></html>`;

test("toPence reads shop prices", () => {
  assert.equal(toPence("£1.50"), 150);
  assert.equal(toPence("£1,299"), 129900);
  assert.equal(toPence(36), 3600);
  assert.equal(toPence(""), null);
  assert.equal(toPence(undefined), null);
  assert.equal(toPence(-1), null);
});

test("parseRss reads HotUKDeals posts and skips empty items", () => {
  const posts = parseRss(RSS);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].title, "Milwaukee M12 B6 12V 6.0Ah battery £39.99 & free C&C");
  assert.equal(posts[0].shop, "Screwfix");
  assert.equal(posts[0].price, 3999);
  assert.equal(posts[0].category, "Home & Living");
  assert.equal(posts[0].link, "https://www.hotukdeals.com/deals/milwaukee-1");
  assert.equal(posts[0].posted, Date.parse("2026-11-02T07:10:49Z"));
  assert.match(posts[0].detail, /Click and collect/);
  assert.equal(posts[1].price, null);
});

test("parseProductList reads schema.org products and keeps real barcodes only", () => {
  const posts = parseProductList(PAGE, "B&Q", "bq-clearance");
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((p) => [p.title, p.price, p.barcode, p.shop]),
    [
      ["Candy Built-in Oven & grill", 14900, "8059019047256", "B&Q"],
      ["Paint stirrer", 100, null, "B&Q"],
    ],
  );
});

test("screenPrompt numbers every post with its shop and price", () => {
  const p = screenPrompt(parseRss(RSS));
  assert.match(p, /1\. \[Screwfix £39\.99\]/);
  assert.match(p, /2\. \[Tesco no price\]/);
});

test("readScreen keeps only candidates and ignores bad numbers", () => {
  const posts = parseRss(RSS);
  const finds = readScreen(
    {
      items: [
        { n: 1, item: "Milwaukee M12 B6 battery", brand: "Milwaukee", where: "both", resale_candidate: true, why: "Branded tool battery", sold_search: "Milwaukee M12 B6 6.0Ah" },
        { n: 1, item: "duplicate", resale_candidate: true },
        { n: 2, item: "Crisps", resale_candidate: false },
        { n: 9, item: "Out of range", resale_candidate: true },
        { n: "x", resale_candidate: true },
      ],
    },
    posts,
  );
  assert.equal(finds.length, 1);
  const f = finds[0];
  assert.equal(f.item, "Milwaukee M12 B6 battery");
  assert.equal(f.price, 3999);
  assert.equal(f.where, "both");
  assert.equal(f.link, "https://www.hotukdeals.com/deals/milwaukee-1");
  assert.equal(f.soldLink, soldLink("Milwaukee M12 B6 6.0Ah"));
  assert.match(f.soldLink, /LH_Sold=1&LH_Complete=1$/);
});

test("readScreen falls back when the model leaves fields out", () => {
  const posts = parseRss(RSS);
  const [f] = readScreen({ items: [{ n: 1, resale_candidate: true, where: "teleport" }] }, posts);
  assert.equal(f.where, "unknown");
  assert.equal(f.item, posts[0].title);
  assert.equal(f.soldSearch, posts[0].title);
  assert.deepEqual(readScreen(null, posts), []);
});

test("runCost prices a run from token use", () => {
  assert.equal(runCost("gpt-5-mini", { input_tokens: 1e6, output_tokens: 1e6 }), 2.25);
  assert.equal(runCost("unknown-model", { input_tokens: 1 }), null);
});

const reply = (status, body, text = typeof body === "string" ? body : JSON.stringify(body)) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => text,
  json: async () => JSON.parse(text),
});

test("findDeals reads sources, records a blocked one and sorts with the model", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes("hotukdeals")) return reply(200, RSS);
    if (url.includes("blocked")) return reply(403, "Forbidden");
    if (url.includes("diy.com")) return reply(200, PAGE);
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-5-mini");
    assert.match(body.input, /Milwaukee/);
    return reply(200, {
      output: [{ type: "message", content: [{ text: JSON.stringify({ items: [{ n: 1, item: "Milwaukee battery", resale_candidate: true, where: "both", sold_search: "Milwaukee M12 B6" }, { n: 3, item: "Candy oven", resale_candidate: true, where: "in-store", sold_search: "Candy oven" }] }) }] }],
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
  };
  const run = await findDeals({
    key: "test",
    model: "gpt-5-mini",
    fetchImpl,
    now: () => 42,
    sources: [
      { id: "hotukdeals", name: "HotUKDeals", url: "https://www.hotukdeals.com/rss/new", kind: "rss" },
      { id: "blocked", name: "Blocked shop", url: "https://blocked.example/clearance", kind: "productList" },
      { id: "bq-clearance", name: "B&Q clearance", url: "https://www.diy.com/clearance.cat", kind: "productList" },
    ],
  });
  assert.equal(run.ranAt, 42);
  assert.equal(run.screened, 4);
  assert.deepEqual(run.sources.map((s) => [s.id, s.ok, s.posts]), [["hotukdeals", true, 2], ["blocked", false, 0], ["bq-clearance", true, 2]]);
  assert.equal(run.sources[1].error, "answered 403");
  assert.deepEqual(run.finds.map((f) => [f.item, f.shop, f.barcode]), [["Milwaukee battery", "Screwfix", null], ["Candy oven", "B&Q", "8059019047256"]]);
  assert.equal(run.costUsd, (1000 * 0.25 + 500 * 2) / 1e6);
  assert.equal(calls.filter((u) => u.includes("openai")).length, 1);
});

test("findDeals needs an API key and reports an unreadable answer", async () => {
  await assert.rejects(findDeals({ key: "" }), /OPENAI_API_KEY/);
  const fetchImpl = async (url) =>
    url.includes("openai")
      ? reply(200, { output: [{ type: "message", content: [{ text: "not json" }] }] })
      : reply(200, RSS);
  await assert.rejects(
    findDeals({ key: "k", fetchImpl, sources: [{ id: "h", name: "H", url: "https://h", kind: "rss" }] }),
    /not readable JSON/,
  );
});

test("saveFinds and latestFinds round-trip, and an empty store reads as no run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "finder-"));
  const before = process.env.BOUNTY_DATA_DIR;
  process.env.BOUNTY_DATA_DIR = dir;
  try {
    assert.equal((await latestFinds()).ranAt, null);
    await saveFinds({ ranAt: 7, finds: [{ item: "x" }] });
    assert.deepEqual(await latestFinds(), { ranAt: 7, finds: [{ item: "x" }] });
  } finally {
    if (before === undefined) delete process.env.BOUNTY_DATA_DIR;
    else process.env.BOUNTY_DATA_DIR = before;
    await rm(dir, { recursive: true, force: true });
  }
});
