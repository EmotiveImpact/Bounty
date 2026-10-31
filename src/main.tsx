import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import Planner from "./Planner";
import Goals from "./Goals";
import Research from "./Research";
import Bounties from "./Bounties";
import Ledger from "./Ledger";
import Sources from "./Sources";

const TABS = {
  Planner: {
    title: "Bounty planner",
    lead: "Find the trips that fit your cash, time and carrying capacity.",
    view: Planner,
  },
  Goals: {
    title: "Goals and baskets",
    lead: "Plan against your dispatch days, storage, cash date and monthly target.",
    view: Goals,
  },
  Research: {
    title: "Source research",
    lead: "Match an acquisition offer to exact sold evidence before planning a purchase.",
    view: Research,
  },
  Bounties: {
    title: "Bounties",
    lead: "Share checked opportunities without flooding the store or the market.",
    view: Bounties,
  },
  Ledger: {
    title: "Outcome ledger",
    lead: "Reconcile receipts, sales, payouts, costs and time against the prediction.",
    view: Ledger,
  },
  Sources: {
    title: "Sources and observations",
    lead: "Source readiness, import history and dated UK price observations.",
    view: Sources,
  },
} as const;
type Tab = keyof typeof TABS;

function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const hash = decodeURIComponent(location.hash.slice(1));
    return hash in TABS ? (hash as Tab) : "Planner";
  });
  // Follow in-page links such as the Planner's "Open the basket plan in Goals".
  useEffect(() => {
    const follow = () => {
      const hash = decodeURIComponent(location.hash.slice(1));
      if (hash in TABS) setTab(hash as Tab);
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const View = TABS[tab].view;
  return (
    <>
      <header>
        <strong>◈ &nbsp; Bounty</strong>
        <span>FIELD DESK &nbsp; / &nbsp; UK</span>
      </header>
      <main>
        <small>OPERATIONS &nbsp; / &nbsp; PERSONAL WORKSPACE</small>
        <h1>{TABS[tab].title}</h1>
        <p>{TABS[tab].lead}</p>
        <nav>
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button
              key={t}
              aria-pressed={t === tab}
              onClick={() => {
                setTab(t);
                history.replaceState(null, "", "#" + t);
              }}
            >
              {t}
            </button>
          ))}
        </nav>
        <React.Fragment key={tab}>
          <View />
        </React.Fragment>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
