import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  loadLens,
  loadProfile,
  money,
  percent,
  saveLens,
  saveProfile,
  type Lens,
} from "../api";
import { BuyingRules, ItemTile, byMode } from "../Planner";
import { CrewArt, CrewLoading } from "./CrewArt";
import { savedExtras, type Deal } from "../Deals";
import { Ico } from "./icons";
import MoneyScreen from "./Money";
import TripPage from "./TripPage";
import StockScreen from "./StockScreen";
import Blocks from "../ui/Blocks";
import Scan from "../Scan";
import TipsScreen from "./TipsScreen";
import Admin from "./Admin";
import PlansScreen, { PlanGate, PlanLine } from "./PlansScreen";
import CrewScreen, { CrewBand } from "./CrewScreen";
import { PageHead } from "../ui/kit";
import { GoalsSettings } from "../Goals";
import SignOff from "./SignOff";
import AccountSettings from "./AccountSettings";
import { Help, Privacy, SiteFoot, Terms } from "./LegalPages";
import "./proto.css";
import "./proto-extra.css";
import "./proto-bold.css";

// The logo in every slot. One place to change when the new logo arrives.
function Wordmark() {
  return (
    <span className="wordmark" aria-label="Bounty">
      <b aria-hidden="true">BOUNTY</b>
    </span>
  );
}

// The app shell and the Deals, item, trip and profile screens, ported from the
// agreed desktop mock. Every figure comes from the deals API. Parts the app
// has no data for yet (alerts, tip chat, scout points, plan) work as in the
// mock but carry a Sample label, and nothing invented is shown as real.

export type View =
  | "deals"
  | "item"
  | "scan"
  | "tips"
  | "stock"
  | "money"
  | "planner"
  | "research"
  | "sources"
  | "profile"
  | "watching"
  | "blocks"
  | "admin"
  | "plans"
  | "crew"
  | "help"
  | "terms"
  | "privacy";

// The address for each screen. The older screens keep their old names, so
// links inside them such as #Planner still work.
const HASH: Record<View, string> = {
  deals: "Deals",
  item: "Item",
  scan: "Scan",
  tips: "Bounties",
  stock: "Ledger",
  money: "Goals",
  planner: "Planner",
  research: "Research",
  sources: "Sources",
  profile: "Profile",
  watching: "Saved",
  blocks: "Blocks",
  admin: "Admin",
  plans: "Plans",
  crew: "Crew",
  help: "Help",
  terms: "Terms",
  privacy: "Privacy",
};
/* When a find is saved the heart pops and a few short lines flick out
   around it, like Pinterest. Skipped for people who ask for reduced motion. */
function heartRays(from: HTMLElement) {
  if (typeof window === "undefined" || !from.animate) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const heart = (from.querySelector("svg") as SVGElement | null) ?? from;
  heart.animate(
    [{ transform: "scale(1)" }, { transform: "scale(0.8)", offset: 0.25 }, { transform: "scale(1.3)", offset: 0.6 }, { transform: "scale(1)" }],
    { duration: 450, easing: "ease-out" },
  );
  const r = heart.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "rays";
  layer.setAttribute("aria-hidden", "true");
  layer.style.left = `${r.left + r.width / 2}px`;
  layer.style.top = `${r.top + r.height / 2}px`;
  document.body.appendChild(layer);
  const n = 8;
  const start = r.width * 0.65;
  const runs: Animation[] = [];
  for (let i = 0; i < n; i++) {
    const ray = document.createElement("i");
    layer.appendChild(ray);
    const deg = (360 / n) * i;
    const at = (d: number, len: number) =>
      `rotate(${deg}deg) translateY(-${d}px) scaleY(${len})`;
    runs.push(
      ray.animate(
        [
          { transform: at(start, 0.2), opacity: 0 },
          { transform: at(start + 3, 1), opacity: 1, offset: 0.35 },
          { transform: at(start + 9, 0.15), opacity: 0 },
        ],
        { duration: 480, delay: 110, easing: "cubic-bezier(.2,.7,.3,1)", fill: "both" },
      ),
    );
  }
  Promise.all(runs.map((x) => x.finished)).finally(() => layer.remove());
}

function fromHash(): { view: View; sku: string | null } {
  let h = "";
  try {
    h = decodeURIComponent(location.hash.slice(1));
  } catch {
    h = "";
  }
  const [name, sku] = h.split("/");
  const view = (Object.keys(HASH) as View[]).find((v) => HASH[v] === name);
  return view ? { view, sku: sku ?? null } : { view: "deals", sku: null };
}

// True when the address names a screen that does not exist, such as an
// old or mistyped link. The app still opens on Deals, with a note.
function unknownHash(): boolean {
  let h = "";
  try {
    h = decodeURIComponent(location.hash.slice(1));
  } catch {
    return true;
  }
  const name = h.split("/")[0];
  return name !== "" && !Object.values(HASH).includes(name);
}

const CAT_LABEL: Record<string, string> = {
  clothing: "Clothing",
  general: "Home and general",
  toys: "Toys",
  beauty: "Beauty",
  tech: "Tech",
};
const catLabel = (c: string) => CAT_LABEL[c] ?? c[0].toUpperCase() + c.slice(1);
const VL: Record<string, string> = {
  buy: "Buy",
  think: "Think",
  leave: "Leave",
  unknown: "Not sure",
};
const TRAVEL: [string, string, string][] = [
  ["Car", "Car", "Fuel per trip"],
  ["Bus", "Public transport", "Fares and time"],
  ["Walk", "Walk", "Time only"],
  ["Van", "Van", "Bigger loads"],
];
const travelLabel = (mode: string) =>
  TRAVEL.find((t) => t[1] === mode)?.[0] ?? mode;

// Small helpers around a deal.
const salesMonth = (d: Deal) =>
  d.salesPerWeek == null ? null : Math.round((d.salesPerWeek * 30) / 7);
const keepWord = (d: Deal) =>
  d.unitProfit !== null && d.unitProfit < 0 ? "Lose" : "Keep";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows may refuse storage; it lasts for this visit only.
  }
}

/** "5 min ago", "3 hr ago", "2 days ago". */
function ago(ms: number) {
  const h = (Date.now() - ms) / 3.6e6;
  if (h < 1) return Math.max(1, Math.round(h * 60)) + " min ago";
  if (h < 24) return Math.round(h) + " hr ago";
  const d = Math.round(h / 24);
  return d + (d === 1 ? " day ago" : " days ago");
}

type Report = { at: number; kind: "saw" | "gone" };

