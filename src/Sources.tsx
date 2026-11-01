import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, money, dateTime } from "./api";
import "./Sources.css";

// Shapes returned by server/routes-evidence.mjs.
type Run = {
  id: number;
  provider: string;
  mode: "scheduled" | "manual" | "lookup";
  query: string | null;
  started: string;
  finished: string | null;
  ok: boolean;
  rows: number;
  error: string | null;
  cached: boolean;
};
type Source = {
  provider: string;
  name: string;
  kind: string;
  licence: string;
  mode: "public" | "file" | "credential";
  credential: string | null;
  status: string;
  command: string;
  upstream: string;
  cacheHours: number | null;
  lastRun: Run | null;
  lastSuccess: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  rows: number;
  stale: boolean;
};
type Permission = {
  provider: string;
  programme: string;
  display: boolean;
  note: string | null;
  updated: string;
};
type Observation = {
  id: number;
  title: string;
  store: string | null;
  place: string | null;
  city: string | null;
  osm_id: string | null;
  price: number;
  regular_price: number | null;
  discounted: boolean;
  discount_type: string | null;
  day: string;
  unit: string | null;
  quantity: string | null;
  barcode: string | null;
  proof_id: string | null;
  imported: string;
  first_imported: string;
};
type Page<T> = { rows: T[]; total: number };

const PAGE = 100;
const later = (a: string | null, b: string | null) =>
  Boolean(a && b && Date.parse(a) > Date.parse(b));
const words = (value: string) => value.toLowerCase().replace(/_/g, " ");

function statusBadge(source: Source) {
  const ready = source.mode !== "credential" || source.status === "Credential configured";
  return <span className={"badge " + (ready ? "ok" : "warn")}>{source.status}</span>;
}

function SourceRow({ source }: { source: Source }) {
  const errorResolved = later(source.lastSuccess, source.lastErrorAt);
  return (
    <div className="source-row">
      <div>
        <b>{source.name}</b>
        <small className="muted">
          {source.kind} · {source.licence}
        </small>
        <div className="source-badges">
          {statusBadge(source)}
          {source.stale && <span className="badge warn">Stale: no import in 24 hours</span>}
          {source.cacheHours !== null && (
            <span className="badge">Lookups cached {source.cacheHours} h</span>
          )}
        </div>
      </div>
      <dl className="source-facts">
        <dt>Rows stored</dt>
        <dd>{source.rows.toLocaleString("en-GB")}</dd>
        <dt>Last fetch</dt>
        <dd>{source.lastSuccess ? dateTime(source.lastSuccess) : "never"}</dd>
        <dt>Last error</dt>
        <dd className={source.lastError && !errorResolved ? "warn" : undefined}>
          {source.lastError
            ? source.lastError + (errorResolved ? " (a later fetch succeeded)" : "")
            : "none recorded"}
        </dd>
        <dt>Run with</dt>
        <dd>
          <code>{source.command}</code>
        </dd>
      </dl>
    </div>
  );
}

