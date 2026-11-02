// Tips, built from the building blocks (src/ui/kit.tsx): a feed of shelf
// tips from other scouts, each with the one thing to know first (what you
// keep, places left, when the shelf was last seen) and one main button.
// Claiming, reporting the shelf and the eligibility question open in a
// window with the full tip. Operator tools (create a tip, verify reports,
// send alerts, acting as anyone) live on the Admin page.
import React, { useCallback, useEffect, useState } from "react";
import { api, money } from "../api";
import {
  ACTING_KEY,
  AlertInbox,
  BountyCard,
  MemberForm,
  MemberSummary,
  TierTable,
  type BountiesResponse,
  type Bounty,
  type EligibilityReply,
  type MembersResponse,
} from "../Bounties";
import {
  Button,
  Card,
  Chip,
  Empty,
  Figure,
  Figures,
  Label,
  Meter,
  MoreBelow,
  Notice,
  PageHead,
  Select,
  Tabs,
  Window,
  type ChipTone,
} from "../ui/kit";
import "./tips.css";

const ukDay = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" });
function ago(iso: string | null) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}
function readActing(): number | null {
  try {
    const v = localStorage.getItem(ACTING_KEY);
    return v && /^\d+$/.test(v) ? Number(v) : null;
  } catch {
    return null;
  }
}
function writeActing(id: number) {
  try {
    localStorage.setItem(ACTING_KEY, String(id));
  } catch {
    // Still works for this visit.
  }
}

/** The status chip for a tip, in the shared chip words and colours. */
function stateChip(b: Bounty): [string, ChipTone] {
  const s = b.trip.state;
  if (s === "go") return ["Go now", "buy"];
  if (s === "sample") return ["Sample", "sample"];
  if (s === "full") return ["Places full", "leave"];
  if (s === "expired" || s === "withdrawn") return [s === "expired" ? "Ended" : "Withdrawn", "done"];
  if (s === "out-of-stock") return ["Reported gone", "leave"];
  if (s === "paused") return ["Paused", "think"];
  if (s === "stock-unconfirmed") return ["Shelf not confirmed", "think"];
  return ["Check first", "think"];
}
function shelfLine(b: Bounty) {
  if (b.shelf.state === "seen")
    return `Seen on the shelf ${ago(b.shelf.at)}${b.shelf.unitsSeen !== null ? `, about ${b.shelf.unitsSeen} there` : ""}`;
  if (b.shelf.state === "none") return `Reported gone ${ago(b.shelf.at)}`;
  return "No shelf report yet";
}

