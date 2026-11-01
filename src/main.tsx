import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./look.css";
import Deals from "./Deals";
import Scan from "./Scan";
import Planner from "./Planner";
import Goals from "./Goals";
import Research from "./Research";
import { clearResearchDraft } from "./ResearchCalculator";
import Bounties from "./Bounties";
import Ledger from "./Ledger";
import Sources from "./Sources";

const TABS = {
  Deals: {
    title: "Deals near you",
    lead: "Cheap in the shop, sells for more online. The biggest profit a unit comes first, and nothing needs setting up.",
    view: Deals,
  },
  Scan: {
    title: "Scan in the shop",
    lead: "Scan or type a barcode and add the sticker price for a straight answer: buy, think or leave.",
    view: Scan,
  },
  Planner: {
    title: "Trip planner",
    lead: "Optional. Add your travel, cash and carrying limit to see which trips fit you.",
    view: Planner,
  },
  Goals: {
    title: "Money and goals",
    lead: "What you are saving or earning towards, planned against your dispatch days, storage and cash date.",
    view: Goals,
  },
  Research: {
    title: "Source research",
    lead: "Match an acquisition offer to exact sold evidence before planning a purchase.",
    view: Research,
  },
  Bounties: {
    title: "Tips",
    lead: "Shelf tips and bounties with a set number of places, so each one stays worth claiming.",
    view: Bounties,
  },
  Ledger: {
    title: "Stock and sales",
    lead: "What you bought, listed, sold and got paid, checked against what Bounty predicted.",
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
          This tab hit an error and stopped ({this.state.error}). Reload the
          page, or choose another tab.
        </p>
      );
    return this.props.children;
  }
}

// Tabs that keep a session draft to forget when they fail.
const ON_ERROR: Partial<Record<string, () => void>> = {
  Research: clearResearchDraft,
};