export default function ProtoApp({
  legacy,
  account,
  operator = true,
}: {
  legacy: (view: View) => React.ReactNode;
  // May use Admin. The server checks this too; here it only hides the way in.
  operator?: boolean;
  // Member sign-in on a hosted pilot; absent on your own computer, where
  // there are no accounts. email is null while signed out.
  account?: {
    email: string | null;
    signIn: () => void;
    signUp: () => void;
    signOut: () => void;
    // After the account is deleted (already signed out on the server).
    signedOut?: () => void;
    // After the email changes.
    refresh?: () => void;
  };
}) {
  const first = fromHash();
  const [view, setView] = useState<View>(first.view);
  const [sku, setSku] = useState<string | null>(first.sku);
  const [lost, setLost] = useState(unknownHash);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [cat, setCat] = useState<string | null>(null);
  const [list, setList] = useState(false);
  const [sort, setSort] = useState<"keep" | "off" | "near" | "fast">("keep");
  const [lens, setLensState] = useState<Lens>(loadLens);
  const [q, setQ] = useState("");
  const [shop, setShop] = useState("All shops");
  const [radius, setRadius] = useState<number>(() => load("bounty-radius", 10));
  const [pop, setPop] = useState<string | null>(null);
  const [profOpen, setProfOpen] = useState(false);
  const [open, setOpen] = useState(() => window.innerWidth >= 1500);
  const [trip, setTrip] = useState<Record<string, number>>(() =>
    load("bounty-trip", {}),
  );
  const [tripOpen, setTripOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const [going, setGoing] = useState<boolean>(() =>
    load("bounty-trip-going", false),
  );
  const [got, setGot] = useState<Record<string, boolean>>(() =>
    load("bounty-trip-got", {}),
  );
  const [reports, setReports] = useState<Record<string, Report[]>>(() =>
    load("bounty-shelf-reports", {}),
  );
  const [saved, setSaved] = useState<Record<string, true>>(() =>
    load("bounty-saved", {}),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [onboard, setOnboard] = useState<boolean>(
    () => !load("bounty-onboarded", false),
  );
  const [obStep, setObStep] = useState(1);
  const [obTravel, setObTravel] = useState<string | null>(null);
  const [postcode, setPostcode] = useState<string>(() =>
    load("bounty-postcode", ""),
  );
  const [photo, setPhoto] = useState<string | null>(() =>
    load("bounty-photo", null),
  );
  const [name, setName] = useState<string>(() => load("bounty-name", ""));
  const [seller, setSeller] = useState<string>(() =>
    load("bounty-seller", "Private"),
  );
  const [alertsOn, setAlertsOn] = useState<Record<string, boolean>>(() =>
    load("bounty-alert-prefs", {
      finds: true,
      tips: true,
      drops: true,
      weekly: false,
    }),
  );
  const [listening, setListening] = useState(false);
  const [profile, setProfileState] = useState(loadProfile);
  const [bounties, setBounties] = useState<LiveTip[]>([]);

  useEffect(() => store("bounty-trip", trip), [trip]);
  useEffect(() => store("bounty-trip-going", going), [going]);
  useEffect(() => store("bounty-trip-got", got), [got]);
  useEffect(() => store("bounty-shelf-reports", reports), [reports]);
  useEffect(() => store("bounty-saved", saved), [saved]);
  useEffect(() => store("bounty-radius", radius), [radius]);

  // Deals, and live tips for the home page.
  useEffect(() => {
    let live = true;
    api<{ deals: Deal[] }>("deals", savedExtras())
      .then((r) => live && (setDeals(r.deals), setError("")))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [reload]);
  useEffect(() => {
    api<{ bounties: LiveTip[] }>("bounties")
      .then((r) => setBounties(r.bounties.filter((b) => b.status === "open")))
      .catch(() => setBounties([]));
  }, []);

  // The address follows the screen, and the back button works.
  useEffect(() => {
    const on = () => {
      const h = fromHash();
      setView(h.view);
      setSku(h.sku);
      setLost(unknownHash());
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // The full sidebar docks on big screens and opens over the page below that.
  useEffect(() => {
    let wide = window.innerWidth >= 1500;
    const on = () => {
      const w = window.innerWidth >= 1500;
      if (w !== wide) setOpen(w);
      else if (window.innerWidth < 1280) setOpen(false);
      wide = w;
    };
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // Close pop-overs on a click elsewhere or Escape.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pop && !profOpen) return;
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (pop && !t.closest(".popwrap")) setPop(null);
      if (profOpen && !t.closest(".profwrap")) setProfOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPop(null);
        setProfOpen(false);
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [pop, profOpen]);

  const say = (t: string) => {
    setToast(t);
    window.setTimeout(() => setToast(null), 2600);
  };
  const go = (v: View, itemSku: string | null = null) => {
    setPop(null);
    setProfOpen(false);
    setLost(false);
    setView(v);
    setSku(itemSku);
    if (v !== "deals") {
      setCat(null);
      setList(false);
    }
    if (window.innerWidth < 1500) setOpen(false);
    history.pushState(
      null,
      "",
      "#" + HASH[v] + (itemSku ? "/" + encodeURIComponent(itemSku) : ""),
    );
    window.scrollTo(0, 0);
  };
  const showCat = (c: string | null, all = false) => {
    setCat(c);
    setList(c !== null || all);
    go("deals");
  };
  const setLens = (l: Lens) => {
    setLensState(l);
    saveLens(l);
    if (l === "pro" && view === "deals") setList(true);
  };
  const setTravel = (mode: string) => {
    const p = { ...loadProfile(), transport: mode };
    saveProfile(p);
    setProfileState(p);
    setReload((n) => n + 1);
  };
  const addToTrip = (s: string) =>
    setTrip((t) => {
      const next = { ...t };
      if (next[s]) delete next[s];
      else {
        next[s] = 1;
        setTripOpen(true);
      }
      return next;
    });

  // ---------- the deals in view ----------
  const all = deals ?? [];
  const bySku = useMemo(() => new Map(all.map((d) => [d.sku, d])), [all]);
  const shops = [...new Set(all.map((d) => d.shop))].sort();
  const areas = [
    ...new Set(all.map((d) => d.area).filter(Boolean)),
  ] as string[];
  const area = postcode || areas[0] || "your area";
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const inView = all.filter(
    (d) =>
      (shop === "All shops" || d.shop === shop) &&
      (d.miles === null || d.miles <= radius) &&
      words.every((w) =>
        [d.name, d.variant, d.shop, catLabel(d.category)]
          .join(" ")
          .toLowerCase()
          .includes(w),
      ),
  );
  const sample = all.some((d) => d.sample);
  const best = inView
    .filter((d) => d.verdict === "buy" || d.meetsThresholds)
    .sort((a, b) => (b.unitProfit ?? -1e9) - (a.unitProfit ?? -1e9));
  const cats = [...new Set(all.map((d) => d.category))].sort();

  // ---------- pieces shared by several screens ----------
  const note = sample ? (
    <div className="note">
      <span>
        <b>
          {all.every((d) => d.sample)
            ? "These are made-up examples, not real deals."
            : "Some of these are made-up examples."}
        </b>{" "}
        Cards marked example use invented shop prices, sale prices and shelf
        counts to show how the screen works. Only the sums are real. Real deals
        will appear here once real sold prices are connected.
      </span>
    </div>
  ) : null;
  // How fresh the price is: last checked, or your own shelf report.
  const SOURCE = {
    online: "Website price",
    shelf: "Scout's shelf price",
  } as const;
  const seen = (d: Deal) => {
    const mine = (reports[d.sku] ?? [])
      .filter((r) => r.kind === "saw")
      .map((r) => r.at);
    const checked = [d.stockChecked, d.priceChecked]
      .map((x) => (x ? Date.parse(x) : NaN))
      .filter((x) => Number.isFinite(x)) as number[];
    const at = Math.max(...mine, ...checked, -Infinity);
    if (!Number.isFinite(at))
      return {
        f: "old",
        text: d.sample
          ? "Example: made up, never checked"
          : "Not checked yet",
      };
    const h = (Date.now() - at) / 3.6e6;
    const byYou = mine.includes(at);
    return {
      f: h < 6 ? "fresh" : h < 24 ? "mid" : "old",
      text: byYou ? `You saw it on the shelf ${ago(at)}` : `Last checked ${ago(at)}`,
    };
  };
  // One short line on a card: where the price came from (green dot for a
  // shop website price, blue for a scout's shelf price) and how fresh it is.
  // Without a source it falls back to the freshness line alone.
  const PriceLine = ({ d }: { d: Deal }) => {
    if (!d.priceSource) return <SeenTag d={d} />;
    const z = seen(d);
    const when = d.sample && z.f === "old" && !(reports[d.sku] ?? []).length ? "example" : z.text.replace(/^Last checked /, "");
    return (
      <span className={"srctag " + d.priceSource} title={z.text}>
        <i />
        <span>
          {SOURCE[d.priceSource]} · <small>{when}</small>
        </span>
      </span>
    );
  };
  const SeenTag = ({ d }: { d: Deal }) => {
    const z = seen(d);
    return (
      <span className={"seen " + z.f}>
        <i />
        {z.text}
      </span>
    );
  };
  // A live tip for this deal: same item at the same shop, matched by
  // name. Shown as a badge on the card's photo that opens Tips.
  const norm = (x: string | null | undefined) => (x ?? "").trim().toLowerCase();
  const tipFor = (d: Deal) =>
    bounties.find(
      (b) =>
        (!b.retailer || norm(b.retailer) === norm(d.shop)) &&
        norm(b.title) === norm(d.name),
    ) ?? null;
  const TipLine = ({ d }: { d: Deal }) => {
    const t = tipFor(d);
    if (!t) return null;
    const open = (e: React.SyntheticEvent) => {
      e.stopPropagation();
      go("tips");
    };
    return (
      <span
        className="tipline"
        role="button"
        aria-label={`Scout tip${t.sample ? " (sample)" : ""}: ${t.remaining} ${t.remaining === 1 ? "place" : "places"} left. Open Tips`}
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(e))}
      >
        <Ico n="tips" />
        <span>
          Tip · {t.remaining} left
        </span>
      </span>
    );
  };
  const pic = (d: Deal, cls: string) => (
    <span className={cls + " ph tile"}>
      <ItemTile sku={d.sku} category={d.category} />
    </span>
  );
  const AddBtn = ({ d }: { d: Deal }) => (
    <span
      className={"addt " + (trip[d.sku] ? "in" : "")}
      role="button"
      tabIndex={0}
      aria-label={trip[d.sku] ? "Take off my trip" : "Add to my trip"}
      onClick={(e) => {
        e.stopPropagation();
        addToTrip(d.sku);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          addToTrip(d.sku);
        }
      }}
    >
      {trip[d.sku] ? "✓" : "+"}
    </span>
  );
  const Card = ({ d, pill }: { d: Deal; pill?: "sold" | "tip" }) => {
    const m = salesMonth(d);
    const tag =
      pill === "sold" ? (
        <span className="badge lime">
          {m !== null
            ? `${m} sold a month`
            : `${d.sales.length} completed sales`}
        </span>
      ) : d.underSale !== null ? (
        <span className="badge">−{d.underSale}%</span>
      ) : null;
    return (
      <button type="button" className="pc" onClick={() => go("item", d.sku)}>
        <span className="img tile">
          <ItemTile sku={d.sku} category={d.category} />
          <TipLine d={d} />
          <AddBtn d={d} />
        </span>
        {tag}
        <span
          className={"heart" + (saved[d.sku] ? " on" : "")}
          role="button"
          tabIndex={0}
          aria-label={saved[d.sku] ? "Remove from saved" : "Save"}
          onClick={(e) => {
            e.stopPropagation();
            if (!saved[d.sku]) heartRays(e.currentTarget);
            toggleSaved(d.sku);
          }}
        >
          <Ico n="heart" />
        </span>
        <span className="body">
          <span className="nrow">
            <span className="name">{d.name}</span>
            <span className="sold">{VL[d.verdict]}</span>
          </span>
          <span className="price">
            <b className="num">{money(d.buy)}</b>
            <span className="num">
              sells {d.salePrice === null ? "not known" : money(d.salePrice)}
            </span>
          </span>
          <span className={"keepl " + d.verdict}>
            {d.unitProfit === null
              ? "Profit not known yet"
              : `${keepWord(d)} ${money(Math.abs(d.unitProfit))} after fees and postage`}
          </span>
          <span className="stores">
            {d.shop}
            {d.miles !== null ? ` · ${d.miles} mi` : ""}
          </span>
          <PriceLine d={d} />
        </span>
      </button>
    );
  };
  const toggleSaved = (s: string) =>
    setSaved((x) => {
      const n = { ...x };
      if (n[s]) delete n[s];
      else n[s] = true;
      return n;
    });

  // ---------- sidebar ----------
  const nav = (k: View, l: string, cls = "", icon: string = k) => (
    <button
      key={k + l}
      type="button"
      className={"nav " + cls}
      aria-current={
        view === k || (k === "deals" && view === "item") ? "page" : "false"
      }
      title={l}
      onClick={() => go(k)}
    >
      <Ico n={icon} />
      <span className="label">{l}</span>
    </button>
  );
  const strip = (
    <nav className="strip" aria-label="Sections">
      <div className="ytrow">
        <button
          type="button"
          className="ytburg"
          aria-label="Open or close the menu"
          title="Menu"
          onClick={() => setOpen(!open)}
        >
          <Ico n="menu" />
        </button>
        <button
          type="button"
          className="ytlogo"
          aria-label="Bounty home"
          onClick={() => showCat(null)}
        >
          <Wordmark />
        </button>
      </div>
      {nav("scan", "Scan", "scan")}
      {nav("deals", "Deals")}
      {nav("tips", "Tips")}
      {nav("stock", "Stock")}
      {nav("money", "Money")}
      <span className="minix">
        <span className="minisep" />
        {nav("planner", "Trip")}
        {nav("research", "Research")}
        {nav("watching", "Saved", "", "heart")}
      </span>
      <span className="more2">
        <span className="head">Tools</span>
        {nav("planner", "My trip")}
        {nav("research", "Research")}
        <span className="head">You</span>
        {nav("watching", "Saved", "", "heart")}
        {nav("profile", "Alerts", "", "bell")}
        {nav("profile", "Profile and settings", "", "user")}
        <span className="grow" />
        <span className="pts">
          <span style={{ color: "var(--muted)" }}>Scout points · sample</span>
          <b>460 · Ruby</b>£2 off at 500
        </span>
      </span>
    </nav>
  );

  // ---------- header ----------
  const Speech =
    typeof window !== "undefined"
      ? ((window as unknown as Record<string, unknown>).SpeechRecognition ??
        (window as unknown as Record<string, unknown>).webkitSpeechRecognition)
      : undefined;
  const listen = () => {
    if (!Speech) return;
    const R = Speech as new () => {
      lang: string;
      onresult: (e: { results: { 0: { transcript: string } }[] }) => void;
      onend: () => void;
      start: () => void;
    };
    const r = new R();
    r.lang = "en-GB";
    r.onresult = (e) => {
      setQ(e.results[0][0].transcript);
      showCat(null, true);
    };
    r.onend = () => setListening(false);
    setListening(true);
    r.start();
  };
  const avatar = photo ? (
    <img src={photo} alt="Your photo" />
  ) : (
    <span>{(name || "You")[0].toUpperCase()}</span>
  );
  const top = all
    .filter((d) => d.unitProfit !== null)
    .sort((a, b) => (b.unitProfit ?? 0) - (a.unitProfit ?? 0));
  const header = (
    <header className="top">
      <div className="topin pin">
        <button type="button" className="brand" onClick={() => showCat(null)}>
          <Wordmark />
        </button>
        <button
          type="button"
          className="burger"
          aria-label="Menu"
          onClick={() => setOpen(!open)}
        >
          <Ico n="menu" />
        </button>
        <div className="popwrap pinwrap">
          <button
            type="button"
            className="pinbrand"
            aria-expanded={pop === "menu"}
            aria-label="Bounty menu"
            onClick={() => setPop(pop === "menu" ? null : "menu")}
          >
            <Wordmark />
            <span className="pbm">
              <Ico n="menu" />
              <span>Menu</span>
            </span>
          </button>
          {pop === "menu" && <MegaMenu go={go} />}
        </div>
        <div className="popwrap">
          <button
            type="button"
            className="area"
            aria-expanded={pop === "area"}
            onClick={() => setPop(pop === "area" ? null : "area")}
          >
            <span className="aic">
              <Ico n="pin" />
            </span>
            <span className="at">
              <small>Hunting near</small>
              <b>
                {area} · {radius} mi
              </b>
            </span>
            <Ico n="down" />
          </button>
          {pop === "area" && (
            <div className="pop areapop">
              <b className="ph2">Where are you hunting?</b>
              {(areas.length ? areas : [area]).map((a) => (
                <button key={a} type="button" className="opt on">
                  <span className="aic">
                    <Ico n="pin" />
                  </span>
                  <span>
                    <b>{a}</b>
                    <small>
                      {postcode ? "your postcode" : "where the deals are"}
                    </small>
                  </span>
                  <span className="tickm">✓</span>
                </button>
              ))}
              <div className="radius">
                <small>Distance</small>
                <div className="seg">
                  {[3, 5, 10, 25].map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={radius === r}
                      onClick={() => setRadius(r)}
                    >
                      {r} mi
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="linkbtn"
                style={{ textAlign: "left", padding: "6px 4px" }}
                onClick={() => {
                  setPop(null);
                  setObStep(1);
                  setOnboard(true);
                }}
              >
                + Change your postcode
              </button>
            </div>
          )}
        </div>
        <form
          className={"search psearch" + (listening ? " listening" : "")}
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            showCat(null, true);
          }}
        >
          <input
            id="q"
            aria-label="Search"
            placeholder={
              listening
                ? "Listening… say a product"
                : "Search a product or shop"
            }
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (view !== "deals") go("deals");
              setList(e.target.value.trim() !== "" || cat !== null);
            }}
          />
          {q && (
            <button
              type="button"
              className="sx"
              aria-label="Clear"
              onClick={() => (setQ(""), setList(cat !== null))}
            >
              ×
            </button>
          )}
          <button
            type="button"
            className="bc2"
            aria-label="Scan a barcode"
            title="Scan a barcode"
            onClick={() => go("scan")}
          >
            <Ico n="scan" />
          </button>
          {Speech ? (
            <button
              type="button"
              className="bc2 mic"
              aria-label="Search by voice"
              title="Search by voice"
              onClick={listen}
            >
              <Ico n="mic" />
            </button>
          ) : null}
          <span className="vdiv" />
          <span className="popwrap">
            <button
              type="button"
              className="allshops"
              onClick={() => setPop(pop === "shops" ? null : "shops")}
            >
              {shop}
              <Ico n="down" />
            </button>
            {pop === "shops" && (
              <div className="pop shoppop">
                {["All shops", ...shops].map((o) => (
                  <button
                    key={o}
                    type="button"
                    className={"opt " + (shop === o ? "on" : "")}
                    onClick={() => (setShop(o), setPop(null))}
                  >
                    {o}
                    {shop === o && <span className="tickm">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </span>
        </form>
        <div className="tools picons">
          {/* Alerts and tip chat belong to an account, so signed-out
              visitors see only Sign in and Sign up. */}
          {!(account && !account.email) && (<>
          <span className="popwrap">
            <button
              type="button"
              className="ib"
              aria-label="Alerts"
              aria-expanded={pop === "alerts"}
              onClick={() => (
                setPop(pop === "alerts" ? null : "alerts")
              )}
            >
              <Ico n="bell" />
              {/* No count badge while alerts are only samples: a number
                  here reads as real notifications. */}
            </button>
            {pop === "alerts" && (
              <div className="pop listpop">
                <b className="ph2">
                  Alerts <span className="badge sample-chip">Sample</span>
                </b>
                {top.slice(0, 3).map((d) => (
                  <button
                    key={d.sku}
                    type="button"
                    className="opt li"
                    onClick={() => go("item", d.sku)}
                  >
                    <span className="ldot" />
                    <span>
                      <small>New find</small>
                      {d.name} {money(d.buy)} at {d.shop}. {keepWord(d)}{" "}
                      {money(Math.abs(d.unitProfit ?? 0))}.
                    </span>
                  </button>
                ))}
                <small className="popnote">
                  Alerts are not sent yet. These show what one would look like.
                </small>
                <button
                  type="button"
                  className="linkbtn"
                  style={{ padding: "8px 4px", textAlign: "left" }}
                  onClick={() => go("profile")}
                >
                  Alert settings
                </button>
              </div>
            )}
          </span>
          <span className="popwrap">
            <button
              type="button"
              className="ib"
              aria-label="Tip chat"
              aria-expanded={pop === "chat"}
              onClick={() => (
                setPop(pop === "chat" ? null : "chat")
              )}
            >
              <Ico n="chat" />
            </button>
            {pop === "chat" && (
              <div className="pop listpop">
                <b className="ph2">
                  Tip chat <span className="badge sample-chip">Sample</span>
                </b>
                {CHATS.map(([n, l, m, w]) => (
                  <div key={n} className="opt li">
                    <span className="avatar sm">
                      <span>{n[0]}</span>
                    </span>
                    <span>
                      <small>
                        <b style={{ color: "var(--ink)" }}>{n}</b> · {l} · {w}
                      </small>
                      {m}
                    </span>
                  </div>
                ))}
                <small className="popnote">
                  Chat is coming. These messages are examples, not real members.
                </small>
                <button
                  type="button"
                  className="bt"
                  style={{ height: 38, marginTop: 6 }}
                  onClick={() => go("tips")}
                >
                  Open tips
                </button>
              </div>
            )}
          </span>
          </>)}
          {/* Signed out: Sign in and Sign up only. Signed in (or no accounts
              on this copy): the avatar and its account menu only. */}
          {account && !account.email ? (
            <span className="authbtns">
              <button type="button" className="bt ghost signin-top" onClick={account.signIn}>
                Sign in
              </button>
              <button type="button" className="bt signin-top signup-top" onClick={account.signUp}>
                Sign up
              </button>
            </span>
          ) : (
          <div className="profwrap">
            <button
              type="button"
              className="avatarbtn"
              aria-label="Your account"
              aria-expanded={profOpen}
              onClick={() => (setPop(null), setProfOpen(!profOpen))}
            >
              <span className="avatar">{avatar}</span>
              <Ico n="down" />
            </button>
            {profOpen && (
              <div className="profmenu" role="dialog" aria-label="Your account">
                <div className="pm-top">
                  <span className="avatar big">{avatar}</span>
                  <div>
                    <b>{name || "Your account"}</b>
                    <small>
                      {area} · {travelLabel(profile.transport).toLowerCase()} ·{" "}
                      {seller.toLowerCase()} seller
                    </small>
                    <PhotoInput
                      label={photo ? "Change photo" : "Add a photo"}
                      onPhoto={setPhotoSaved}
                    />
                  </div>
                </div>
                <div className="pm-row" style={{ padding: "2px 2px 4px" }}>
                  <span>View</span>
                  <LensBtns lens={lens} setLens={setLens} />
                </div>
                <div className="pm-card">
                  <PlanLine go={(v) => go(v)} />
                </div>
                <div className="pm-card">
                  <div className="pm-row">
                    <span>
                      <span className="lvl trusted">Ruby</span>Scout points
                    </span>
                    <b>460</b>
                  </div>
                  <div className="bar">
                    <i style={{ width: "92%", background: "var(--blue)" }} />
                  </div>
                  <small>Sample. Points start when tips go live.</small>
                </div>
                <div className="pm-links">
                  <button type="button" onClick={() => go("profile")}>
                    Profile and settings
                  </button>
                  <button type="button" onClick={() => go("money")}>
                    Money and goals
                  </button>
                  <button type="button" onClick={() => go("tips")}>
                    My tips
                  </button>
                  <button type="button" onClick={() => go("watching")}>
                    Saved finds
                  </button>
                  <button type="button" onClick={() => go("plans")}>
                    Plans
                  </button>
                  {operator && (
                    <button type="button" onClick={() => go("admin")}>
                      Admin (operators)
                    </button>
                  )}
                  {account && !account.email && (
                    <button type="button" onClick={account.signIn}>
                      Sign in
                    </button>
                  )}
                  {account?.email && (
                    <button type="button" onClick={account.signOut}>
                      Sign out ({account.email})
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          )}
        </div>
      </div>
    </header>
  );
  function setPhotoSaved(p: string | null) {
    setPhoto(p);
    store("bounty-photo", p);
  }

  // ---------- home ----------
  const Sec = ({
    kick,
    h,
    items,
    pill,
    see,
  }: {
    kick: string;
    h: string;
    items: Deal[];
    pill?: "sold" | "tip";
    see: string;
  }) =>
    items.length ? (
      <section className="sec">
        <div className="sech">
          <div>
            <p className="kick">{kick}</p>
            <h2>{h}</h2>
          </div>
          <button
            type="button"
            className="seeall"
            onClick={() => showCat(null, true)}
          >
            {see}
          </button>
        </div>
        <div className="row">
          {items.slice(0, 5).map((d) => (
            <Card key={d.sku} d={d} pill={pill} />
          ))}
        </div>
      </section>
    ) : null;
  const vHome = () => {
    const four = best.slice(0, 4);
    const rest = inView
      .filter((d) => !four.includes(d))
      .sort((a, b) => (b.unitProfit ?? -1e9) - (a.unitProfit ?? -1e9));
    // Each find shows once on this page: a row skips what a row above it
    // already shows (rows show five), so the page feels full, not looped.
    const shown = new Set([...four, ...rest.slice(0, 5)].map((d) => d.sku));
    const fast = [...inView]
      .filter((d) => d.salesPerWeek != null && !shown.has(d.sku))
      .sort((a, b) => (b.salesPerWeek ?? 0) - (a.salesPerWeek ?? 0));
    for (const d of fast.slice(0, 5)) shown.add(d.sku);
    const gaps = [...inView]
      .filter((d) => d.underSale !== null && !shown.has(d.sku))
      .sort((a, b) => (b.underSale ?? 0) - (a.underSale ?? 0));
    const tip = bounties[0];
    return (
      <>
        {note}
        {four.length > 0 && (
          <section className="dband">
            <div className="dtext">
              <small>
                {sample ? "Sample deals" : "Checked against completed sales"}
              </small>
              <h1>
                Today’s top <em>deals.</em>
              </h1>
              <p>
                Cheaper on the shelf near you than they sell for. Every rule
                met, sorted by what you keep.
              </p>
              <p className="dsrc">
                Prices come from shop websites (the same price in store) and
                from shelf finds by scouts near you. Each card says which.
              </p>
              <div className="dstats">
                <span>
                  <b>{best.length}</b> {best.length === 1 ? "buy" : "buys"}
                </span>
                <span>
                  <b>
                    {money(four.reduce((a, d) => a + (d.unitProfit ?? 0), 0))}
                  </b>{" "}
                  to keep from the top {four.length}
                </span>
              </div>
              <button
                type="button"
                className="pill lime"
                onClick={() => showCat(null, true)}
              >
                See all deals
              </button>
            </div>
            <div className="dcards">
              {four.map((d) => (
                <button
                  key={d.sku}
                  type="button"
                  className="dc"
                  onClick={() => go("item", d.sku)}
                >
                  <span className="dimg tile">
                    <ItemTile sku={d.sku} category={d.category} />
                    {d.underSale !== null && (
                      <span className="badge">−{d.underSale}%</span>
                    )}
                    <TipLine d={d} />
                    <AddBtn d={d} />
                  </span>
                  <span className="dn">{d.name}</span>
                  <span className="dp">
                    <b>{money(d.buy)}</b> sells{" "}
                    {d.salePrice === null ? "not known" : money(d.salePrice)}
                  </span>
                  <span className="dk">Keep {money(d.unitProfit ?? 0)}</span>
                  <span className="ds">
                    {d.shop}
                    {d.miles !== null ? ` · ${d.miles} mi` : ""}
                  </span>
                  <PriceLine d={d} />
                </button>
              ))}
            </div>
          </section>
        )}
        <nav className="iconrow" aria-label="Categories">
          <button type="button" onClick={() => showCat(null, true)}>
            <Ico n="all" w={1.6} />
            All
          </button>
          {cats.map((c) => (
            <button key={c} type="button" onClick={() => showCat(c)}>
              <Ico n={c} w={1.6} />
              {catLabel(c)}
            </button>
          ))}
        </nav>
        <Sec
          kick={four.length ? "More finds near you." : "Finds near you."}
          h="More top finds"
          items={rest}
          see="See all finds"
        />
        <CrewBand go={(v) => go(v)} />
        {tip && (
          <section className="feature">
            <div>
              <small>Live tip{tip.sample ? " · sample" : ""}</small>
              <h2>{tip.title}</h2>
              <p>
                {tip.retailer ? `${tip.retailer}, ` : ""}
                {tip.locality}. {tip.remaining} of {tip.cap} places left.
              </p>
              <button type="button" className="pill" onClick={() => go("tips")}>
                See the tip
              </button>
            </div>
            <div className="art2 tile">
              <ItemTile sku={all.find((d) => d.name === tip.title)?.sku ?? tip.barcode ?? "general"} category="general" />
            </div>
          </section>
        )}
        <Sec
          kick="Selling fastest."
          h="Quick sellers"
          items={fast}
          pill="sold"
          see="See all quick sellers"
        />
        <Sec
          kick="Shop price furthest below the sold price."
          h="Biggest gaps near you"
          items={gaps}
          see="See all gaps"
        />
        {deals && inView.length === 0 && (
          <div className="crew-note">
            <CrewArt look="scout-shrug" />
            <p className="sub">No deals within {radius} miles. Try a bigger distance.</p>
          </div>
        )}
      </>
    );
  };

  // ---------- list with filters ----------
  const [fv, setFv] = useState<Record<string, boolean>>({
    buy: true,
    think: true,
    leave: true,
    unknown: true,
  });
  const [fp, setFp] = useState("any");
  const [fs, setFs] = useState<Record<string, boolean>>({});
  const vList = () => {
    const priceOk = (d: Deal) =>
      fp === "any"
        ? true
        : fp === "u10"
          ? d.buy < 1000
          : fp === "10-25"
            ? d.buy >= 1000 && d.buy <= 2500
            : d.buy > 2500 && d.buy <= 5000;
    const anyShop = Object.values(fs).some(Boolean);
    const key = {
      keep: (d: Deal) => d.unitProfit ?? -1e9,
      off: (d: Deal) => d.underSale ?? -1e9,
      near: (d: Deal) => -(d.miles ?? 1e9),
      fast: (d: Deal) => d.salesPerWeek ?? -1e9,
    }[sort];
    const shown = inView
      .filter(
        (d) =>
          (!cat || d.category === cat) &&
          fv[d.verdict] !== false &&
          priceOk(d) &&
          (!anyShop || fs[d.shop]),
      )
      .sort((a, b) => key(b) - key(a));
    const title = cat
      ? catLabel(cat)
      : q.trim()
        ? `“${q.trim()}”`
        : "All finds";
    return (
      <>
        {note}
        <span className="crumbs">
          <button type="button" onClick={() => showCat(null)}>
            Deals
          </button>{" "}
          › {title}
        </span>
        <div className="listing">
          <aside className="filters">
            <div className="fg">
              <h4>Verdict</h4>
              {(["buy", "think", "leave"] as const).map((v) => (
                <label key={v}>
                  <input
                    type="checkbox"
                    checked={fv[v] !== false}
                    onChange={(e) => setFv({ ...fv, [v]: e.target.checked })}
                  />{" "}
                  {VL[v]}{" "}
                  <span>{inView.filter((d) => d.verdict === v).length}</span>
                </label>
              ))}
            </div>
            <div className="fg">
              <h4>Shop price</h4>
              {[
                ["any", "Any"],
                ["u10", "Under £10"],
                ["10-25", "£10 to £25"],
                ["25-50", "£25 to £50"],
              ].map(([k, l]) => (
                <label key={k}>
                  <input
                    type="radio"
                    name="fp"
                    checked={fp === k}
                    onChange={() => setFp(k)}
                  />{" "}
                  {l}
                </label>
              ))}
            </div>
            <div className="fg">
              <h4>Distance</h4>
              {[1, 3, 10, 25].map((r) => (
                <label key={r}>
                  <input
                    type="radio"
                    name="fd"
                    checked={radius === r}
                    onChange={() => setRadius(r)}
                  />{" "}
                  {r} {r === 1 ? "mile" : "miles"}
                </label>
              ))}
            </div>
            <div className="fg">
              <h4>Shop</h4>
              {shops.map((s) => (
                <label key={s}>
                  <input
                    type="checkbox"
                    checked={!!fs[s]}
                    onChange={(e) => setFs({ ...fs, [s]: e.target.checked })}
                  />{" "}
                  {s} <span>{all.filter((d) => d.shop === s).length}</span>
                </label>
              ))}
            </div>
          </aside>
          <div>
            <div className="toolbar">
              <h1>
                {title}{" "}
                <small
                  style={{
                    fontFamily: "var(--sans)",
                    fontSize: 15,
                    color: "var(--muted)",
                    fontWeight: 500,
                  }}
                >
                  {shown.length} {shown.length === 1 ? "product" : "products"}
                </small>
              </h1>
              <select
                aria-label="Sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
              >
                <option value="keep">Most money kept</option>
                <option value="off">Biggest gap</option>
                <option value="near">Closest</option>
                <option value="fast">Sells fastest</option>
              </select>
            </div>
            {lens === "pro" ? (
              <ProTable list={shown} open={(s) => go("item", s)} pic={pic} />
            ) : (
              <div className="grid4">
                {shown.map((d) => (
                  <Card key={d.sku} d={d} />
                ))}
              </div>
            )}
            {deals && shown.length === 0 && (
              <div className="crew-note">
                <CrewArt look="scout-shrug" />
                <p className="sub">Nothing matches. Clear a filter or the search.</p>
              </div>
            )}
          </div>
        </div>
      </>
    );
  };

  // ---------- item page ----------
  const workRef = useRef<HTMLDivElement>(null);
  const salesRef = useRef<HTMLDivElement>(null);
  const vItem = (d: Deal) => {
    const m = salesMonth(d);
    const mine = reports[d.sku] ?? [];
    const report = (kind: "saw" | "gone") => {
      setReports({
        ...reports,
        [d.sku]: [{ at: Date.now(), kind }, ...mine].slice(0, 10),
      });
      say(
        kind === "saw"
          ? "Thanks. Saved as seen just now on this device."
          : "Thanks. Saved as gone on this device.",
      );
    };
    const c = d.costs;
    return (
      <>
        {note}
        <span className="crumbs">
          <button type="button" onClick={() => showCat(null)}>
            Deals
          </button>{" "}
          ›{" "}
          <button type="button" onClick={() => showCat(d.category)}>
            {catLabel(d.category)}
          </button>{" "}
          › {d.name}
        </span>
        <div className="prod">
          <div className="gallery">
            <span className="big ph tile">
              <ItemTile sku={d.sku} category={d.category} />
            </span>
          </div>
          <div className="pinfo">
            <span className={"vp " + d.verdict}>
              {VL[d.verdict]}
              {d.sample ? " · example, not a real deal" : ""}
            </span>
            <h1>{d.name}</h1>
            <span className="sub">
              {d.variant ? d.variant + " · " : ""}
              {d.sales.length} {d.sample ? "pretend" : "completed"}{" "}
              {d.sales.length === 1 ? "sale" : "sales"}
              {d.sample ? ", not real eBay data" : ""}
              {m !== null ? ` · about ${m} sold a month` : ""}
              {d.competingListings !== null
                ? ` · ${d.competingListings} listed for sale now`
                : ""}
            </span>
            <div className="bigprice">
              <div className="bp">
                <small>Shop price</small>
                <b className="num" style={{ color: "var(--blue)" }}>
                  {money(d.buy)}
                </b>
              </div>
              <div className="bp">
                <small>Usually sells for</small>
                <b className="num">
                  {d.salePrice === null ? "Not known" : money(d.salePrice)}
                </b>
              </div>
              <div className="bp keepbox">
                <small>
                  {keepWord(d) === "Lose" ? "You lose" : "You keep"}, after fees
                  and postage
                </small>
                <b className="num">
                  {d.unitProfit === null
                    ? "Not known"
                    : money(Math.abs(d.unitProfit))}
                </b>
              </div>
            </div>
            {d.walkAway !== null && (
              <div className="walk">
                <span>Walk away if the sticker says more than</span>
                <b className="num">{money(d.walkAway)}</b>
              </div>
            )}
            <div className="btns">
              <button
                type="button"
                className="bt green"
                onClick={() => addToTrip(d.sku)}
              >
                {trip[d.sku] ? "In your trip ✓" : "Add to my trip"}
              </button>
              <button
                type="button"
                className={"bt ghost savebt" + (saved[d.sku] ? " on" : "")}
                aria-pressed={!!saved[d.sku]}
                onClick={(e) => {
                  if (!saved[d.sku]) heartRays(e.currentTarget);
                  toggleSaved(d.sku);
                }}
              >
                <Ico n="heart" />
                {saved[d.sku] ? "Saved" : "Save"}
              </button>
              <button
                type="button"
                className="bt ghost"
                onClick={() =>
                  salesRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  })
                }
              >
                <Ico n="out" />
                See the sales
              </button>
            </div>
            <p className="sub" style={{ marginTop: 14, fontSize: 13 }}>
              {d.reason}.
              {d.returnOnCost !== null
                ? ` Return on spend ${percent(d.returnOnCost)}.`
                : ""}{" "}
              {d.travel.added && d.travel.mode
                ? d.travel.cost === null
                  ? `You travel ${byMode(d.travel.mode)}: add your fare in the trip planner.`
                  : `Trip ${byMode(d.travel.mode)}: ${d.travel.cost === 0 ? "no cost" : money(d.travel.cost)}, shown for information only.`
                : "Travel not added yet. It never hides a deal."}
            </p>
          </div>
        </div>
        <div className="two">
          <div className="panel">
            <h3>
              Shop prices <small>1 shop so far</small>
            </h3>
            <div className="offers">
              <div className="offer">
                <span className="shop">
                  <b>{d.shop}</b>
                  <small>
                    {d.area ? d.area + " · " : ""}
                    {d.miles !== null ? `${d.miles} mi` : ""}
                    {d.stock !== null
                      ? ` · ${d.stock} on the shelf${d.stockChecked ? "" : " (assumed)"}`
                      : ""}
                  </small>
                </span>
                <span className="low">Lowest</span>
                <span className="p num">{money(d.buy)}</span>
                <span />
              </div>
            </div>
            <p className="sub" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
              Other shops appear here once their prices are checked.
            </p>
          </div>
          <div className="panel shelf">
            <h3>
              Shelf reports{" "}
              <small>
                <SeenTag d={d} />
              </small>
            </h3>
            <div className="sales">
              {mine.length ? (
                mine.slice(0, 4).map((r) => (
                  <div key={r.at}>
                    <span>
                      <b style={{ fontWeight: 600 }}>You</b> ·{" "}
                      {r.kind === "saw"
                        ? "Saw it on the shelf"
                        : "Said it was gone"}
                    </span>
                    <span style={{ color: "var(--muted)" }}>{ago(r.at)}</span>
                  </div>
                ))
              ) : (
                <div>
                  <span>No shelf reports yet</span>
                  <span />
                </div>
              )}
            </div>
            <div className="btns" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="bt"
                onClick={() => report("saw")}
              >
                I saw it
              </button>
              <button
                type="button"
                className="bt ghost"
                onClick={() => report("gone")}
              >
                It’s gone
              </button>
            </div>
            <p className="sub" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
              Stock changes all day, and shoppers who don’t use Bounty buy it
              too. Last seen is a guide, not a promise. If it’s a long trip,
              ring the shop first. Your reports stay on this device for now.
            </p>
          </div>
          <div className="panel" ref={salesRef}>
            <h3>
              {d.sample ? (
                <>
                  Pretend sale prices <small>made up for this example</small>
                </>
              ) : (
                <>
                  Completed sales <small>sold, not asking prices</small>
                </>
              )}
            </h3>
            <div className="sales">
              {d.sales.length ? (
                [...d.sales].reverse().map((s, i) => (
                  <div key={i}>
                    <span>{d.sample ? "Pretend sale (made up)" : "Completed sale"}</span>
                    <b className="num">{money(s)}</b>
                  </div>
                ))
              ) : (
                <div>
                  <span>No completed sales yet</span>
                  <span />
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="two" style={{ marginTop: 20 }}>
          <div className="panel chart">
            <h3>Prices at a glance</h3>
            <PriceStrip d={d} />
            <div className="legend">
              <span>
                <i style={{ background: "var(--blue)" }} />
                Shop price
              </span>
              <span>
                <i className="d" style={{ background: "var(--brand)" }} />
                Each completed sale
              </span>
              {d.walkAway !== null && (
                <span>
                  <i style={{ background: "var(--ask)" }} />
                  Walk-away price
                </span>
              )}
            </div>
          </div>
          <div className="panel" ref={workRef}>
            <h3>How the profit is worked out</h3>
            {c && d.salePrice !== null && d.unitProfit !== null ? (
              <div className="sales">
                <div>
                  <span>Sells for (lower middle completed sale)</span>
                  <b className="num">{money(d.salePrice)}</b>
                </div>
                <div>
                  <span>Shop price</span>
                  <b className="num">−{money(d.buy)}</b>
                </div>
                <div>
                  <span>
                    Selling fees ({percent(d.feeRate)} plus {money(d.feeFixed)})
                  </span>
                  <b className="num">−{money(c.fees)}</b>
                </div>
                <div>
                  <span>Returns allowance ({percent(d.returnsRate)})</span>
                  <b className="num">−{money(c.returns)}</b>
                </div>
                <div>
                  <span>Postage</span>
                  <b className="num">−{money(c.postage)}</b>
                </div>
                <div>
                  <span>Packaging</span>
                  <b className="num">−{money(c.packaging)}</b>
                </div>
                <div>
                  <span>
                    <b>{keepWord(d) === "Lose" ? "You lose" : "You keep"}</b>
                  </span>
                  <b className="num" style={{ color: "var(--brand)" }}>
                    {money(Math.abs(d.unitProfit))}
                  </b>
                </div>
              </div>
            ) : (
              <p className="sub">
                The profit is not known yet: {d.notes.join("; ")}.
              </p>
            )}
          </div>
        </div>
      </>
    );
  };

  // ---------- profile ----------
  const vProfile = () => (
    <>
      <div className="titlebar">
        <div>
          <h1>Profile and settings</h1>
          <p>
            This is what Bounty uses to work out your finds, costs and alerts.
            It is saved on this device.
          </p>
        </div>
      </div>
      <div className="two">
        <div className="panel">
          <div className="pf-head">
            <span className="avatar huge">{avatar}</span>
            <div>
              <input
                className="obin"
                style={{
                  margin: "0 0 10px",
                  textTransform: "none",
                  fontSize: 18,
                  display: "block",
                  width: "100%",
                }}
                aria-label="Your name"
                placeholder="Your name"
                value={name}
                onChange={(e) => (
                  setName(e.target.value),
                  store("bounty-name", e.target.value)
                )}
              />
              <PhotoInput
                label={photo ? "Change photo" : "Add a photo"}
                onPhoto={setPhotoSaved}
              />{" "}
              {photo && (
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => setPhotoSaved(null)}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          <p className="sub" style={{ fontSize: 13 }}>
            Your photo will show on tips you report, so other members can see
            who found it.
          </p>
        </div>
        <div className="panel">
          <h3>How you flip</h3>
          <div className="set">
            <span>Home area</span>
            <b>
              {area} · {radius} miles{" "}
              <button
                type="button"
                className="linkbtn"
                onClick={() => (setObStep(1), setOnboard(true))}
              >
                Change
              </button>
            </b>
          </div>
          <div className="set">
            <span>Getting around</span>
            <div className="seg">
              {TRAVEL.map(([l, mode]) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={profile.transport === mode}
                  onClick={() => setTravel(mode)}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="set">
            <span>You sell as</span>
            <div className="seg">
              {["Private", "Business"].map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={seller === s}
                  onClick={() => (setSeller(s), store("bounty-seller", s))}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <p className="sub" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
            Profit uses selling fees of {percent(profile.feeRate)} plus{" "}
            {money(profile.feeFixed)} a sale. Change them in the trip planner.
            Travel is shown on each deal and never hides one.
          </p>
        </div>
      </div>
      <div className="two" style={{ marginTop: 20 }}>
        <div className="panel">
          <h3>Alerts</h3>
          {[
            ["finds", "New finds near me"],
            ["tips", "Live tips with places left"],
            ["drops", "Price drops on things I save"],
            ["weekly", "Weekly money summary"],
          ].map(([k, l]) => (
            <label key={k} className="set">
              <span>{l}</span>
              <input
                type="checkbox"
                className="sw"
                checked={!!alertsOn[k]}
                onChange={(e) => {
                  const n = { ...alertsOn, [k]: e.target.checked };
                  setAlertsOn(n);
                  store("bounty-alert-prefs", n);
                }}
              />
            </label>
          ))}
          <p className="sub" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
            Alerts are not sent yet. Your choices are kept for when they are.
          </p>
        </div>
        <div className="panel">
          <h3>Your plan</h3>
          <PlanLine go={(v) => go(v)} wide />
        </div>
      </div>
      {account?.email && (
        <div style={{ marginTop: 20 }}>
          <AccountSettings
            onSignedOut={() => account.signedOut?.()}
            onEmailChanged={() => account.refresh?.()}
          />
        </div>
      )}
      <div className="legacy" style={{ marginTop: 20 }}>
        <div className="planner goals prof-forms">
          <GoalsSettings />
          <BuyingRules />
        </div>
      </div>
    </>
  );

  const vWatching = () => {
    const items = all.filter((d) => saved[d.sku]);
    return (
      <>
        {note}
        <div className="titlebar">
          <div>
            <h1>Saved</h1>
            <p>Finds you saved with the heart. Kept on this device.</p>
          </div>
        </div>
        {items.length ? (
          <div className="grid4">
            {items.map((d) => (
              <Card key={d.sku} d={d} />
            ))}
          </div>
        ) : (
          <div className="crew-note">
            <CrewArt look="insider-idea" />
            <p className="sub">Nothing saved yet. Tap the heart on any find.</p>
          </div>
        )}
      </>
    );
  };

  // ---------- my trip ----------
  const tripUI = () => {
    const ids = Object.keys(trip).filter((s) => bySku.has(s));
    const items = ids.map((s) => bySku.get(s)!);
    const units = ids.reduce((a, s) => a + trip[s], 0);
    const spend = items.reduce((a, d) => a + d.buy * trip[d.sku], 0);
    const keep = items.reduce(
      (a, d) => a + (d.unitProfit ?? 0) * trip[d.sku],
      0,
    );
    const groups = new Map<string, { mi: number | null; items: Deal[] }>();
    items.forEach((d) => {
      const k = d.shop + (d.area ? ", " + d.area : "");
      const g = groups.get(k) ?? { mi: d.miles, items: [] };
      g.items.push(d);
      groups.set(k, g);
    });
    const stops = [...groups.entries()].sort(
      (a, b) => (a[1].mi ?? 99) - (b[1].mi ?? 99),
    );
    const far = Math.max(0, ...stops.map(([, s]) => s.mi ?? 0));
    const miles = stops.length ? +(far * 2 + stops.length * 0.4).toFixed(1) : 0;
    const gotN = ids.filter((s) => got[s]).length;
    const car = profile.transport === "Car" || profile.transport === "Van";
    const tab = (
      <button
        type="button"
        className="mytab"
        aria-expanded={tripOpen}
        onClick={() => setTripOpen(!tripOpen)}
      >
        {going ? "On my trip" : "My trip"}{" "}
        <span style={{ marginRight: "auto", marginLeft: 0 }}>
          <b>
            {going
              ? `${gotN} of ${ids.length} got`
              : `${units} ${units === 1 ? "item" : "items"}`}
          </b>
        </span>
      </button>
    );
    // Nothing on the trip and not out on it: keep the bar out of the way.
    if (!tripOpen && !going && units === 0) return null;
    if (!tripOpen) return tab;
    if (signing)
      return (
        <>
          <div
            className="tripbox"
            role="dialog"
            aria-label="Sign off your trip"
          >
            <div className="thead">
              <div>
                <b>What did you get?</b>
                <small>Nothing goes into Stock until you add it</small>
              </div>
              <button
                type="button"
                className="tx"
                aria-label="Close"
                onClick={() => setSigning(false)}
              >
                ×
              </button>
            </div>
            <SignOff
              ticked={items.filter((d) => got[d.sku])}
              trip={trip}
              onBack={() => setSigning(false)}
              onDone={(added, note = "") => {
                setSigning(false);
                setTrip({});
                setGot({});
                setGoing(false);
                setTripOpen(false);
                go("stock");
                say(
                  added
                    ? `Added ${added} ${added === 1 ? "item" : "items"} to Stock.${note}`
                    : "Trip finished. Nothing was added to Stock.",
                );
              }}
            />
          </div>
          {tab}
        </>
      );
    const qty = (s: string, by: number) =>
      setTrip((t) => {
        const n = { ...t, [s]: (t[s] ?? 0) + by };
        if (n[s] <= 0) {
          delete n[s];
          setGot((g) => {
            const x = { ...g };
            delete x[s];
            return x;
          });
        }
        return n;
      });
    return (
      <>
        <div className="tripbox" role="dialog" aria-label="My trip">
          <div className="thead">
            <div>
              <b>{going ? "On my trip" : "My trip"}</b>
              <small>
                {ids.length
                  ? `${stops.length} ${stops.length === 1 ? "shop" : "shops"} · about ${miles} miles round trip`
                  : "Nothing added yet"}
              </small>
            </div>
            <button
              type="button"
              className="tx"
              aria-label="Close"
              onClick={() => setTripOpen(false)}
            >
              ×
            </button>
          </div>
          {ids.length ? (
            <>
              <div className="tsum">
                <div>
                  <small>You spend</small>
                  <b>{money(spend)}</b>
                </div>
                <div>
                  <small>You keep</small>
                  <b style={{ color: "var(--brand)" }}>{money(keep)}</b>
                </div>
                <div>
                  <small>Units</small>
                  <b>{units}</b>
                </div>
              </div>
              {going && (
                <div className="bar" style={{ margin: "0 18px 6px" }}>
                  <i
                    style={{
                      width: `${Math.round((gotN / ids.length) * 100)}%`,
                    }}
                  />
                </div>
              )}
              <div className="tlist">
                {stops.map(([shopName, s], i) => (
                  <React.Fragment key={shopName}>
                    <div className="tstop">
                      <span className="sn">{i + 1}</span>
                      <b>{shopName}</b>
                      <small>{s.mi !== null ? `${s.mi} mi` : ""}</small>
                    </div>
                    {s.items.map((d) => (
                      <div
                        key={d.sku}
                        className={"trow " + (got[d.sku] ? "got" : "")}
                      >
                        {going ? (
                          <button
                            type="button"
                            className="tick"
                            aria-pressed={!!got[d.sku]}
                            aria-label="Got it"
                            onClick={() =>
                              setGot({ ...got, [d.sku]: !got[d.sku] })
                            }
                          >
                            {got[d.sku] ? "✓" : ""}
                          </button>
                        ) : (
                          pic(d, "mini")
                        )}
                        <div className="tname">
                          <b>{d.name}</b>
                          <small>
                            {money(d.buy)} each · keep{" "}
                            {money(d.unitProfit ?? 0)} each
                            {d.walkAway !== null
                              ? ` · walk away above ${money(d.walkAway)}`
                              : ""}
                          </small>
                        </div>
                        <div className="qty">
                          <button
                            type="button"
                            aria-label="One fewer"
                            onClick={() => qty(d.sku, -1)}
                          >
                            −
                          </button>
                          <span>{trip[d.sku]}</span>
                          <button
                            type="button"
                            aria-label="One more"
                            onClick={() => qty(d.sku, 1)}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
              <p className="tfoot">
                {car && profile.perMile
                  ? `Fuel about ${money(Math.round(miles * profile.perMile))} ${byMode(profile.transport)}. `
                  : `Travel ${byMode(profile.transport)}. `}
                Shown for information, it never hides a deal.
              </p>
              <div className="tbtns">
                {going ? (
                  <>
                    <button
                      type="button"
                      className="bt ghost"
                      onClick={() => setGoing(false)}
                    >
                      Pause trip
                    </button>
                    <button
                      type="button"
                      className="bt"
                      onClick={() => setSigning(true)}
                    >
                      Finish trip
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="bt ghost"
                      onClick={() => (setTripOpen(false), go("planner"))}
                    >
                      Full plan
                    </button>
                    <button
                      type="button"
                      className="bt green"
                      onClick={() => setGoing(true)}
                    >
                      Start trip
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="tempty">
              Tap <b>+</b> on any find to add it here. Bounty groups your finds
              by shop and puts the closest first.
            </div>
          )}
        </div>
        {tab}
      </>
    );
  };

  // ---------- first open ----------
  const onboarding = onboard ? (
    <div className="obscrim">
      <div className="ob" role="dialog" aria-label="Set up Bounty">
        <img
          className="ob-crew"
          src="/crew/crew-group.jpg"
          alt="The Bounty crew together: the Boss, the Scout, the Hauler, the Insider, the Fixer and the Negotiator"
        />
        {obStep === 1 ? (
          <>
            <small>1 of 2</small>
            <h2>Where do you hunt?</h2>
            <p>
              Your postcode lets us show deals in shops near you. It stays on
              this device.
            </p>
            <input
              className="obin"
              placeholder="e.g. SE1 7PB"
              value={postcode}
              autoComplete="postal-code"
              onChange={(e) => setPostcode(e.target.value)}
            />
            <div className="seg obseg">
              {[3, 5, 10, 25].map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={radius === r}
                  onClick={() => setRadius(r)}
                >
                  {r} miles
                </button>
              ))}
            </div>
            <button
              type="button"
              className="bt obgo"
              onClick={() => setObStep(2)}
            >
              Next
            </button>
          </>
        ) : (
          <>
            <small>2 of 2</small>
            <h2>How do you get around?</h2>
            <p>This sets your travel costs. It never hides a deal.</p>
            <div className="obtiles">
              {TRAVEL.map(([l, mode, d]) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={obTravel === mode}
                  onClick={() => setObTravel(mode)}
                >
                  <b>{l}</b>
                  <small>{d}</small>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="bt obgo"
              disabled={!obTravel}
              onClick={() => finishOnboard()}
            >
              Show my deals
            </button>
            <button
              type="button"
              className="linkbtn"
              onClick={() => setObStep(1)}
            >
              Back
            </button>
          </>
        )}
        <button
          type="button"
          className="linkbtn obskip"
          onClick={() => finishOnboard()}
        >
          Skip for now
        </button>
      </div>
    </div>
  ) : null;
  function finishOnboard() {
    setOnboard(false);
    store("bounty-onboarded", true);
    const pc = postcode.trim().toUpperCase();
    setPostcode(pc);
    store("bounty-postcode", pc);
    if (obTravel) setTravel(obTravel);
  }

  // ---------- page ----------
  const item = sku ? bySku.get(sku) : undefined;
  let body: React.ReactNode;
  if (view === "deals")
    body = cat === null && lens === "simple" && !list ? vHome() : vList();
  else if (view === "item")
    body = item ? (
      vItem(item)
    ) : deals ? (
      <p className="sub">That find is no longer listed.</p>
    ) : null;
  else if (view === "profile") body = vProfile();
  else if (view === "watching") body = vWatching();
  else if (view === "blocks") body = <Blocks />;
  else if (view === "scan") body = <Scan />;
  else if (view === "tips") body = <TipsScreen go={(v) => go(v)} />;
  else if (view === "admin" || view === "sources")
    body = operator ? (
      <Admin />
    ) : (
      <div className="crew-note">
        <p className="sub">
          Admin is for Bounty's operators only. Sign in with an operator
          account to use it.
        </p>
      </div>
    );
  else if (view === "plans") body = <PlansScreen />;
  else if (view === "help") body = <Help email={account?.email} />;
  else if (view === "terms") body = <Terms />;
  else if (view === "privacy") body = <Privacy />;
  else if (view === "crew") body = <CrewScreen go={(v) => go(v)} />;
  else if (view === "research")
    body = (
      <PlanGate
        feature="research"
        title="Research"
        tint="butter"
        what="Check one find properly before you buy: the exact item, what it really sold for, your costs and fees, and a straight answer."
        go={(v) => go(v)}
      >
        <div className="rs">
          <PageHead
            title="Research"
            tint="butter"
            lead="Check one find properly before you buy: the exact item, what it really sold for, your costs and fees, and a straight answer."
          />
          <div className="legacy">{legacy(view)}</div>
        </div>
      </PlanGate>
    );
  else if (view === "planner")
    body = (
      <PlanGate
        feature="trip"
        title="My trip"
        tint="pistachio"
        what="Plan the route shop by shop, with fuel, time and cash, and see whether the trip is worth it before you set off."
        go={(v) => go(v)}
      >
      <TripPage
        deals={all}
        trip={trip}
        setTrip={setTrip}
        profile={profile}
        going={going}
        onStart={() => (setGoing(true), setTripOpen(true))}
        onFinish={() => (setTripOpen(true), setSigning(true))}
        openDeal={(s) => go("item", s)}
        say={say}
        go={(v) => go(v)}
        legacy={legacy(view)}
      />
      </PlanGate>
    );
  else if (view === "stock")
    body = <StockScreen legacy={legacy(view)} go={(v) => go(v)} />;
  else if (view === "money")
    body = (
      <MoneyScreen
        lens={lens}
        lensButtons={<LensBtns lens={lens} setLens={setLens} />}
        go={(v) => go(v)}
      />
    );


  return (
    <div ref={rootRef} className="bx side-yt" data-tab={view}>
      <div className={"frame" + (open ? " open" : "")}>
        {strip}
        <div className="scrim" onClick={() => setOpen(false)} />
        <div className="page">
          {header}
          {onboarding}
          <main className="wrap">
            {lost && (
              <div className="crew-note crew-lost" role="status">
                <CrewArt look="scout-map" />
                <div>
                  <p className="crew-lost-title">That page has wandered off.</p>
                  <p className="sub">The link may be old or mistyped, so here are today's deals instead.</p>
                </div>
              </div>
            )}
            {error && <p className="note">{error}</p>}
            {!deals && !error && (view === "deals" || view === "item") && (
              <CrewLoading look="scout-search">Looking for deals…</CrewLoading>
            )}
            {body}
            <SiteFoot />
          </main>
          <nav className="phone-nav" aria-label="Sections">
            {(
              [
                ["deals", "Deals", ""],
                ["tips", "Tips", ""],
                ["scan", "Scan", "sc"],
                ["stock", "Stock", ""],
                ["money", "Money", ""],
              ] as [View, string, string][]
            ).map(([k, t, c]) => (
              <button
                key={k}
                type="button"
                className={c}
                aria-current={view === k || (k === "deals" && view === "item")}
                onClick={() => go(k)}
              >
                <Ico n={k} />
                {t}
              </button>
            ))}
          </nav>
          {tripUI()}
          {toast && <div className="toast">{toast}</div>}
        </div>
      </div>
    </div>
  );
}

type LiveTip = {
  id: number;
  title: string;
  barcode: string | null;
  retailer: string | null;
  locality: string;
  sample: boolean;
  status: string;
  cap: number;
  remaining: number;
};

const CHATS: [string, string, string, string][] = [
  ["Priya K.", "Diamond", "Still 8 left on the end aisle", "4 min"],
  [
    "Local flippers",
    "12 members",
    "Anyone checked the retail park today?",
    "18 min",
  ],
  ["Dan W.", "Sapphire", "Thanks for confirming my tip!", "1 hr"],
];

function MegaMenu({ go }: { go: (v: View) => void }) {
  const it = (k: View, l: string, sub: string) => (
    <button key={l} type="button" className="mmi" onClick={() => go(k)}>
      <b>{l}</b>
      <small>{sub}</small>
    </button>
  );
  return (
    <div className="pop megapop">
      <div className="mmc">
        <h4>Hunt</h4>
        {it("scan", "Scan", "Check a price in the shop")}
        {it("deals", "Deals", "What to buy today")}
        {it("tips", "Tips", "Finds from other scouts")}
      </div>
      <div className="mmc">
        <h4>Your stuff</h4>
        {it("stock", "Stock", "What you bought, what sold")}
        {it("money", "Money", "Profit, goals and cash")}
        {it("watching", "Saved", "Finds you saved")}
      </div>
      <div className="mmc">
        <h4>Tools</h4>
        {it("planner", "My trip", "Plan it and check it is worth it")}
        {it("research", "Research", "Look up any product")}
      </div>
      <div className="mmc">
        <h4>Account</h4>
        {it("profile", "Alerts", "What we tell you about")}
        {it("profile", "Profile and settings", "Area, travel, photo")}
        {it("plans", "Plans", "Your membership")}
        {it("crew", "The crew", "Top scouts and levels")}
        <div className="mmpts">
          <small>Scout points · sample</small>
          <b>460 · Ruby</b>
          <span>£2 off at 500</span>
        </div>
      </div>
    </div>
  );
}

function LensBtns({
  lens,
  setLens,
}: {
  lens: Lens;
  setLens: (l: Lens) => void;
}) {
  return (
    <div className="lens" role="group" aria-label="How much detail">
      <button
        type="button"
        aria-pressed={lens === "simple"}
        onClick={() => setLens("simple")}
      >
        Simple
      </button>
      <button
        type="button"
        aria-pressed={lens === "pro"}
        onClick={() => setLens("pro")}
      >
        Pro
      </button>
    </div>
  );
}

/** A photo picker that crops to a small square and keeps it on this device. */
function PhotoInput({
  label,
  onPhoto,
}: {
  label: string;
  onPhoto: (p: string) => void;
}) {
  return (
    <label className="photobtn">
      {label}
      <input
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const r = new FileReader();
          r.onload = () => {
            const im = new Image();
            im.onload = () => {
              const c = document.createElement("canvas");
              const s = 160;
              const m = Math.min(im.width, im.height);
              c.width = c.height = s;
              c.getContext("2d")?.drawImage(
                im,
                (im.width - m) / 2,
                (im.height - m) / 2,
                m,
                m,
                0,
                0,
                s,
                s,
              );
              onPhoto(c.toDataURL("image/jpeg", 0.85));
            };
            im.src = String(r.result);
          };
          r.readAsDataURL(f);
        }}
      />
    </label>
  );
}

function ProTable({
  list,
  open,
  pic,
}: {
  list: Deal[];
  open: (sku: string) => void;
  pic: (d: Deal, cls: string) => React.ReactNode;
}) {
  return (
    <table className="ptable">
      <thead>
        <tr>
          <th>Product</th>
          <th>Verdict</th>
          <th className="r">Shop</th>
          <th className="r">Sells for</th>
          <th className="r">You keep</th>
          <th className="r">Return</th>
          <th className="r">Walk away above</th>
          <th className="r">Sales</th>
          <th className="r">Listed now</th>
          <th className="r">Shelf</th>
          <th className="r">Distance</th>
        </tr>
      </thead>
      <tbody>
        {list.map((d) => (
          <tr
            key={d.sku}
            onClick={() => open(d.sku)}
            style={{ cursor: "pointer" }}
          >
            <td>
              <span className="it">
                {pic(d, "mini")}
                <span>
                  <b>{d.name}</b>
                  <br />
                  <small style={{ color: "var(--muted)" }}>
                    {d.shop}
                    {d.area ? ", " + d.area : ""}
                    {d.sample ? " · sample" : ""}
                  </small>
                </span>
              </span>
            </td>
            <td>
              <span className={"vp " + d.verdict}>{VL[d.verdict]}</span>
            </td>
            <td className="r num">{money(d.buy)}</td>
            <td className="r num">
              {d.salePrice === null ? "–" : money(d.salePrice)}
            </td>
            <td
              className="r num"
              style={{ color: "var(--brand)", fontWeight: 700 }}
            >
              {d.unitProfit === null ? "–" : money(d.unitProfit)}
            </td>
            <td className="r num">
              {d.returnOnCost === null ? "–" : percent(d.returnOnCost)}
            </td>
            <td className="r num">
              {d.walkAway === null ? "–" : money(d.walkAway)}
            </td>
            <td className="r num">{d.sales.length}</td>
            <td className="r num">{d.competingListings ?? "–"}</td>
            <td className="r num">{d.stock ?? "–"}</td>
            <td className="r num">
              {d.miles === null ? "–" : `${d.miles} mi`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Prices on one scale: the shop price, every completed sale and the
 * walk-away price. Real figures only; there is no history to draw yet.
 */
function PriceStrip({ d }: { d: Deal }) {
  const W = 760;
  const H = 150;
  const l = 24;
  const r = 24;
  const vals = [
    d.buy,
    ...d.sales,
    ...(d.walkAway !== null ? [d.walkAway] : []),
  ];
  const lo = Math.min(...vals) * 0.85;
  const hi = Math.max(...vals) * 1.1;
  const x = (v: number) => l + ((W - l - r) * (v - lo)) / (hi - lo || 1);
  const ticks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v / 100) * 100);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Shop price, completed sales and walk-away price on one scale"
    >
      <line
        x1={l}
        x2={W - r}
        y1={90}
        y2={90}
        stroke="var(--line)"
        strokeWidth={2}
      />
      {ticks.map((v) => (
        <text
          key={v}
          x={x(v)}
          y={128}
          fontSize="12"
          textAnchor="middle"
          fill="var(--muted)"
        >
          {money(v)}
        </text>
      ))}
      {d.walkAway !== null && (
        <line
          x1={x(d.walkAway)}
          x2={x(d.walkAway)}
          y1={30}
          y2={104}
          stroke="var(--ask)"
          strokeWidth={1.6}
          strokeDasharray="6 5"
        />
      )}
      {d.sales.map((s, i) => (
        <circle
          key={i}
          cx={x(s)}
          cy={90 - (i % 3) * 14}
          r={6}
          fill="var(--brand)"
          fillOpacity={0.75}
        />
      ))}
      <circle
        cx={x(d.buy)}
        cy={90}
        r={8}
        fill="#fff"
        stroke="var(--blue)"
        strokeWidth={3}
      />
      <text
        x={x(d.buy)}
        y={64}
        fontSize="12.5"
        fontWeight="700"
        textAnchor="middle"
        fill="var(--blue)"
      >
        {money(d.buy)}
      </text>
    </svg>
  );
}