export default function TipsScreen({ go }: { go: (v: "deals" | "planner") => void }) {
  const [data, setData] = useState<MembersResponse | null>(null);
  const [tips, setTips] = useState<Bounty[] | null>(null);
  const [error, setError] = useState("");
  const [me, setMe] = useState<number | null>(readActing);
  const [tab, setTab] = useState<"go" | "all">("all");
  const [open, setOpen] = useState<number | null>(null);
  const [join, setJoin] = useState(false);
  const [profile, setProfile] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(() => {
    api<MembersResponse>("members")
      .then(setData)
      .catch((e: Error) => setError(e.message));
    api<BountiesResponse>("bounties" + (me !== null ? "?viewer=" + me : ""))
      .then((d) => {
        setTips(d.bounties);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
    setRefresh((r) => r + 1);
  }, [me]);
  useEffect(load, [load]);

  const member = me !== null ? (data?.members.find((m) => m.id === me) ?? null) : null;
  const list = tips ?? [];
  const live = list.filter((b) => b.status === "open");
  const ready = live.filter((b) => b.trip.go);
  const placesLeft = live.filter((b) => !b.sample).reduce((a, b) => a + b.remaining, 0);
  const current = open !== null ? (list.find((b) => b.id === open) ?? null) : null;

  const choose = (id: number) => {
    setMe(id);
    writeActing(id);
  };

  const feed = (rows: Bounty[]) =>
    rows.length === 0 ? (
      <Empty
        title={tab === "go" ? "Nothing to go for right now" : "No tips yet"}
        text="Tips appear here when a scout spots a find on a shelf near you. Each one has a set number of places, so it stays worth the trip."
        action={
          <Button variant="main" onClick={() => go("deals")}>
            Browse deals instead
          </Button>
        }
      />
    ) : (
      <div className="tps-cards">
        {rows.map((b) => {
          const [label, tone] = stateChip(b);
          const profit = b.opportunity?.unitProfit ?? null;
          const canClaim = b.trip.go && member !== null;
          return (
            <Card key={b.id} className="tps-card">
              <div className="tps-top">
                <button type="button" className="tps-title" onClick={() => setOpen(b.id)}>
                  {b.title}
                </button>
                <div className="k-chips">
                  <Chip tone={tone}>{label}</Chip>
                  {b.sample && tone !== "sample" && <Chip tone="sample">Sample</Chip>}
                  {b.sponsored && <Chip tone="plan">Sponsored{b.sponsor ? ` by ${b.sponsor}` : ""}</Chip>}
                </div>
                <span className="tps-where">
                  {[b.retailer, b.locality].filter(Boolean).join(" · ")}
                  {b.variant ? ` · ${b.variant}` : ""}
                </span>
              </div>
              <div className="tps-keep">
                <span>
                  <small>You keep</small>
                  <b className={profit !== null && profit > 0 ? "profit" : undefined}>
                    {profit !== null ? `${money(profit)} a unit` : b.sample ? "Sample" : "Not checked"}
                  </b>
                </span>
                <span>
                  <small>Ends</small>
                  <b>{ukDay.format(new Date(b.expiresAt))}</b>
                </span>
              </div>
              <Meter
                label="Places left"
                value={b.remaining}
                max={Math.max(1, b.cap)}
                shown={`${b.remaining} of ${b.cap}`}
                over={b.remaining === 0}
              />
              <p className="tps-shelf">{shelfLine(b)}</p>
              <div className="tps-acts">
                <Button variant={canClaim ? "main" : "line"} onClick={() => setOpen(b.id)}>
                  {canClaim ? "Claim a place" : "See the tip"}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    );

  return (
    <div className="tps">
      <PageHead
        title="Tips"
        tint="sky"
        lead="Shelf finds from other scouts. Each tip has a set number of places, so it stays worth the trip."
        aside={
          data && data.members.length > 0 ? (
            <label className="tps-me">
              <span>Claiming as</span>
              <Select value={me ?? ""} onChange={(e) => e.target.value && choose(Number(e.target.value))}>
                {me === null && <option value="">Choose your profile</option>}
                {data.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : data ? (
            <Button variant="main" onClick={() => setJoin(true)}>
              Create your scout profile
            </Button>
          ) : null
        }
      />
      {error && (
        <Notice tone="loss" title="Not loaded.">
          Tips could not be loaded ({error}).
        </Notice>
      )}
      {tips && (
        <>
          <Figures>
            <Figure label="Live tips" value={String(live.filter((b) => !b.sample).length)} note={`${live.filter((b) => b.sample).length} samples to practise on`} />
            <Figure label="Places left" value={String(placesLeft)} note="across live tips" />
            <Figure label="Go now" value={String(ready.length)} tone={ready.length ? "profit" : undefined} note="shelf checked, places open" />
          </Figures>
          {!member && data && data.members.length > 0 && (
            <Notice title="Choose your profile.">Pick who you are under Claiming as to claim a place or report a shelf.</Notice>
          )}
          <Tabs
            label="Tips"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "all", label: "All tips", count: live.length, content: feed(live) },
              { value: "go", label: "Go now", count: ready.length, content: feed(ready) },
            ]}
          />
        </>
      )}

      {member && data && (
        <MoreBelow
          title="Your scout profile"
          lead="Your level, points, alerts and the places you have claimed."
          open={profile}
          onToggle={() => setProfile((p) => !p)}
          showLabel="Show my profile"
        >
          <div className="legacy">
            <div className="bounties">
              <div className="grid2 member-area">
                <article>
                  <MemberSummary member={member} />
                  <details>
                    <summary>Edit profile, alerts and plan</summary>
                    <MemberForm key={member.id} tiers={data.tiers} paidTierIds={data.paidTierIds} member={member} onSaved={() => load()} />
                  </details>
                </article>
                <article>
                  <AlertInbox memberId={member.id} refresh={refresh} onChanged={load} />
                </article>
              </div>
              <TierTable tiers={data.tiers} points={data.reputation.accurateReport} />
            </div>
          </div>
        </MoreBelow>
      )}

      {data?.terms && (
        <Card>
          <Label>How tips work</Label>
          <ul className="tps-terms">
            <li>
              <b>{data.terms.buyAndResell}</b>
            </li>
            <li>{data.terms.reputation}</li>
            <li>{data.terms.paid}</li>
            <li>{data.terms.promotion}</li>
          </ul>
          <p className="tps-small">{data.terms.privacy}</p>
        </Card>
      )}

      {current && (
        <Window
          open
          wide
          onOpenChange={(o) => !o && setOpen(null)}
          tint="sky"
          title={current.title}
          description={[current.retailer, current.locality].filter(Boolean).join(" · ")}
        >
          {current.trip.headline && (
            <Notice tone={current.trip.go ? "profit" : "warn"} title={current.trip.label + "."}>
              {current.trip.headline}
            </Notice>
          )}
          {!member && <Notice title="Choose your profile.">Pick who you are under Claiming as to claim a place.</Notice>}
          <div className="legacy tps-full">
            <div className="bounties">
              <BountyCard
                key={current.id + ":" + (me ?? "public")}
                bounty={current}
                acting={me ?? "public"}
                onChanged={load}
                onAnswered={(r: EligibilityReply) => r && load()}
              />
            </div>
          </div>
        </Window>
      )}

      {data && (
        <Window open={join} onOpenChange={setJoin} tint="sky" title="Your scout profile" description="Your name and area decide which tips reach you first.">
          <div className="legacy tps-full">
            <div className="bounties">
              <MemberForm
                tiers={data.tiers}
                paidTierIds={data.paidTierIds}
                member={null}
                onSaved={(m) => {
                  setJoin(false);
                  choose(m.id);
                  load();
                }}
              />
            </div>
          </div>
        </Window>
      )}
    </div>
  );
}