function RunsTable({ runs }: { runs: Run[] }) {
  if (!runs.length) return <p className="muted">No imports recorded yet.</p>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Source</th>
            <th>Mode</th>
            <th>Query or file</th>
            <th>Result</th>
            <th className="num">Rows</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{dateTime(r.started)}</td>
              <td>{r.provider}</td>
              <td>{r.mode}</td>
              <td>{r.query || ""}</td>
              <td>
                {!r.ok ? (
                  <span className="warn">Failed: {r.error || "no detail"}</span>
                ) : r.cached ? (
                  <span>Reused cached rows, no network call</span>
                ) : (
                  <span className="ok">Saved</span>
                )}
              </td>
              <td className="num">{r.rows}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Permissions({
  sources,
  permissions,
  onSaved,
}: {
  sources: Source[];
  permissions: Permission[];
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState("awin");
  const [programme, setProgramme] = useState("");
  const [display, setDisplay] = useState("false");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api("permissions", {
        provider,
        programme: programme.trim(),
        display: display === "true",
        note: note.trim() || null,
      });
      setMessage("Saved.");
      setProgramme("");
      setNote("");
      onSaved();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const name = (key: string) => sources.find((s) => s.provider === key)?.name || key;
  return (
    <>
      <p>
        Record what each source's terms allow you to show. For licensed feeds, provider data
        and self-reported sales, no record means display is not permitted, so no buy alert can
        pass. A record for one programme (for example an Awin advertiser, entered exactly as the
        merchant name in the feed) overrides the record for the whole source. Open Prices data
        is published under the ODbL, which permits display with attribution.
      </p>
      <form className="permission-form" onSubmit={save}>
        <label>
          Source
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {sources.map((s) => (
              <option key={s.provider} value={s.provider}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Programme (blank for the whole source)
          <input value={programme} maxLength={200} onChange={(e) => setProgramme(e.target.value)} />
        </label>
        <label>
          Display
          <select value={display} onChange={(e) => setDisplay(e.target.value)}>
            <option value="false">Not permitted</option>
            <option value="true">Permitted</option>
          </select>
        </label>
        <label>
          Evidence or note
          <input
            value={note}
            maxLength={500}
            placeholder="Where the permission is written down"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button disabled={busy}>Save permission</button>
      </form>
      {message && <p role="status">{message}</p>}
      {!permissions.length ? (
        <p className="muted">No permissions recorded yet.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Programme</th>
                <th>Display</th>
                <th>Note</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {permissions.map((p) => (
                <tr key={p.provider + "\u0000" + p.programme}>
                  <td>{name(p.provider)}</td>
                  <td>{p.programme || "Whole source"}</td>
                  <td>
                    <span className={"badge " + (p.display ? "ok" : "warn")}>
                      {p.display ? "Permitted" : "Not permitted"}
                    </span>
                  </td>
                  <td>{p.note || ""}</td>
                  <td>{dateTime(p.updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function priceLabel(o: Observation) {
  return o.unit ? money(o.price) + " per " + words(o.unit) : money(o.price) + " per item";
}

function ObservationRow({ o }: { o: Observation }) {
  const place = [o.store || "Store not named", o.city, o.place].filter(Boolean).join(" · ");
  return (
    <div className="row observation">
      <span>
        <b>{o.title}</b>
        <small>{place}</small>
        <small>
          Observed {dateTime(o.day)} · Imported {dateTime(o.imported)}
          {o.quantity && " · Quantity " + o.quantity}
          {o.barcode && " · Barcode " + o.barcode}
          {o.proof_id && " · Proof #" + o.proof_id}
        </small>
      </span>
      <span className="observation-price">
        <b>{priceLabel(o)}</b>
        {o.discounted && (
          <small>
            <span className="badge warn">
              Promotion{o.discount_type ? ": " + words(o.discount_type) : ""}
            </span>
            {o.regular_price !== null && "Regular " + money(o.regular_price)}
          </small>
        )}
      </span>
    </div>
  );
}

function Observations() {
  const [barcode, setBarcode] = useState("");
  const [page, setPage] = useState<Page<Observation>>({ rows: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const valid = /^\d*$/.test(barcode.trim());
  useEffect(() => {
    if (!valid) return;
    let active = true;
    const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (barcode.trim()) query.set("barcode", barcode.trim());
    api<Page<Observation>>("observations?" + query)
      .then((data) => {
        if (!active) return;
        setPage(data);
        setError("");
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [barcode, offset, valid]);
  return (
    <>
      <p className="notice">
        Historical evidence, not verified stock. Each row is a price someone recorded on the
        date shown. It does not mean the item is on the shelf today, and a promotion may need a
        loyalty card. Check the observation date and price unit before planning a trip.
      </p>
      <p className="muted">
        Data from <a href="https://prices.openfoodfacts.org/">Open Prices</a> (Open Food Facts),
        available under the{" "}
        <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL)</a>.
        Kept apart from licensed feed data.
      </p>
      <label>
        Filter by barcode
        <input
          inputMode="numeric"
          value={barcode}
          onChange={(e) => {
            setBarcode(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      {!valid && <p role="alert">A barcode contains digits only.</p>}
      {error && <p role="alert">{error}</p>}
      {valid && !error && (
        <p className="muted">
          {page.total
            ? `Showing ${offset + 1} to ${offset + page.rows.length} of ${page.total.toLocaleString("en-GB")} UK observations, newest first.`
            : barcode.trim()
              ? "No observations for this barcode."
              : "No observations imported. Run npm run worker and reopen this tab."}
        </p>
      )}
      {page.rows.map((o) => (
        <ObservationRow key={o.id} o={o} />
      ))}
      {page.total > PAGE && (
        <div className="pager">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Newer
          </button>
          <button
            disabled={offset + PAGE >= page.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Older
          </button>
        </div>
      )}
    </>
  );
}

export default function Sources() {
  const [sources, setSources] = useState<Source[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    Promise.all([
      api<{ sources: Source[]; runs: Run[] }>("sources"),
      api<{ permissions: Permission[] }>("permissions"),
    ])
      .then(([s, p]) => {
        setSources(s.sources);
        setRuns(s.runs);
        setPermissions(p.permissions);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  return (
    <div className="stack sources">
      {error && <p role="alert">{error}</p>}
      <section>
        <small>01 / SOURCE READINESS</small>
        <h2>Sources</h2>
        <p>
          Public observations import on a schedule. Credentialed lookups run only when you start
          them from the command line, are cached locally and never send a key to the browser.
          "Credential configured" means a value is set on the server, not that the provider
          accepted it. A feed or online catalogue never confirms that a branch has stock.
        </p>
        <p className="muted">
          eBay asking prices count as current competition for 7 days after the lookup that saw
          them. After that, competition is shown as not known until you run the lookup again. A
          copy of one of the repository's sample files is refused on import, so example data
          never becomes evidence.
        </p>
        {sources.map((s) => (
          <SourceRow key={s.provider} source={s} />
        ))}
        <button onClick={load}>Refresh</button>
      </section>
      <section>
        <small>02 / IMPORT HISTORY</small>
        <h2>Recent import runs</h2>
        <RunsTable runs={runs} />
      </section>
      <section>
        <small>03 / DISPLAY PERMISSIONS</small>
        <h2>Permission to display</h2>
        <Permissions sources={sources} permissions={permissions} onSaved={load} />
      </section>
      <section>
        <small>04 / OPEN PRICES</small>
        <h2>UK price observations</h2>
        <Observations />
      </section>
    </div>
  );
}
