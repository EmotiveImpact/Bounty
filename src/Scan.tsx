import React, { useEffect, useRef, useState } from "react";
import { api, loadLens, money, percent, saveLens, toPence, type Lens } from "./api";
import { savedExtras, type Deal } from "./Deals";
import { LensSwitch, VERDICT_LABEL, type Verdict } from "./Verdict";
import "./Scan.css";

// Scan in the shop: a barcode (camera or typed) and the price on the sticker
// give a straight answer from completed sales: buy, think or leave, with the
// price to walk away above. A barcode Bounty has no sales for is answered as
// not known, never guessed. Simple shows one big answer; Pro keeps a running
// tally so someone scanning a whole aisle can keep going.

type ScanResult =
  | { found: true; barcode: string | null; shelfPrice: number; deal: Deal }
  | { found: false; barcode: string | null; verdict: Verdict; reason: string };
type Taken = { sku: string; name: string; units: number; unitProfit: number; unitCost: number; sample: boolean };

// The camera reader built into some browsers (Chrome on Android). Others get
// the typed barcode box only.
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
const BarcodeDetectorCtor = (globalThis as unknown as { BarcodeDetector?: new (o?: unknown) => Detector })
  .BarcodeDetector;

const TALLY_KEY = "bounty-scan-tally";
function loadTally(): Taken[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(TALLY_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveTally(t: Taken[]) {
  try {
    sessionStorage.setItem(TALLY_KEY, JSON.stringify(t));
  } catch {
    // The tally still works for this visit.
  }
}

export default function Scan() {
  const [lens, setLensState] = useState<Lens>(loadLens);
  const setLens = (l: Lens) => {
    setLensState(l);
    saveLens(l);
  };
  const [code, setCode] = useState("");
  const [price, setPrice] = useState("");
  const [samples, setSamples] = useState<Deal[]>([]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [units, setUnits] = useState(1);
  const [tally, setTally] = useState<Taken[]>(loadTally);
  const answer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ deals: Deal[] }>("deals")
      .then((r) => setSamples(r.deals.filter((d) => d.sample)))
      .catch(() => setSamples([]));
  }, []);

  const shelfPence = () => {
    const t = price.trim();
    if (!t) return undefined;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) throw Error("Enter the sticker price in pounds, for example 4.50");
    return toPence(n);
  };

  async function check(target: { sku?: string; barcode?: string }) {
    setError("");
    setBusy(true);
    try {
      const r = await api<ScanResult>("scan", { ...savedExtras(), ...target, price: shelfPence() });
      setResult(r);
      setUnits(1);
      requestAnimationFrame(() => answer.current?.focus());
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const take = () => {
    if (!result?.found || result.deal.unitProfit === null) return;
    const d = result.deal;
    const next = [
      ...tally,
      { sku: d.sku, name: d.name, units, unitProfit: d.unitProfit!, unitCost: d.buy, sample: d.sample },
    ];
    setTally(next);
    saveTally(next);
    setResult(null);
    setCode("");
    setPrice("");
  };
  const clearTally = () => {
    setTally([]);
    saveTally([]);
  };

  return (
    <div className="scan">
      <div className="scan-top">
        <p className="muted">
          {lens === "pro"
            ? "Rapid scan: answer, quantity, next. Your running total stays below."
            : "Point, check, decide. Detail is one tap away."}
        </p>
        <LensSwitch lens={lens} onChange={setLens} />
      </div>

      <form
        className="scan-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) check({ barcode: code.trim() });
        }}
      >
        {BarcodeDetectorCtor && <Camera onCode={(c) => (setCode(c), check({ barcode: c }))} />}
        <label htmlFor="scan-code">
          Barcode
          <input
            id="scan-code"
            inputMode="numeric"
            autoComplete="off"
            value={code}
            placeholder="The digits under the bars"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label htmlFor="scan-price">
          Sticker price <small className="muted">optional, in £</small>
          <input
            id="scan-price"
            inputMode="decimal"
            autoComplete="off"
            value={price}
            placeholder="For example 4.50"
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <button type="submit" className="scan-go" disabled={busy || !code.trim()}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>
      {!BarcodeDetectorCtor && (
        <p className="muted scan-small">
          This browser cannot read barcodes with the camera yet, so type the digits. Camera scanning works in Chrome on
          Android today.
        </p>
      )}

      {samples.length > 0 && (
        <div className="scan-samples" role="group" aria-label="Try a sample">
          <span className="muted">Try a sample item:</span>
          {samples.map((d) => (
            <button key={d.sku} type="button" disabled={busy} onClick={() => check({ sku: d.sku })}>
              {d.name}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="notice warn">
          {error}
        </p>
      )}

      {result && (
        <div ref={answer} tabIndex={-1} className="scan-answer" aria-live="polite">
          {result.found ? (
            <Answer
              result={result}
              lens={lens}
              units={units}
              setUnits={setUnits}
              onTake={take}
              onSkip={() => setResult(null)}
            />
          ) : (
            <div className="scan-verdict v-unknown">
              <span className="scan-big">{VERDICT_LABEL.unknown}</span>
              <p>{result.reason}.</p>
              <a href="#Research">Check it in Research</a>
            </div>
          )}
        </div>
      )}

      {lens === "pro" && <Tally tally={tally} onClear={clearTally} />}
    </div>
  );
}

function Answer({
  result,
  lens,
  units,
  setUnits,
  onTake,
  onSkip,
}: {
  result: Extract<ScanResult, { found: true }>;
  lens: Lens;
  units: number;
  setUnits: (n: number) => void;
  onTake: () => void;
  onSkip: () => void;
}) {
  const d = result.deal;
  const shelf = d.stock;
  const canTake = d.unitProfit !== null && d.unitProfit > 0;
  return (
    <>
      <div className={"scan-verdict v-" + d.verdict}>
        <span className="scan-big">{VERDICT_LABEL[d.verdict]}</span>
        <b className="scan-name">
          {d.name}
          {d.variant ? `, ${d.variant}` : ""}
        </b>
        <p>{d.reason}.</p>
        {d.sample && <span className="badge sample">Sample item, not a real deal</span>}
      </div>
      <div className="scan-facts">
        <span>
          <small>You keep</small>
          <b className={d.unitProfit !== null && d.unitProfit <= 0 ? "loss" : "gain"}>{money(d.unitProfit)}</b>
        </span>
        <span>
          <small>Sticker</small>
          <b className="retail">{money(result.shelfPrice)}</b>
        </span>
        <span>
          <small>Sells for</small>
          <b className="sold">{money(d.salePrice)}</b>
        </span>
        {lens === "pro" && (
          <>
            <span>
              <small>Return</small>
              <b>{d.returnOnCost === null ? "–" : percent(d.returnOnCost)}</b>
            </span>
            <span>
              <small>Completed sales</small>
              <b>{d.sales.length}</b>
            </span>
            <span>
              <small>Listed now</small>
              <b>{d.competingListings ?? "–"}</b>
            </span>
          </>
        )}
      </div>
      {d.walkAway !== null && (
        <p className="scan-walk">
          Walk away if the sticker says more than <b>{money(d.walkAway)}</b>
        </p>
      )}
      {lens === "pro" && canTake ? (
        <div className="scan-take">
          <span>
            Take how many?{" "}
            {shelf !== null && <small className="muted">{shelf} on the shelf</small>}
          </span>
          <span className="scan-step">
            <button type="button" aria-label="One fewer" onClick={() => setUnits(Math.max(1, units - 1))}>
              −
            </button>
            <b aria-live="polite">{units}</b>
            <button
              type="button"
              aria-label="One more"
              onClick={() => setUnits(shelf !== null ? Math.min(shelf, units + 1) : units + 1)}
            >
              +
            </button>
          </span>
          <button type="button" className="scan-ghost" onClick={onSkip}>
            Skip
          </button>
          <button type="button" className="scan-go" onClick={onTake}>
            Take {units}
          </button>
        </div>
      ) : (
        <div className="scan-actions">
          <a className="scan-ghost" href="#Deals">
            See all deals
          </a>
          <button type="button" className="scan-go" onClick={onSkip}>
            Scan the next one
          </button>
        </div>
      )}
    </>
  );
}

function Tally({ tally, onClear }: { tally: Taken[]; onClear: () => void }) {
  const units = tally.reduce((a, t) => a + t.units, 0);
  const spend = tally.reduce((a, t) => a + t.units * t.unitCost, 0);
  const profit = tally.reduce((a, t) => a + t.units * t.unitProfit, 0);
  return (
    <section className="scan-tally" aria-label="This scanning session">
      <div className="scan-tally-head">
        <h2>This session</h2>
        {tally.length > 0 && (
          <button type="button" className="scan-ghost" onClick={onClear}>
            Start again
          </button>
        )}
      </div>
      {tally.length === 0 ? (
        <p className="muted">Items you take stack up here with a running total, so you can keep scanning.</p>
      ) : (
        <>
          <div className="scan-facts">
            <span>
              <small>Units</small>
              <b>{units}</b>
            </span>
            <span>
              <small>Spend</small>
              <b className="retail">{money(spend)}</b>
            </span>
            <span>
              <small>Expected profit</small>
              <b className="gain">{money(profit)}</b>
            </span>
          </div>
          <ul>
            {tally.map((t, i) => (
              <li key={i}>
                <span>
                  {t.units} × {t.name}
                  {t.sample ? " (sample)" : ""}
                </span>
                <b>{money(t.units * t.unitProfit)}</b>
              </li>
            ))}
          </ul>
          <p className="muted scan-small">
            Expected profit uses each item's completed-sale estimate, not a promise. Track the real trip in Stock once
            you have bought.
          </p>
        </>
      )}
    </section>
  );
}

/** The phone camera, read by the browser's own barcode reader. */
function Camera({ onCode }: { onCode: (code: string) => void }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const report = useRef(onCode);
  report.current = onCode;
  useEffect(() => {
    if (!on || !BarcodeDetectorCtor) return;
    let stream: MediaStream | null = null;
    let stop = false;
    const detector = new BarcodeDetectorCtor({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stop || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        while (!stop) {
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) {
            report.current(found[0].rawValue);
            setOn(false);
            return;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setError("The camera could not start. Allow camera access, or type the barcode instead.");
        setOn(false);
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [on]);
  return (
    <div className="scan-camera">
      {on ? (
        <>
          <video ref={video} muted playsInline aria-label="Camera view" />
          <button type="button" className="scan-ghost" onClick={() => setOn(false)}>
            Stop the camera
          </button>
        </>
      ) : (
        <button type="button" className="scan-go" onClick={() => setOn(true)}>
          Scan with the camera
        </button>
      )}
      {error && (
        <p role="alert" className="notice warn">
          {error}
        </p>
      )}
    </div>
  );
}
