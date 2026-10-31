import { useState } from "react";
export type Evidence = {
  provider: string;
  source_id: string;
  title: string;
  kind: string;
  barcode: string | null;
  variant: string | null;
  price: number;
  observed: string | null;
  retailer: string | null;
  imported: string;
};
const pounds = (v: number) =>
  (v / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" });
export function ResearchCalculator({ rows }: { rows: Evidence[] }) {
  const [id, select] = useState(""),
    [checked, check] = useState<string[]>([]),
    [price, edit] = useState({
      postage: 3,
      fees: 2,
      packing: 0.5,
      travel: 0,
      returns: 0.5,
      minutes: 35,
    });
  const offers = rows.filter((r) => r.kind === "Retail offer" && r.barcode);
  const key = (r: Evidence) => JSON.stringify([r.provider, r.source_id]);
  const offer = offers.find((r) => key(r) === id);
  const sales = offer
    ? rows.filter(
        (r) =>
          r.kind === "Reported completed sale" && r.barcode === offer.barcode,
      )
    : [];
  const prices = sales
    .filter((r) => checked.includes(key(r)))
    .map((r) => r.price)
    .sort((a, b) => a - b);
  const median = prices[Math.floor((prices.length - 1) / 2)];
  const costs = offer
    ? offer.price +
      Math.round(
        100 *
          (price.postage +
            price.fees +
            price.packing +
            price.travel +
            price.returns),
      )
    : 0;
  return (
    <article>
      <h2>Research a single-unit trip</h2>
      <p>
        Choose a retail offer, then confirm each sale has the same size, pack
        and condition. This estimate does not confirm stock or issue a bounty.
      </p>
      <label>
        Acquisition offer
        <select
          value={id}
          onChange={(e) => {
            select(e.target.value);
            check([]);
          }}
        >
          <option value="">Choose a barcoded offer</option>
          {offers.map((r) => (
            <option key={key(r)} value={key(r)}>
              {r.title} · {pounds(r.price)}
            </option>
          ))}
        </select>
      </label>
      {offer && (
        <>
          <small>
            {offer.barcode} · Source date {offer.observed || "unknown"}
          </small>
          {sales.length === 0 && (
            <p>
              No reported sales with this barcode in the current research
              window.
            </p>
          )}
          {sales.map((r) => (
            <label key={key(r)}>
              <span>
                <input
                  type="checkbox"
                  checked={checked.includes(key(r))}
                  onChange={(e) =>
                    check(
                      e.target.checked
                        ? [...checked, key(r)]
                        : checked.filter((x) => x !== key(r)),
                    )
                  }
                />{" "}
                Exact variant confirmed · {r.variant} · {r.observed} ·{" "}
                {pounds(r.price)}
              </span>
            </label>
          ))}
          {Object.entries(price).map(([k, v]) => (
            <label key={k}>
              {k === "minutes" ? "Active working minutes" : k + " (£ per trip)"}
              <input
                type="number"
                step={k === "minutes" ? 1 : 0.01}
                min={k === "minutes" ? 1 : 0}
                value={v}
                onChange={(e) =>
                  edit({
                    ...price,
                    [k]: Math.max(
                      k === "minutes" ? 1 : 0,
                      Number(e.target.value),
                    ),
                  })
                }
              />
            </label>
          ))}
          {prices.length > 0 && (
            <p>
              Based on {prices.length} selected sale(s), lower median{" "}
              {pounds(median)}. Estimated contribution{" "}
              <b>{pounds(median - costs)}</b>or{" "}
              {pounds(((median - costs) * 60) / price.minutes)} per active hour.
              Costs and working time are your assumptions.
            </p>
          )}
        </>
      )}
    </article>
  );
}
