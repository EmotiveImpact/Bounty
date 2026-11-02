// The AI deal finder. It reads a few deal sources we can load without
// getting round any block, asks a small AI model to pick out the branded
// goods a reseller might flip, and saves the result for the Deals page.
//
// Finds are leads, not deals: nothing here has been checked against
// completed sales, so the Deals page shows them apart from real deals with a
// link to check sold prices. The AI sorts; it never searches the open web.
//
// HotUKDeals is read for testing only. Its robots file bans AI crawlers by
// name, so a licensed feed from its owner is needed before members see it.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./db.mjs";

export const USER_AGENT = "BountyFinder/0.1 (deal finder test)";

export const SOURCES = [
  {
    id: "hotukdeals",
    name: "HotUKDeals",
    url: "https://www.hotukdeals.com/rss/new",
    kind: "rss",
    testOnly: true,
  },
  {
    id: "bq-clearance",
    name: "B&Q clearance",
    url: "https://www.diy.com/clearance.cat",
    kind: "productList",
    testOnly: false,
  },
];

// Published prices in US dollars a million tokens, used only to show what a
// run cost. Check OpenAI's pricing page before budgeting from these.
export const PRICES = {
  "gpt-5-nano": { in: 0.05, out: 0.4 },
  "gpt-5-mini": { in: 0.25, out: 2.0 },
};
export const DEFAULT_MODEL = "gpt-5-mini";

const decode = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&pound;/g, "£")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const cdata = (s) => (s ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
const plain = (s) =>
  decode(cdata(s).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : "";
};

/** "£1.50" or "1.5" to pence, or null when there is no price. */
export function toPence(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  const m = String(value ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Math.round(Number(m[1]) * 100) : null;
}

/** HotUKDeals RSS to posts. */
export function parseRss(xml, source = "hotukdeals") {
  return String(xml)
    .split("<item>")
    .slice(1)
    .map((item) => {
      const merchant = item.match(/<pepper:merchant\s+name="([^"]*)"(?:\s+price="([^"]*)")?/);
      return {
        source,
        title: plain(tag(item, "title")),
        shop: merchant ? decode(merchant[1]) : "",
        price: merchant ? toPence(decode(merchant[2] ?? "")) : null,
        category: plain(tag(item, "category")),
        link: plain(tag(item, "link")),
        posted: Date.parse(plain(tag(item, "pubDate"))) || null,
        detail: plain(tag(item, "description")).slice(0, 300),
        barcode: null,
      };
    })
    .filter((p) => p.title && p.link);
}

/** A shop page's schema.org product list to posts. */
export function parseProductList(html, shop, source) {
  const posts = [];
  const blocks = String(html).matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  );
  for (const [, json] of blocks) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }
    if (data?.["@type"] !== "ItemList" || !Array.isArray(data.itemListElement)) continue;
    for (const p of data.itemListElement) {
      if (p?.["@type"] !== "Product" || !p.name || !p.url) continue;
      const sku = String(p.sku ?? "");
      posts.push({
        source,
        title: decode(p.name),
        shop,
        price: toPence(p.offers?.price),
        category: "",
        link: p.url,
        posted: null,
        detail: decode(p.description ?? "").slice(0, 200),
        barcode: /^\d{8,14}$/.test(sku) ? sku : null,
      });
    }
  }
  return posts;
}

export function screenPrompt(posts) {
  const lines = posts.map((p, i) => {
    const price = p.price === null ? "no price" : "£" + (p.price / 100).toFixed(2);
    return `${i + 1}. [${p.shop || "unknown shop"} ${price}] [${p.category}] ${p.title} :: ${p.detail}`;
  });
  return (
    "You screen UK deal posts for retail arbitrage resellers who buy cheap and resell on eBay or Vinted. " +
    'For each numbered post return JSON {"items":[{"n":int,"item":str,"brand":str|null,' +
    '"where":"in-store"|"online"|"both"|"unknown","resale_candidate":bool,' +
    '"why":str (at most 12 words),"sold_search":str (an eBay sold-listings search, or "" when not a candidate)}]}. ' +
    "Resale candidates are branded physical goods with real secondhand demand. Not candidates: food, drink, " +
    "digital goods, rentals, services, subscriptions, memberships, novelty homeware and cheap unbranded items. " +
    'Say "in-store" or "both" only when the post mentions a shop, in store, instore or click and collect; ' +
    'online-only shops such as Amazon, eBay, AliExpress and Very are "online". Otherwise say "unknown".\n\n' +
    lines.join("\n")
  );
}

