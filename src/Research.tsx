import { useEffect, useState } from "react";
type Source = { name: string; kind: string; status: string };
import { ResearchCalculator, type Evidence as Row } from "./ResearchCalculator";
export default function Research() {
  const [data, D] = useState<{ sources: Source[]; rows: Row[] }>({
      sources: [],
      rows: [],
    }),
    [error, E] = useState(""),
    [filter, F] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/research", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error("Could not load research");
        D(await r.json());
      })
      .catch((e) => {
        if (!controller.signal.aborted) E(e.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <section>
      <small>RESEARCH DESK / SOURCE REGISTER</small>
      <h2>Connected sources</h2>
      {error && <p role="alert">{error}</p>}
      {data.sources.map((s) => (
        <div className="row" key={s.name}>
          <span>
            <b>{s.name}</b>
            <small>{s.kind}</small>
          </span>
          {s.status}
        </div>
      ))}
      <ResearchCalculator rows={data.rows} />
      <h2>Evidence register</h2>
      <label>
        Filter by barcode or title
        <input value={filter} onChange={(e) => F(e.target.value)} />
      </label>
      <p>
        Showing the most recent 200 imported records. Compare the exact variant
        and pack before using a sale. Source dates can differ from import dates.
      </p>
      {!data.rows.length && (
        <p>
          No commercial or manual evidence imported yet. Public UK receipt
          observations appear in Observations.
        </p>
      )}
      {data.rows
        .filter((r) =>
          (r.title + " " + (r.barcode || ""))
            .toLowerCase()
            .includes(filter.toLowerCase()),
        )
        .map((r) => (
          <div className="row" key={r.provider + r.source_id}>
            <span>
              <small>
                {r.provider} · {r.kind}
              </small>
              <b>{r.title}</b>
              {r.variant} {r.barcode}
              <small>
                {r.retailer} · Source date {r.observed || "unknown"} · Imported{" "}
                {r.imported} UTC
              </small>
            </span>
            <strong>£{(r.price / 100).toFixed(2)}</strong>
          </div>
        ))}
    </section>
  );
}
