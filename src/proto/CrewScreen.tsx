// The Bounty crew: six characters from the campaign photos (public/crew),
// the Crew band on the Deals home and the Crew page (#Crew). Roles and
// tips are written guidance, not figures. The scout ranking and the tips
// come from the API; with none yet, the page says so rather than showing
// made-up scouts.
import { useEffect, useState } from "react";
import { api } from "../api";
import { currentPlan, usePlans } from "../plans";
import { Button, Card, Empty, Label, PageHead, Row, Rows, type Tint } from "../ui/kit";
import "./crew.css";

type Go = (v: "plans" | "tips" | "scan" | "stock" | "money" | "planner" | "deals") => void;

export type CrewMember = {
  id: string;
  name: string;
  role: string;
  tip: string;
  uses: { label: string; view: Parameters<Go>[0] };
  tint: Tint;
};

export const CREW: CrewMember[] = [
  {
    id: "boss",
    name: "The Boss",
    role: "Runs it like a business. Watches what is kept, not what is sold.",
    tip: "Count it when the money reaches you, not when it sells.",
    uses: { label: "Money", view: "money" },
    tint: "periwinkle",
  },
  {
    id: "scout",
    name: "The Scout",
    role: "First to the shelf. Scans everything and shares the good ones.",
    tip: "Scan the barcode, not the photo: size and pack change the price.",
    uses: { label: "Scan", view: "scan" },
    tint: "lime",
  },
  {
    id: "hauler",
    name: "The Hauler",
    role: "Plans the route and knows exactly what fits in the bags.",
    tip: "Set your carry limit before you go, so a good find does not turn into a taxi fare.",
    uses: { label: "My trip", view: "planner" },
    tint: "pistachio",
  },
  {
    id: "insider",
    name: "The Insider",
    role: "Knows the loyalty prices, the codes and when the shelves get marked down.",
    tip: "A loyalty price only counts if you have the card in your pocket.",
    uses: { label: "Tips", view: "tips" },
    tint: "sky",
  },
  {
    id: "fixer",
    name: "The Fixer",
    role: "Packs, posts and keeps every receipt.",
    tip: "Put packaging in your costs. Mailers and tape are not free.",
    uses: { label: "Stock", view: "stock" },
    tint: "peach",
  },
  {
    id: "negotiator",
    name: "The Negotiator",
    role: "Knows her walk-away price before she picks it up.",
    tip: "Decide your walk-away price before you reach the till.",
    uses: { label: "Deals", view: "deals" },
    tint: "candy",
  },
];

const photo = (id: string) => `/crew/${id}.jpg`;

/** One character a day, the same for everyone on that London date. */
export function crewOfTheDay(date = new Date()): CrewMember {
  const london = date.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const day = Math.floor(Date.parse(london + "T00:00:00Z") / 86400000);
  return CREW[((day % CREW.length) + CREW.length) % CREW.length];
}