export const soldLink = (q) =>
  "https://www.ebay.co.uk/sch/i.html?_nkw=" +
  encodeURIComponent(q) +
  "&LH_Sold=1&LH_Complete=1";

const WHERE = new Set(["in-store", "online", "both", "unknown"]);
const short = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** The model's answer joined back to the posts. Only candidates are kept. */
export function readScreen(answer, posts) {
  const items = Array.isArray(answer?.items) ? answer.items : [];
  const seen = new Set();
  const finds = [];
  for (const a of items) {
    const n = Number(a?.n);
    if (!Number.isInteger(n) || n < 1 || n > posts.length || seen.has(n)) continue;
    seen.add(n);
    if (a.resale_candidate !== true) continue;
    const post = posts[n - 1];
    const search = short(a.sold_search, 120) || short(a.item, 120) || post.title.slice(0, 120);
    finds.push({
      id: post.source + ":" + post.link,
      source: post.source,
      item: short(a.item, 140) || post.title.slice(0, 140),
      brand: short(a.brand, 60) || null,
      shop: post.shop,
      price: post.price,
      where: WHERE.has(a.where) ? a.where : "unknown",
      why: short(a.why, 120),
      link: post.link,
      posted: post.posted,
      barcode: post.barcode,
      soldSearch: search,
      soldLink: soldLink(search),
    });
  }
  return finds;
}

export function runCost(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  return ((usage.input_tokens ?? 0) * p.in + (usage.output_tokens ?? 0) * p.out) / 1e6;
}

async function askModel({ prompt, model, key, fetchImpl }) {
  const body = { model, input: prompt, text: { format: { type: "json_object" } } };
  if (model.startsWith("gpt-5")) body.reasoning = { effort: "minimal" };
  const res = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Error(`The AI model answered ${res.status}`);
  const data = await res.json();
  const text = (data.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? "")
    .join("");
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    throw Error("The AI model's answer was not readable JSON");
  }
  return { answer, usage: data.usage ?? null };
}

const BATCH = 30;
const MAX_POSTS = 120;

/**
 * Read every source, sort the posts with the AI model and return a run.
 * A source that fails is recorded and skipped; the run still saves.
 */
export async function findDeals({
  key = process.env.OPENAI_API_KEY,
  model = process.env.BOUNTY_FINDER_MODEL || DEFAULT_MODEL,
  sources = SOURCES,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (!key) throw Error("Set OPENAI_API_KEY to run the deal finder");
  const report = [];
  const posts = [];
  for (const s of sources) {
    try {
      const res = await fetchImpl(s.url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw Error(`answered ${res.status}`);
      const text = await res.text();
      const got = s.kind === "rss" ? parseRss(text, s.id) : parseProductList(text, "B&Q", s.id);
      posts.push(...got);
      report.push({ id: s.id, name: s.name, url: s.url, ok: true, posts: got.length, testOnly: s.testOnly });
    } catch (e) {
      report.push({ id: s.id, name: s.name, url: s.url, ok: false, error: e.message, posts: 0, testOnly: s.testOnly });
    }
  }
  const take = posts.slice(0, MAX_POSTS);
  const finds = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (let i = 0; i < take.length; i += BATCH) {
    const batch = take.slice(i, i + BATCH);
    const r = await askModel({ prompt: screenPrompt(batch), model, key, fetchImpl });
    finds.push(...readScreen(r.answer, batch));
    usage.input_tokens += r.usage?.input_tokens ?? 0;
    usage.output_tokens += r.usage?.output_tokens ?? 0;
  }
  return {
    ranAt: now(),
    model,
    sources: report,
    screened: take.length,
    finds,
    usage,
    costUsd: runCost(model, usage),
  };
}

const file = () => join(dataDir(), "finds.json");

export async function saveFinds(run) {
  await mkdir(dataDir(), { recursive: true });
  const tmp = file() + ".tmp";
  await writeFile(tmp, JSON.stringify(run, null, 1));
  await rename(tmp, file());
}

/** The latest saved run, or an empty one when the finder has not run. */
export async function latestFinds() {
  try {
    return JSON.parse(await readFile(file(), "utf8"));
  } catch {
    return { ranAt: null, model: null, sources: [], screened: 0, finds: [], usage: null, costUsd: null };
  }
}