// Which menu the screen width gets. Phones keep the bottom bar; laptops get
// the logo-and-menu drop-down; wider screens a mini sidebar that opens over
// the page; big screens the full sidebar, docked.
type MenuMode = "phone" | "drop" | "mini" | "full";
function menuMode(w: number): MenuMode {
  return w <= 760 ? "phone" : w < 1280 ? "drop" : w < 1500 ? "mini" : "full";
}
function useMenuMode() {
  const [mode, setMode] = useState<MenuMode>(() => menuMode(window.innerWidth));
  useEffect(() => {
    const on = () => setMode(menuMode(window.innerWidth));
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return mode;
}

function App() {
  const [tab, setTab] = useState<Tab>(() => tabFromHash() ?? "Deals");
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
  const mode = useMenuMode();
  // The sidebar is open by default only on big screens, where it is docked.
  const [sideOpen, setSideOpen] = useState(mode === "full");
  useEffect(() => setSideOpen(mode === "full"), [mode]);
  const [dropOpen, setDropOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const dropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dropOpen) return;
    const away = (e: MouseEvent) => {
      if (!dropRef.current?.contains(e.target as Node)) setDropOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setDropOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [dropOpen]);
  const go = (t: Tab) => {
    setTab(t);
    setToolsOpen(false);
    setDropOpen(false);
    if (mode !== "full") setSideOpen(false);
    history.replaceState(null, "", "#" + t);
    window.scrollTo(0, 0);
  };
  const navButton = (t: Tab, cls?: string, label = LABEL[t]) => (
    <button
      key={t + (cls ?? "")}
      className={cls}
      aria-pressed={t === tab}
      title={label}
      onClick={() => go(t)}
    >
      <Icon name={t} />
      <span className="rail-label">{label}</span>
    </button>
  );
  const moreActive = MORE.includes(tab);
  const overlay = sideOpen && mode === "mini";
  return (
    <div className={`shell menu-${mode}` + (sideOpen ? " side-open" : "")}>
      <div className="rail">
        <div className="rail-top">
          <button
            type="button"
            className="rail-toggle"
            aria-expanded={sideOpen}
            aria-label={sideOpen ? "Close the menu" : "Open the menu"}
            onClick={() => setSideOpen(!sideOpen)}
          >
            <Icon name="tools" />
          </button>
          <a
            className="logo rail-logo"
            href="#Deals"
            aria-label="Bounty, back to the deals"
          >
            <span className="logo-mark" aria-hidden="true">
              B
            </span>
            <strong>Bounty</strong>
          </a>
        </div>
        <nav className="rail-nav" aria-label="Sections">
          {MEMBER.map((t) =>
            navButton(t, t === "Scan" ? "scan-tab" : undefined),
          )}
          {/* The mini sidebar shows the extras and tools straight under the
              main sections; the open sidebar shows them in named groups. */}
          <span className="rail-mini-extra">
            <span className="rail-sep" />
            {navButton("Planner", "mini-only", "Trip")}
            {navButton("Research", "mini-only")}
            {navButton("Sources", "mini-only")}
          </span>
          <span className="rail-group">Extras</span>
          {EXTRAS.map((t) => navButton(t, "open-only"))}
          <span className="rail-group">Tools</span>
          {TOOLS.map((t) => navButton(t, "open-only"))}
        </nav>
      </div>
      {overlay && (
        <div className="rail-scrim" onClick={() => setSideOpen(false)} />
      )}
      <div className="maincol">
        <header className="sitehead">
          <div className="sitehead-in">
            <a
              className="logo head-logo"
              href="#Deals"
              aria-label="Bounty, back to the deals"
            >
              <span className="logo-mark" aria-hidden="true">
                B
              </span>
              <strong>Bounty</strong>
            </a>
            <div className="drop-wrap" ref={dropRef}>
              <button
                type="button"
                className="drop-btn"
                aria-expanded={dropOpen}
                aria-haspopup="true"
                onClick={() => setDropOpen(!dropOpen)}
              >
                <span className="logo-mark" aria-hidden="true">
                  B
                </span>
                <strong>Bounty</strong>
                <span className="drop-pill">
                  <Icon name="tools" />
                  Menu
                </span>
              </button>
              {dropOpen && (
                <div className="mega" role="menu" aria-label="All sections">
                  {MEGA.map(([heading, tabs]) => (
                    <div key={heading} className="mega-col">
                      <h2>{heading}</h2>
                      {tabs.map((t) => (
                        <button
                          key={t}
                          role="menuitem"
                          aria-current={t === tab}
                          onClick={() => go(t)}
                        >
                          <b>{LABEL[t]}</b>
                          <small>{HINT[t]}</small>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <form
              className="head-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                if (tab !== "Deals") go("Deals");
              }}
            >
              <label className="sr-only" htmlFor="head-q">
                Search deals
              </label>
              <input
                id="head-q"
                type="search"
                value={query}
                placeholder="Search a product or shop"
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (tab !== "Deals") go("Deals");
                }}
              />
              <button
                type="button"
                className="head-scan"
                title="Scan a barcode"
                aria-label="Scan a barcode"
                onClick={() => go("Scan")}
              >
                <Icon name="Scan" />
              </button>
            </form>
          </div>
        </header>
        <div className="topbar">
          <div className="wrap">
            <span className="topbar-title">Three prices, never mixed:</span>
            <span className="badge ev-retail">Retail offer</span>
            <span className="topbar-note">what you pay</span>
            <span className="badge ev-sold">Completed sale</span>
            <span className="topbar-note">what it really sold for</span>
            <span className="badge ev-asking">Asking price</span>
            <span className="topbar-note">listings, not sales</span>
          </div>
        </div>
        <main>
          <div className="page-head">
            <span className="crumbs">Bounty › {LABEL[tab]}</span>
            <h1>{TABS[tab].title}</h1>
            <p>{TABS[tab].lead}</p>
          </div>
          <TabBoundary key={tab} onError={ON_ERROR[tab]}>
            {tab === "Deals" ? (
              <Deals query={query} onQuery={setQuery} />
            ) : (
              <View />
            )}
          </TabBoundary>
        </main>
        <footer className="site-foot">
          <div className="wrap">
            <span>
              <strong>Bounty</strong> · trip planning for UK resellers
            </span>
            <span>Times are UK time. Sample figures are always labelled.</span>
          </div>
        </footer>
      </div>
      <nav className="bottombar" aria-label="Sections">
        {MEMBER.map((t) => navButton(t, t === "Scan" ? "scan-tab" : undefined))}
        <button
          aria-pressed={moreActive}
          aria-expanded={toolsOpen}
          onClick={() => setToolsOpen(!toolsOpen)}
        >
          <Icon name="tools" />
          <span className="rail-label">More</span>
        </button>
      </nav>
      {toolsOpen && (
        <div className="tools-sheet" role="menu" aria-label="More">
          {MORE.map((t) => (
            <button
              key={t}
              role="menuitem"
              aria-pressed={t === tab}
              onClick={() => go(t)}
            >
              <Icon name={t} />
              {TABS[t].title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Deals first, so anyone can open the app and see finds with no setup. The
// phone bar follows a reseller's day: browse Deals at home, check Tips,
// Scan in the shop, then track Stock and Money. The trip planner is an
// optional extra; the research desk and source admin are tools. On phones
// the extras and tools share the More menu.
const MEMBER: Tab[] = ["Deals", "Bounties", "Scan", "Ledger", "Goals"];
const EXTRAS: Tab[] = ["Planner"];
const TOOLS: Tab[] = ["Research", "Sources"];
const MORE: Tab[] = [...EXTRAS, ...TOOLS];
// The laptop drop-down menu: every section in four columns, each with a
// short line on what it is for.
const MEGA: [string, Tab[]][] = [
  ["Hunt", ["Scan", "Deals", "Bounties"]],
  ["Your stuff", ["Ledger", "Goals"]],
  ["Plan", ["Planner"]],
  ["Tools", ["Research", "Sources"]],
];
const HINT: Record<Tab, string> = {
  Deals: "What to buy near you",
  Scan: "Check a price in the shop",
  Planner: "Plan a route of shops",
  Goals: "Profit, goals and cash",
  Research: "Look up any product",
  Bounties: "Finds from other scouts",
  Ledger: "What you bought, what sold",
  Sources: "Where prices come from",
};
const LABEL: Record<Tab, string> = {
  Deals: "Deals",
  Scan: "Scan",
  Planner: "Trip planner",
  Goals: "Money",
  Research: "Research",
  Bounties: "Tips",
  Ledger: "Stock",
  Sources: "Sources",
};

// Line icons for the menu, drawn on a 24-unit grid.
const ICON_PATHS: Record<string, string[]> = {
  Deals: [
    "M19 5 5 19",
    "M7 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    "M17 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  ],
  Scan: [
    "M4 8V5a1 1 0 0 1 1-1h3",
    "M16 4h3a1 1 0 0 1 1 1v3",
    "M20 16v3a1 1 0 0 1-1 1h-3",
    "M8 20H5a1 1 0 0 1-1-1v-3",
    "M8 9v6M11 9v6M14 9v6M17 9v6",
  ],
  Planner: [
    "M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z",
    "M12 13.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z",
  ],
  Goals: [
    "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
    "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M12 12.5v-1",
  ],
  Research: [
    "M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z",
    "M20 20l-4.2-4.2",
  ],
  Bounties: [
    "M3.5 12V4h8l9 9-8 8z",
    "M7.8 9.6a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z",
  ],
  Ledger: [
    "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z",
    "M5 17a3 3 0 0 1 3-3h11",
  ],
  Sources: [
    "M12 9c3.9 0 7-1.3 7-3s-3.1-3-7-3-7 1.3-7 3 3.1 3 7 3z",
    "M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6",
    "M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  ],
  tools: ["M4 7h16", "M4 12h16", "M4 17h16"],
  open: ["M9 6l6 6-6 6"],
  close: ["M15 6l-6 6 6 6"],
};
function Icon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
