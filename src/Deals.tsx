import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, loadProfile, money, percent } from "./api";
import { ItemTile, byMode } from "./Planner";
import "./Deals.css";

// The first screen: every find with its shop price, what it sells for and
// the profit a unit after fees and postage. Nothing needs setting up. Travel
// is an added layer: it shows on a card once the member has said how they
// travel, and it never hides, blocks or reorders a deal.

type Travel = { added: boolean; mode: string | null; miles: number | null; cost: number | null; minutes: number | null };
export type Deal = {
  sku: string;
  name: string;
  variant: string | null;
  category: string;
  shop: string;
  area: string | null;
  miles: number | null;
  buy: number;
  salePrice: number | null;
  sales: number[];
  costs: { fees: number; returns: number; postage: number; packaging: number } | null;
  feeRate: number;
  feeFixed: number;
  returnsRate: number;
  unitProfit: number | null;
  returnOnCost: number | null;
  underSale: number | null;
  weight: number | null;
  stock: number | null;
  competingListings: number | null;
  storageNeeds: string | null;
  meetsThresholds: boolean;
  notes: string[];
  travel: Travel;
  sample: boolean;
};
type DealsResponse = {
  deals: Deal[];
  assumptions: { feeRate: number; feeFixed: number; returnsRate: number; ownFees: boolean };
  rules: { minUnitProfit: number; minReturn: number };
};

/**
 * The optional extras the member has already saved in the trip planner, if
 * any: how they travel and their own selling fees. Nothing is sent when they
 * have never opened it, so a first visit needs no setup at all.
 */
function savedExtras(): Record<string, unknown> {
  let saved = false;
  try {
    saved = localStorage.getItem("bounty-profile") !== null;
  } catch {
    saved = false;
  }
  if (!saved) return {};
  const p = loadProfile();
  const fare = typeof p.fare === "number" && Number.isFinite(p.fare) ? Math.round(p.fare * 100) : null;
  return {
    transport: p.transport,
    fare,
    fareFree: p.fareFree === true,
    perMile: Number.isFinite(p.perMile) ? Math.round(p.perMile) : undefined,
    extra: Number.isFinite(p.extra) ? Math.round(p.extra * 100) : undefined,
    feeRate: Number.isFinite(p.feeRate) ? p.feeRate : undefined,
    feeFixed: Number.isFinite(p.feeFixed) ? Math.round(p.feeFixed) : undefined,
    returnsRate: Number.isFinite(p.returnsRate) ? p.returnsRate : undefined,
  };
}

type SortKey = "profit" | "discount" | "cheap" | "near";
const SORTS: [SortKey, string][] = [
  ["profit", "Biggest profit"],
  ["discount", "Biggest discount"],
  ["cheap", "Cheapest"],
  ["near", "Nearest"],
];
/** The deals in the chosen order. Biggest profit keeps the server's order; an unknown figure sorts last. */
function sortDeals(list: Deal[], key: SortKey) {
  if (key === "profit") return list;
  const value = (d: Deal) =>
    key === "discount" ? d.underSale : key === "cheap" ? -d.buy : d.miles === null ? null : -d.miles;
  return [...list].sort((a, b) => (value(b) ?? -Infinity) - (value(a) ?? -Infinity));
}
const CATEGORY_LABEL: Record<string, string> = { clothing: "Clothing", general: "Home and general" };

/** One plain line about the trip to the shop, or that travel is not added. */
function travelText(t: Travel) {
  if (!t.added || !t.mode) return "Travel not added";
  if (t.cost === null) return `Travel ${byMode(t.mode)}: add your fare`;
  const time = t.minutes ? `, ${t.minutes} min` : "";
  return t.cost === 0 ? `No travel cost ${byMode(t.mode)}${time}` : `Trip ${byMode(t.mode)}: ${money(t.cost)}${time}`;
}

/** Short labels for a card. The full wording is in the deal's own panel. */
function chips(d: Deal, rules: DealsResponse["rules"]) {
  const out: string[] = [];
  if (d.unitProfit !== null && d.unitProfit < rules.minUnitProfit) out.push(`Under ${money(rules.minUnitProfit)} a unit`);
  if (d.weight !== null && d.weight >= 2) out.push(`Heavy, ${d.weight} kg`);
  if (d.storageNeeds) out.push("Bulky");
  if (d.stock !== null) out.push(`${d.stock} on the shelf`);
  return out;
}

