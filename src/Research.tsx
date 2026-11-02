import { useEffect, useState } from "react";
import { api, dateTime, money } from "./api";
import {
  ResearchCalculator,
  attributesText,
  isSampleRow,
  type AuditDraft,
  type EvidenceRow,
} from "./ResearchCalculator";
import "./Research.css";
import "./proto/research.css";

// Display only: the colour each evidence class is drawn in (style.css).
const EV_ROW: Record<string, string> = {
  "Retail offer": "ev-row-retail",
  "Reported completed sale": "ev-row-sold",
  "Active asking price": "ev-row-asking",
  "Amazon offer history": "ev-row-retail",
};

// Evidence classes from server/contract.mjs. Each is shown on its own tab and
// never pooled: they answer different questions.
const KINDS = [
  {
    kind: "Retail offer",
    tab: "Retail offers",
    price: "offer price",
    note: "What it costs to acquire, from feeds and catalogues. A feed or online catalogue never establishes branch stock.",
  },
  {
    kind: "Reported completed sale",
    tab: "Completed sales",
    price: "realised total incl. buyer postage",
    note: "What buyers actually paid, including buyer postage. Self-reported research records; only confirmed exact matches enter a sold sample.",
  },
  {
    kind: "Active asking price",
    tab: "Asking prices",
    price: "asking price",
    note: "What competing sellers hope to get. Resale competition only: never used as a sale price.",
  },
  {
    kind: "Amazon offer history",
    tab: "Amazon history",
    price: "Amazon price",
    note: "Amazon as seller price history. Research context only: not a sale and not a local offer.",
  },
] as const;
const PAGE = 50;

/** Research for members: the six-step check. The evidence register and the
    audit sign-off are operator tools and live on the Admin page. */
export default function Research({ onAuditDraft }: { onAuditDraft?: (d: AuditDraft) => void } = {}) {
  return (
    <section className="research">
      <ResearchCalculator onAuditDraft={onAuditDraft} />
    </section>
  );
}

/** Imported records by evidence class (Admin). */
export function EvidenceRegister() {
  const [kind, setKind] = useState<string>(KINDS[0].kind);
  const [filter, setFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ rows: EvidenceRow[]; total: number }>({
    rows: [],
    total: 0,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        kind,
        limit: String(PAGE),
        offset: String(offset),
      });
      if (filter.trim()) params.set("q", filter.trim());
      api<{ rows: EvidenceRow[]; total: number }>("evidence?" + params)
        .then((d) => {
          if (!active) return;
          setData(d);
          setError("");
        })
        .catch((e: Error) => active && setError(e.message))
        .finally(() => active && setLoading(false));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [kind, filter, offset]);

  const current = KINDS.find((k) => k.kind === kind) ?? KINDS[0];
  const last = Math.min(offset + data.rows.length, data.total);
  return (
    <section className="research">
      <article>
        <small>Research desk</small>
        <h2>Evidence register</h2>
        <p>
          Imported records by evidence class. Source dates can differ from import
          dates. Open Prices observations are kept separately under Sources.
        </p>
        <nav className="kind-tabs" aria-label="Evidence class">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              aria-pressed={k.kind === kind}
              onClick={() => {
                setKind(k.kind);
                setOffset(0);
              }}
            >
              {k.tab}
            </button>
          ))}
        </nav>
        <p className="muted">{current.note}</p>
        <label>
          Filter by barcode or title
          <input
            value={filter}
            maxLength={200}
            onChange={(e) => {
              setFilter(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        {!error && !loading && data.total === 0 && (
          <p>
            No {current.tab.toLowerCase()} imported
            {filter.trim() ? " match this filter" : " yet"}.
          </p>
        )}
        {data.rows.map((r) => (
          <div className={"row " + (EV_ROW[r.kind] ?? "")} key={r.provider + "|" + r.source_id}>
            <span>
              <small>
                {isSampleRow(r) && <span className="badge sample">Sample</span>}
                {r.provider} · {r.kind}
                {r.licence ? " · " + r.licence : ""}
              </small>
              <b>{r.title}</b>
              <em>
                {r.barcode ? "Barcode " + r.barcode : "No barcode"}
                {r.variant ? " · " + r.variant : ""}
              </em>
              <em>{attributesText(r)}</em>
              <small>
                {r.kind === "Reported completed sale" || r.kind === "Active asking price"
                  ? "Seller " + (r.seller || "unknown")
                  : (r.retailer || "Retailer unknown") + (r.location ? " · " + r.location : "")}
                {" · "}Source date {dateTime(r.observed)} · Imported {dateTime(r.imported)}
              </small>
            </span>
            <span>
              <b>{money(r.price)}</b>
              <small>{current.price}</small>
              {r.kind === "Active asking price" && (
                <small>
                  {r.shipping === null ? "shipping unknown" : "+ " + money(r.shipping) + " shipping"}
                </small>
              )}
            </span>
          </div>
        ))}
        {data.total > 0 && (
          <div className="pager">
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Newer
            </button>
            <span className="muted">
              {offset + 1} to {last} of {data.total}
            </span>
            <button type="button" disabled={last >= data.total} onClick={() => setOffset(offset + PAGE)}>
              Older
            </button>
          </div>
        )}
      </article>
    </section>
  );
}
