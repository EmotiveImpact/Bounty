import { useEffect, useState } from "react";
import { api, money } from "../api";

// Leads the AI deal finder picked out from deal sites and clearance pages.
// They have not been checked against completed sales, so they sit apart from
// real deals, never show a profit, and each one links to its sold prices.

type Find = {
  id: string;
  source: string;
  item: string;
  brand: string | null;
  shop: string;
  price: number | null;
  where: "in-store" | "online" | "both" | "unknown";
  why: string;
  link: string;
  posted: number | null;
  soldLink: string;
};
type Run = {
  ranAt: number | null;
  screened: number;
  finds: Find[];
  sources: { id: string; name: string; ok: boolean; posts: number }[];
};

const WHERE: Record<Find["where"], string> = {
  "in-store": "In shop",
  online: "Online",
  both: "Shop and online",
  unknown: "",
};

function when(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export default function AiFinds() {
  const [run, setRun] = useState<Run | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    api<Run>("finds")
      .then(setRun)
      .catch(() => setRun(null));
  }, []);
  if (!run?.ranAt || run.finds.length === 0) return null;
  const read = run.sources.filter((s) => s.ok).map((s) => s.name);
  const shown = all ? run.finds : run.finds.slice(0, 8);
  return (
    <section className="sec aif" aria-labelledby="aif-h">
      <div className="sech">
        <div>
          <p className="kick">
            Found by AI · sold prices not checked yet
          </p>
          <h2 id="aif-h">Fresh from deal sites</h2>
          <p className="aif-sub">
            {run.finds.length} worth a look out of {run.screened} posts from{" "}
            {read.join(" and ")}, {when(run.ranAt)}. Check the sold price
            before you buy.
          </p>
        </div>
        {run.finds.length > 8 && (
          <button type="button" className="seeall" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `See all ${run.finds.length}`}
          </button>
        )}
      </div>
      <ul className="aif-list">
        {shown.map((f) => (
          <li key={f.id} className="aif-card">
            <div className="aif-top">
              <span className="aif-shop">{f.shop || "Shop not given"}</span>
              {WHERE[f.where] && <span className="aif-where">{WHERE[f.where]}</span>}
            </div>
            <p className="aif-item">{f.item}</p>
            <p className="aif-price">
              {f.price === null ? "Price not given" : money(f.price)}
            </p>
            {f.why && <p className="aif-why">{f.why}</p>}
            <div className="aif-acts">
              <a className="pill lime" href={f.soldLink} target="_blank" rel="noopener noreferrer">
                Check sold prices
              </a>
              <a className="pill" href={f.link} target="_blank" rel="noopener noreferrer">
                {f.source === "hotukdeals" ? "See the post" : "See it at " + f.shop}
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
