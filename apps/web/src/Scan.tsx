import { privateSession } from "./private-storage";
import React, { useEffect, useRef, useState } from "react";
import { api, loadLens, money, percent, saveLens, toPence, type Lens } from "./api";
import { savedExtras, type Deal } from "./Deals";
import { VERDICT_LABEL, type Verdict } from "./Verdict";
import {
  Answer as AnswerCard,
  Button,
  Card,
  Field,
  Figure,
  Figures,
  Input,
  Label,
  MoneyInput,
  Notice,
  PageHead,
  Rows,
  Row,
  Segmented,
  Stepper,
} from "./ui/kit";
import { CrewArt } from "./proto/CrewArt";
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

// The camera reader. Chrome on Android has one built in; iPhones and other
// browsers get the same reader from the free ZXing library (barcode-detector,
// MIT), loaded only when the camera is first used. Its .wasm file is served
// from this site, never a CDN.
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (o?: unknown) => Detector;
const NativeDetector = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
async function makeDetector(): Promise<Detector> {
  if (NativeDetector) {
    const supported: string[] | undefined = await (
      NativeDetector as unknown as { getSupportedFormats?: () => Promise<string[]> }
    ).getSupportedFormats?.().catch((): string[] => []);
    if (!supported || FORMATS.some((f) => supported.includes(f))) return new NativeDetector({ formats: FORMATS });
  }
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import("barcode-detector/ponyfill"),
    import("zxing-wasm/reader/zxing_reader.wasm?url"),
  ]);
  prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
  });
  return new BarcodeDetector({ formats: FORMATS as never }) as unknown as Detector;
}
// Any browser that can open the camera can scan.
const canUseCamera = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

