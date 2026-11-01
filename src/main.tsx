import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import Planner from "./Planner";
import Goals from "./Goals";
import Research from "./Research";
import { clearResearchDraft } from "./ResearchCalculator";
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

// The tab named in the address, or null. Only the tabs themselves count
// (never inherited names such as "constructor"), and a malformed escape in
// the hash is ignored rather than breaking the page.
function tabFromHash(): Tab | null {
  let hash: string;
  try {
    hash = decodeURIComponent(location.hash.slice(1));
  } catch {
    return null;
  }
  return Object.hasOwn(TABS, hash) ? (hash as Tab) : null;
}

// Keeps a failure in one tab from blanking the whole page. onError lets a
// tab forget state it saved for the session (the Research draft), so a
// reload starts it afresh instead of failing the same way again.
class TabBoundary extends React.Component<
  { children: React.ReactNode; onError?: () => void },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch() {
    this.props.onError?.();
  }
  render() {
    if (this.state.error)
      return (
        <p role="alert">
          This tab hit an error and stopped ({this.state.error}). Reload the page, or choose another tab.
        </p>
      );
    return this.props.children;
  }
}

// Tabs that keep a session draft to forget when they fail.
const ON_ERROR: Partial<Record<string, () => void>> = { Research: clearResearchDraft };

function App() {
  const [tab, setTab] = useState<Tab>(() => tabFromHash() ?? "Planner");
  // Follow in-page links such as the Planner's "Open the basket plan in Goals".
  useEffect(() => {
    const follow = () => {
      const next = tabFromHash();
      if (next) setTab(next);
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
        <TabBoundary key={tab} onError={ON_ERROR[tab]}>
          <View />
        </TabBoundary>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
