import { parse } from "csv-parse/sync";

export const sourceInfo = [
  ["Open Prices", "Retail observations", "public", null],
  ["Hobnight", "Retail catalogue", "credential", "HOBNIGHT_API_KEY"],
  ["Keepa", "Amazon UK offer history", "credential", "KEEPA_API_KEY"],
  ["Awin", "Retail feed", "file", null],
  ["eBay Browse", "Active competition", "credential", "EBAY_ACCESS_TOKEN"],
  ["eBay Product Research", "Manually recorded completed sales", "file", null],
];
export function status(env = process.env) {
  return sourceInfo.map(([name, kind, mode, key]) => ({
    name,
    kind,
    status:
      mode === "credential"
        ? env[key]
          ? "Credential configured"
          : "Needs " + key
        : mode === "file"
          ? "Local import"
          : "Public API",
  }));
}
const pence = (value) =>
  typeof value === "number" ||
  (typeof value === "string" && value.trim() !== "")
    ? Math.round(Number(value) * 100)
    : NaN;
const gbp = (value) => value === "GBP";
export function awin(text) {
  const rows = parse(text, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
  });
  if (
    rows.length &&
    !["aw_product_id", "product_name", "currency", "search_price"].every(
      (k) => k in rows[0],
    )
  )
    throw Error("Invalid Awin feed columns");
  return rows
    .filter((r) => gbp(r.currency))
    .map((r) => ({
      id: r.aw_product_id,
      title: r.product_name,
      barcode: r.ean || r.gtin || null,
      price: pence(r.search_price),
      date: r.last_updated || null,
      shop: r.merchant_name,
      kind: "Retail offer",
    }));
}
export function hobnight(body) {
  if (!Array.isArray(body.data)) throw Error("Unexpected Hobnight response");
  return body.data
    .filter((r) => gbp(r.currency))
    .map((r) => ({
      id: String(r.id),
      title: r.name,
      barcode: r.gtin,
      price: pence(r.price),
      date: r.last_scraped_at,
      shop: r.supermarket?.name,
      kind: "Retail offer",
    }));
}
export function keepa(body) {
  if (!Array.isArray(body.products)) throw Error("Unexpected Keepa response");
  return body.products.flatMap((p) => {
    const series = p.csv?.[0] || [],
      rows = [];
    for (let i = 0; i + 1 < series.length; i += 2) {
      if (series[i + 1] > 0)
        rows.push({
          id: p.asin + "@" + series[i],
          title: p.title,
          barcode: p.eanList?.[0],
          price: series[i + 1],
          date: new Date((series[i] + 21564000) * 60000).toISOString(),
          shop: "Amazon UK",
          kind: "Amazon offer history",
        });
    }
    return rows;
  });
}
export function ebayBrowse(body) {
  if (!Array.isArray(body.itemSummaries) && body.total !== 0)
    throw Error("Unexpected eBay Browse response");
  return (body.itemSummaries || [])
    .filter((r) => gbp(r.price?.currency))
    .map((r) => ({
      id: r.itemId,
      title: r.title,
      price: pence(r.price.value),
      date: null,
      shop: "eBay UK",
      kind: "Active asking price",
    }));
}
export function sold(input) {
  if (!Array.isArray(input)) throw Error("Expected a JSON array");
  return input.map((r) => {
    if (
      !r.reference ||
      !r.variant ||
      !r.title ||
      !/^\d{8}$|^\d{12,14}$/.test(r.barcode) ||
      !gbp(r.currency) ||
      !Number.isSafeInteger(r.totalPence) ||
      r.totalPence <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.soldDate) ||
      !Number.isFinite(Date.parse(r.soldDate)) ||
      new Date(r.soldDate).toISOString().slice(0, 10) !== r.soldDate ||
      Date.parse(r.soldDate) > Date.now()
    )
      throw Error("Invalid manual sale evidence");
    return {
      id: r.reference,
      title: r.title,
      barcode: r.barcode,
      variant: r.variant,
      price: r.totalPence,
      date: r.soldDate,
      shop: "eBay UK",
      kind: "Reported completed sale",
    };
  });
}
export async function lookup(
  provider,
  query,
  env = process.env,
  request = fetch,
) {
  const specs = {
    hobnight: [
      "HOBNIGHT_API_KEY",
      "https://api.hobnight.com/api/products",
      hobnight,
    ],
    keepa: ["KEEPA_API_KEY", "https://api.keepa.com/product", keepa],
    ebay: [
      "EBAY_ACCESS_TOKEN",
      "https://api.ebay.com/buy/browse/v1/item_summary/search",
      ebayBrowse,
    ],
  };
  const [key, endpoint, normalise] = specs[provider];
  if (!env[key]) throw Error("Missing " + key);
  if (!query?.trim()) throw Error("Supply a search term or ASIN");
  const url = new URL(endpoint),
    headers = {};
  if (provider === "keepa") {
    if (!/^[A-Z0-9]{10}$/.test(query))
      throw Error("Supply a ten-character ASIN");
    url.search = new URLSearchParams({
      key: env[key],
      domain: "2",
      asin: query,
      history: "1",
      days: "90",
    });
  } else {
    url.searchParams.set("q", query);
    headers.Authorization = "Bearer " + env[key];
    if (provider === "hobnight") url.searchParams.set("region", "uk");
    else headers["X-EBAY-C-MARKETPLACE-ID"] = "EBAY_GB";
  }
  const res = await request(url, {
    headers,
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!res.ok)
    throw Error(provider + " request failed (HTTP " + res.status + ")");
  return normalise(await res.json());
}