export default function Deals() {
  const [result, setResult] = useState<DealsResponse | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("");
  const [sort, setSort] = useState<SortKey>("profit");
  const [open, setOpen] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    api<DealsResponse>("deals", savedExtras())
      .then((r) => active && (setResult(r), setError("")))
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, []);

  const all = result?.deals ?? [];
  const cats = [...new Set(all.map((d) => d.category))].sort();
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (d: Deal) => {
    const text = [d.name, d.variant, d.shop, CATEGORY_LABEL[d.category] ?? d.category].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const deals = sortDeals(
    all.filter((d) => (!cat || d.category === cat) && matches(d)),
    sort,
  );
  const deal = all.find((d) => d.sku === open) ?? null;
  const close = useCallback(() => {
    setOpen(null);
    opener.current?.focus();
  }, []);

  return (
    <div className="deals">
      <div className="deals-search" role="search">
        <label className="deals-sr" htmlFor="deals-q">
          Search deals
        </label>
        <input
          id="deals-q"
          type="search"
          value={query}
          placeholder="Search deals, for example jacket or Tesco"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {cats.length > 1 && (
        <div className="deals-cats" role="group" aria-label="Category">
          {["", ...cats].map((c) => (
            <button key={c || "all"} type="button" aria-pressed={cat === c} onClick={() => setCat(c)}>
              {c ? (CATEGORY_LABEL[c] ?? c) : "All"}
            </button>
          ))}
        </div>
      )}
      {all.length > 1 && (
        <div className="deals-sorts" role="group" aria-label="Sort the deals">
          <span className="muted">Sort by</span>
          {SORTS.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={sort === key} onClick={() => setSort(key)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {all.some((d) => d.sample) && (
        <p className="notice deals-sample">
          <strong>Sample data.</strong> Illustrative Leeds offers with modelled sales, so nothing here is a
          buy alert yet.
        </p>
      )}
      {error && (
        <p role="alert" className="notice warn">
          {error}
        </p>
      )}
      {!result && !error && <p className="muted">Loading deals…</p>}
      {result && !deals.length && (
        <p className="muted">
          {all.length ? "No deal matches this search. Clear it or choose All to see the others." : "No deals yet."}
        </p>
      )}
      <div className="deals-grid">
        {result &&
          deals.map((d) => (
            <DealCard
              key={d.sku}
              deal={d}
              chips={chips(d, result.rules)}
              onOpen={(el) => {
                opener.current = el;
                setOpen(d.sku);
              }}
            />
          ))}
        {result && <Sharper />}
      </div>
      {result && (
        <p className="muted deals-fees">
          {result.assumptions.ownFees ? "Profit uses your own selling fees" : "Profit uses sample selling fees"}:{" "}
          {percent(result.assumptions.feeRate)} plus {money(result.assumptions.feeFixed)} a sale, and a{" "}
          {percent(result.assumptions.returnsRate)} returns allowance (clothing at least 15%). Change them in the trip
          planner.
        </p>
      )}
      {deal && result && <DealPanel deal={deal} rules={result.rules} onClose={close} />}
    </div>
  );
}

function DealCard({ deal: d, chips, onOpen }: { deal: Deal; chips: string[]; onOpen: (el: HTMLElement) => void }) {
  const small = d.unitProfit === null || !d.meetsThresholds;
  const range = d.sales.length ? `${money(d.sales[0])} to ${money(d.sales[d.sales.length - 1])}` : "";
  return (
    <button type="button" className="deals-card" onClick={(e) => onOpen(e.currentTarget)}>
      <span className="deals-picture">
        <ItemTile sku={d.sku} category={d.category} />
        {d.underSale !== null && (
          <span className="deals-ribbon">
            {d.underSale}% under<span className="deals-sr"> what it sells for</span>
          </span>
        )}
        {d.sample && <span className="badge sample deals-tag">Sample</span>}
      </span>
      <span className="deals-body">
        <span className="deals-item">
          <b>{d.name}</b>
          <em>
            {d.variant ? d.variant + " · " : ""}
            {d.shop}
            {d.miles !== null ? `, ${d.miles} mi` : ""}
          </em>
        </span>
        <span className="deals-prices">
          <span className="deals-shop">
            <small>Shop price</small>
            <b>{money(d.buy)}</b>
          </span>
          <span className="deals-arrow" aria-hidden="true">
            →
          </span>
          <span className="deals-sold">
            <small>Sells for</small>
            <b>{d.salePrice === null ? "not known" : money(d.salePrice)}</b>
          </span>
        </span>
        <span className="deals-evidence">
          {d.sales.length
            ? `From ${d.sales.length} completed ${d.sales.length === 1 ? "sale" : "sales"}${d.sales.length > 1 ? ", " + range : ""}`
            : "No completed sales yet"}
        </span>
        <span className={"deals-profit" + (small ? " small" : "")}>
          <b>{d.unitProfit === null ? "Not known yet" : money(d.unitProfit)}</b>
          <span>profit a unit after fees and postage</span>
        </span>
        <span className="deals-chips">
          <span className="deals-chip travel">{travelText(d.travel)}</span>
          {chips.map((c) => (
            <span key={c} className="deals-chip">
              {c}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}

/** The optional extras, offered once beside the deals and never required. */
function Sharper() {
  return (
    <div className="deals-sharper" role="group" aria-label="Optional extras">
      <div>
        <h2>Want sharper numbers?</h2>
        <p>All optional. Add any of these and the cards take them into account.</p>
      </div>
      <a href="#Planner">
        How you get there <small>bus fare, car or walking</small>
      </a>
      <a href="#Planner">
        Cash, carrying and your own fees <small>for a full trip plan</small>
      </a>
      <a href="#Goals">
        A goal <small>what the money is for</small>
      </a>
    </div>
  );
}

/** The working behind one deal, in a panel over the page. */
function DealPanel({ deal: d, rules, onClose }: { deal: Deal; rules: DealsResponse["rules"]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const c = d.costs;
  const t = d.travel;
  return (
    <>
      <div className="deals-backdrop" onClick={onClose} />
      <div ref={ref} className="deals-panel" role="dialog" aria-modal="true" aria-label={d.name} tabIndex={-1}>
        <div className="deals-panel-head">
          <ItemTile sku={d.sku} category={d.category} />
          <div>
            <h2>{d.name}</h2>
            <span className="muted">
              {d.variant ? d.variant + " · " : ""}
              {d.shop}
              {d.miles !== null ? `, ${d.miles} mi` : ""}
            </span>
          </div>
          <button type="button" className="deals-close" onClick={onClose}>
            Close
          </button>
        </div>

        {c && d.salePrice !== null && d.unitProfit !== null ? (
          <table className="deals-sum">
            <caption className="deals-sr">How the profit a unit is worked out</caption>
            <tbody>
              <tr>
                <th scope="row">Sells for (the lower middle completed sale)</th>
                <td>{money(d.salePrice)}</td>
              </tr>
              <tr>
                <th scope="row">Shop price</th>
                <td>−{money(d.buy)}</td>
              </tr>
              <tr>
                <th scope="row">
                  Marketplace fees ({percent(d.feeRate)} plus {money(d.feeFixed)})
                </th>
                <td>−{money(c.fees)}</td>
              </tr>
              <tr>
                <th scope="row">Returns allowance ({percent(d.returnsRate)})</th>
                <td>−{money(c.returns)}</td>
              </tr>
              <tr>
                <th scope="row">Postage</th>
                <td>−{money(c.postage)}</td>
              </tr>
              <tr>
                <th scope="row">Packaging</th>
                <td>−{money(c.packaging)}</td>
              </tr>
              <tr className="total">
                <th scope="row">Profit a unit</th>
                <td>{money(d.unitProfit)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="notice">The profit is not known yet: {d.notes.join("; ")}.</p>
        )}
        {d.returnOnCost !== null && (
          <p className="muted">
            That is a {percent(d.returnOnCost)} return on the shop price. The usual bar is {money(rules.minUnitProfit)} a
            unit and a {percent(rules.minReturn)} return.
          </p>
        )}

        <div className="deals-box">
          <h3>What it sold for</h3>
          {d.sales.length ? (
            <span className="deals-sales">
              {d.sales.map((s, i) => (
                <span key={i}>{money(s)}</span>
              ))}
            </span>
          ) : (
            <span>No completed sales yet.</span>
          )}
          <span>Completed sales of this exact item only. Listings that have not sold are never counted.</span>
        </div>

        <div className="deals-box">
          <h3>Getting there</h3>
          <span>
            {d.miles !== null ? `${d.miles} miles from the centre of ${d.area ?? "your area"}. ` : ""}
            {t.added && t.mode
              ? t.cost === null
                ? `You travel ${byMode(t.mode)}: add your return fare in the trip planner to see the cost.`
                : `A return trip ${byMode(t.mode)} costs ${t.cost === 0 ? "nothing" : money(t.cost)} and takes about ${t.minutes} minutes. It is shared by every unit you buy.`
              : "Add how you travel in the trip planner to see the trip cost."}
          </span>
          <span>The deal stays listed either way.</span>
        </div>

        {(d.notes.length > 0 || d.storageNeeds) && (
          <div className="deals-box">
            <h3>Worth knowing</h3>
            <ul>
              {d.notes.map((n) => (
                <li key={n}>{n}.</li>
              ))}
              {d.storageNeeds && <li>{d.storageNeeds}.</li>}
            </ul>
          </div>
        )}

        <div className="deals-actions">
          <a className="deals-cta" href="#Planner">
            Plan a trip for this
          </a>
          <a className="deals-ghost" href="#Bounties">
            See bounties
          </a>
        </div>
      </div>
    </>
  );
}