const TALLY_KEY = "bounty-scan-tally";
function loadTally(): Taken[] {
  try {
    const v = JSON.parse(privateSession.getItem(TALLY_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveTally(t: Taken[]) {
  try {
    privateSession.setItem(TALLY_KEY, JSON.stringify(t));
  } catch {
    // The tally still works for this visit.
  }
}

export default function Scan() {
  const [lens, setLensState] = useState<Lens>(loadLens);
  // Six sample items to try; the rest behind a button so the phone page stays short.
  const [allSamples, setAllSamples] = useState(false);
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
    const t = price.trim().replace(/[£,\s]/g, "");
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
    <div className="sc">
      <PageHead
        title="Scan"
        tint="periwinkle"
        lead={
          lens === "pro"
            ? "Rapid scan: answer, quantity, next. Your running total stays below."
            : "Scan or type a barcode, add the sticker price, and get a straight answer: buy, think or leave."
        }
        aside={
          <Segmented
            label="How much detail"
            value={lens}
            onChange={(l) => setLens(l as Lens)}
            options={[
              ["simple", "Simple"],
              ["pro", "Pro"],
            ]}
          />
        }
      />

      <div className="sc-grid">
        <Card className="sc-form">
          {canUseCamera && <Camera onCode={(c) => (setCode(c), check({ barcode: c }))} />}
          <form
            className="k-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) check({ barcode: code.trim() });
            }}
          >
            <Field label="Barcode" htmlFor="scan-code" hint={canUseCamera ? undefined : "This browser cannot open the camera, so type the digits under the bars."}>
              <Input
                id="scan-code"
                inputMode="numeric"
                autoComplete="off"
                value={code}
                placeholder="The digits under the bars"
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <Field label="Sticker price (optional)" htmlFor="scan-price" hint="With the price you get buy, think or leave. Without it, the walk-away price.">
              <MoneyInput id="scan-price" value={price} placeholder="4.50" onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Button variant="main" type="submit" disabled={busy || !code.trim()}>
              {busy ? "Checking…" : "Check"}
            </Button>
          </form>
          {samples.length > 0 && (
            <div className="sc-samples">
              <Label>Try a sample item</Label>
              <div className="sc-chips">
                {(allSamples ? samples : samples.slice(0, 6)).map((d) => (
                  <Button key={d.sku} size="sm" disabled={busy} onClick={() => check({ sku: d.sku })}>
                    {d.name}
                  </Button>
                ))}
                {samples.length > 6 && (
                  <Button size="sm" variant="text" onClick={() => setAllSamples(!allSamples)}>
                    {allSamples ? "Fewer" : `${samples.length - 6} more`}
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>

        <div className="sc-side" ref={answer} tabIndex={-1} aria-live="polite">
          {error && (
            <Notice tone="warn" title="Check the details.">
              {error}
            </Notice>
          )}
          {result ? (
            result.found ? (
              <Answer result={result} lens={lens} units={units} setUnits={setUnits} onTake={take} onSkip={() => setResult(null)} />
            ) : (
              <Card className="sc-unknown">
                <span className="k-display sc-word">{VERDICT_LABEL.unknown}</span>
                <p className="sc-p">{result.reason}. Bounty never guesses an item it has no completed sales for.</p>
                <div>
                  <a className="k-btn line" href="#Research">
                    Check it in Research
                  </a>
                </div>
              </Card>
            )
          ) : (
            !error && (
              <div className="sc-wait has-art">
                <div className="sc-wait-text">
                  <span className="k-display">Ready when you are</span>
                  <p>Your answer shows here: what you keep, what it sells for, and the price to walk away above.</p>
                </div>
                <CrewArt look="scout-lookout" />
              </div>
            )
          )}
          {lens === "pro" && <Tally tally={tally} onClear={clearTally} />}
        </div>
      </div>
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
  const facts: [string, React.ReactNode][] = [
    ["You keep", money(d.unitProfit)],
    ["Sticker", money(result.shelfPrice)],
    ["Sells for", money(d.salePrice)],
  ];
  if (lens === "pro")
    facts.push(
      ["Return", d.returnOnCost === null ? "Not known" : percent(d.returnOnCost)],
      ["Completed sales", String(d.sales.length)],
      ["Listed now", d.competingListings === null ? "Not known" : String(d.competingListings)],
    );
  const verdict = d.verdict === "unknown" ? null : d.verdict;
  const body = (
    <>
      {d.walkAway !== null && (
        <p className="sc-walk">
          Walk away if the sticker says more than <b>{money(d.walkAway)}</b>
        </p>
      )}
      {d.sample && <p className="sc-p">Sample item: these figures are illustrations, not a real deal.</p>}
      <p className="sc-share">
        <b>Coming soon:</b> sticker prices you scan will be shared with scouts near you and earn you scout
        points. Nothing is shared yet.
      </p>
      {lens === "pro" && canTake ? (
        <div className="sc-take">
          <span>
            Take how many?{shelf !== null && <small> {shelf} on the shelf</small>}
          </span>
          <Stepper label={d.name} value={units} min={1} onChange={(n) => setUnits(shelf !== null ? Math.min(shelf, n) : n)} />
          <Button variant="line" onClick={onSkip}>
            Skip
          </Button>
          <Button variant="main" onClick={onTake}>
            Take {units}
          </Button>
        </div>
      ) : (
        <div className="sc-acts">
          <Button variant="main" onClick={onSkip}>
            Scan the next one
          </Button>
          <a className="k-btn line" href="#Deals">
            See all deals
          </a>
        </div>
      )}
    </>
  );
  return verdict ? (
    <AnswerCard
      verdict={verdict}
      headline={`${d.name}${d.variant ? ", " + d.variant : ""}`}
      why={d.reason + "."}
      facts={facts}
    >
      {body}
    </AnswerCard>
  ) : (
    <Card className="sc-unknown">
      <span className="k-display sc-word">{VERDICT_LABEL.unknown}</span>
      <b>{d.name}</b>
      <p className="sc-p">{d.reason}.</p>
      {body}
    </Card>
  );
}

function Tally({ tally, onClear }: { tally: Taken[]; onClear: () => void }) {
  const units = tally.reduce((a, t) => a + t.units, 0);
  const spend = tally.reduce((a, t) => a + t.units * t.unitCost, 0);
  const profit = tally.reduce((a, t) => a + t.units * t.unitProfit, 0);
  return (
    <Card>
      <Label
        aside={
          tally.length > 0 && (
            <Button variant="text" size="sm" onClick={onClear}>
              Start again
            </Button>
          )
        }
      >
        This session
      </Label>
      {tally.length === 0 ? (
        <p className="sc-p">Items you take stack up here with a running total, so you can keep scanning.</p>
      ) : (
        <>
          <Figures>
            <Figure label="Units" value={String(units)} />
            <Figure label="Spend" value={money(spend)} />
            <Figure label="Expected profit" value={money(profit)} tone="profit" />
          </Figures>
          <Rows>
            {tally.map((t, i) => (
              <Row
                key={i}
                badge={t.units}
                tint="periwinkle"
                title={t.name + (t.sample ? " (sample)" : "")}
                sub={`${money(t.unitCost)} each`}
                value={money(t.units * t.unitProfit)}
                tone="profit"
              />
            ))}
          </Rows>
          <p className="sc-small">
            Expected profit uses each item's completed-sale estimate, not a promise. Track the real trip in Stock once
            you have bought.
          </p>
        </>
      )}
    </Card>
  );
}

/** The phone camera, read by the browser's barcode reader or the ZXing one. */
function Camera({ onCode }: { onCode: (code: string) => void }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const report = useRef(onCode);
  report.current = onCode;
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        const detector = await makeDetector();
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
          <Button variant="line" onClick={() => setOn(false)}>
            Stop the camera
          </Button>
        </>
      ) : (
        <Button variant="tab" tint="periwinkle" onClick={() => setOn(true)}>
          Scan with the camera
        </Button>
      )}
      {error && (
        <Notice tone="warn" title="Camera off.">
          {error}
        </Notice>
      )}
    </div>
  );
}