/** The yellow band on the Deals home. */
export function CrewBand({ go }: { go: (v: "crew") => void }) {
  const today = crewOfTheDay();
  return (
    <section className="cr-band" aria-label="The Bounty crew">
      <div className="cr-band-text">
        <small>The Bounty crew</small>
        <h2 className="k-display">Every kind of flipper. One crew.</h2>
        <p>Students, side hustlers and full-timers, all hunting the same shelves. Share a find, earn points, climb the levels.</p>
        <div className="cr-today">
          <img src={photo(today.id)} alt="" loading="lazy" />
          <div>
            <b>{today.name}’s tip for today</b>
            <span>{today.tip}</span>
          </div>
        </div>
        <Button variant="main" onClick={() => go("crew")}>
          Meet the crew
        </Button>
      </div>
      <div className="cr-band-row" aria-hidden="true">
        {CREW.map((c) => (
          <figure key={c.id} style={{ ["--k-tint" as string]: `var(--k-${c.tint})` }}>
            <img src={photo(c.id)} alt="" loading="lazy" />
            <figcaption>{c.name.replace("The ", "")}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

type Member = { id: number; name: string | null; locality: string | null; earned?: { points: number } | null };
type Tier = { id: string; name: string; earnPoints: number };
type MembersResponse = {
  members: Member[];
  tiers: Tier[];
  reputation: { accurateReport: number; rewardedReportsPerBountyPerDay: number };
};
type Tip = {
  id: number;
  title: string;
  retailer: string | null;
  locality: string;
  remaining: number;
  cap: number;
  sample?: boolean;
  status: string;
};

const pointsOf = (m: Member) => m.earned?.points ?? 0;

export default function CrewScreen({ go }: { go: Go }) {
  const [members, setMembers] = useState<MembersResponse | null>(null);
  const [tips, setTips] = useState<Tip[] | null>(null);
  const [error, setError] = useState("");
  const { info } = usePlans();
  const mine = currentPlan(info);

  useEffect(() => {
    api<MembersResponse>("members")
      .then(setMembers)
      .catch((e: Error) => setError(e.message));
    api<{ bounties: Tip[] }>("bounties")
      .then((d) => setTips(d.bounties))
      .catch(() => setTips([]));
  }, []);

  const ranked = (members?.members ?? [])
    .filter((m) => pointsOf(m) > 0)
    .sort((a, b) => pointsOf(b) - pointsOf(a))
    .slice(0, 5);
  const levels = (members?.tiers ?? []).filter((t) => t.earnPoints > 0).sort((a, b) => a.earnPoints - b.earnPoints);
  const live = (tips ?? []).filter((t) => t.status === "open").slice(0, 4);
  const levelFor = (points: number) => [...levels].reverse().find((t) => points >= t.earnPoints)?.name ?? "New";

  return (
    <div className="cr">
      <PageHead
        title="The crew"
        tint="lemon"
        lead="Every kind of flipper, from first-timers to full-timers. Find the one you are most like, share good finds and climb the levels."
        aside={
          <Button variant="main" onClick={() => go("plans")}>
            {mine ? `You are in, on ${mine.name}` : "Join for £1"}
          </Button>
        }
      />

      <section className="cr-grid" aria-label="The six crew roles">
        {CREW.map((c) => (
          <article key={c.id} className="cr-card" style={{ ["--k-tint" as string]: `var(--k-${c.tint})` }}>
            <div className="cr-photo">
              <img src={photo(c.id)} alt={`${c.name}, one of the Bounty crew`} loading="lazy" />
            </div>
            <div className="cr-body">
              <h2 className="k-display">{c.name}</h2>
              <p>{c.role}</p>
              <p className="cr-tip">
                <b>Tip:</b> {c.tip}
              </p>
              <Button variant="text" size="sm" onClick={() => go(c.uses.view)}>
                Open {c.uses.label}
              </Button>
            </div>
          </article>
        ))}
      </section>

      <div className="k-split">
        <div className="k-col">
          <Card>
            <Label>Top scouts</Label>
            {error ? (
              <p className="cr-small">Scouts did not load: {error}</p>
            ) : ranked.length ? (
              <ol className="cr-rank">
                {ranked.map((m, i) => (
                  <li key={m.id}>
                    <span className="cr-pos k-display">{i + 1}</span>
                    <span className="cr-who">
                      <b>{m.name || "Scout " + m.id}</b>
                      <small>{m.locality || "Area not set"}</small>
                    </span>
                    <span className="cr-pts">
                      <b>{pointsOf(m)}</b>
                      <small>{levelFor(pointsOf(m))}</small>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty
                title="No scouts ranked yet"
                text="The ranking fills in as scouts send accurate shelf reports. Be the first on it."
                action={
                  <Button variant="line" size="sm" onClick={() => go("tips")}>
                    Go to Tips
                  </Button>
                }
              />
            )}
          </Card>

          <Card>
            <Label aside={<Button variant="text" size="sm" onClick={() => go("tips")}>See all tips</Button>}>
              Latest tips
            </Label>
            {live.length ? (
              <Rows>
                {live.map((t) => (
                  <Row
                    key={t.id}
                    title={t.title + (t.sample ? " (sample)" : "")}
                    sub={[t.retailer, t.locality].filter(Boolean).join(" · ")}
                    value={`${t.remaining} of ${t.cap}`}
                    valueNote="places left"
                    onClick={() => go("tips")}
                  />
                ))}
              </Rows>
            ) : (
              <p className="cr-small">No live tips right now.</p>
            )}
          </Card>
        </div>

        <div className="k-col">
          <Card>
            <Label>Climb the levels</Label>
            <p className="cr-small">
              Every accurate shelf report earns {members?.reputation.accurateReport ?? 10} points, even when the shelf is
              empty. Points are earned only, never bought.
            </p>
            <ol className="cr-levels">
              {levels.map((t) => (
                <li key={t.id}>
                  <span className={"cr-gem " + t.id} aria-hidden="true" />
                  <b>{t.name}</b>
                  <small>{t.earnPoints} points</small>
                </li>
              ))}
            </ol>
          </Card>

          <Card className="cr-join">
            <Label>Join the crew</Label>
            <p>
              {mine
                ? `You are on ${mine.name}. Move up any time for earlier tips.`
                : "Every plan starts at £1 for the first 7 days. Pick the one that fits how often you go out hunting."}
            </p>
            <Button variant="main" onClick={() => go("plans")}>
              {mine ? "See plans" : "Join for £1"}
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
