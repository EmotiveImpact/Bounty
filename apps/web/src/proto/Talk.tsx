// Talk: a comment thread under one deal (shared UK-wide) or one tip (tied to
// one branch). This is a SAMPLE to show the idea: the replies are made up,
// nothing is saved and nothing reaches other members. Quick replies such as
// "Still there" or "Gone" would later update the tip's status and earn points.
import React, { useState } from "react";
import { money } from "../api";
import "./talk.css";

type Tag = "ok" | "gone" | "price" | "sold" | "where";
type Reply = { who: string; level: string; ago: string; text: string; tag?: [Tag, string] };

const TAG_ICON: Record<Tag, string> = { ok: "✓", gone: "✕", price: "£", sold: "↗", where: "⌖" };

// Money from the API is in pence.
function gbp(pence: number | null | undefined) {
  return pence === null || pence === undefined || !Number.isFinite(pence) ? null : money(pence).replace(/\.00$/, "");
}

function dealReplies(shop: string, area: string | null, sells: number | null): Reply[] {
  const sold = gbp(sells);
  return [
    { who: "Priya K", level: "Gold scout", ago: "12 min ago", text: `Bought 3 at ${shop}${area ? " " + area : ""}. Plenty left on the shelf.`, tag: ["ok", "Still in stock"] },
    {
      who: "Dan M",
      level: "Silver scout",
      ago: "1 hr ago",
      text: sold ? `Sold mine on eBay for ${sold} in two days. Boxed ones go fastest.` : "Sold mine on eBay in two days. Boxed ones go fastest.",
      tag: ["sold", sold ? `Sold for ${sold}` : "Sold"],
    },
    { who: "Leanne R", level: "Scout", ago: "3 hrs ago", text: "Website says out of stock for delivery, but collect in store still works.", tag: ["where", "Collect only"] },
  ];
}

function tipReplies(shop: string, area: string | null): Reply[] {
  const at = shop + (area ? " " + area : "");
  return [
    { who: "Sam T", level: "Gold scout", ago: "20 min ago", text: `Still 4 left at ${at}. Back aisle, bottom shelf by the tills.`, tag: ["ok", "Still there"] },
    { who: "Aisha B", level: "Scout", ago: "2 hrs ago", text: "Rang up £3 cheaper at the till than the sticker. Check your receipt.", tag: ["price", "Cheaper at till"] },
    { who: "Chris P", level: "Silver scout", ago: "5 hrs ago", text: "Grabbed 2. Staff said more coming Thursday.", tag: ["where", "More due Thu"] },
  ];
}

const QUICK: Record<"deal" | "tip", [Tag, string][]> = {
  tip: [
    ["ok", "Still there"],
    ["gone", "Gone"],
    ["price", "Price changed"],
  ],
  deal: [
    ["ok", "Still in stock"],
    ["price", "Price went up"],
    ["sold", "I sold one"],
  ],
};

// Phone numbers and links are not allowed, so the thread stays about the find.
const BLOCKED = /(https?:\/\/|www\.|\.co\.uk|\.com\b|(?:\+?44|0)\s?7\d{3}\s?\d{3}\s?\d{3})/i;

export function Talk({
  kind,
  shop,
  area = null,
  sells = null,
  flat = false,
}: {
  kind: "deal" | "tip";
  shop: string;
  area?: string | null;
  sells?: number | null;
  /** Grey, borderless, to sit with the panels on the product page. */
  flat?: boolean;
}) {
  const [mine, setMine] = useState<Reply[]>([]);
  const [text, setText] = useState("");
  const [tag, setTag] = useState<[Tag, string] | null>(null);
  const [warn, setWarn] = useState("");
  const [reported, setReported] = useState<Record<string, boolean>>({});
  const seed = kind === "deal" ? dealReplies(shop, area, sells) : tipReplies(shop, area);
  const all = [...mine, ...seed];

  const post = () => {
    const t = text.trim();
    if (!t && !tag) return;
    if (BLOCKED.test(t)) {
      setWarn("Links and phone numbers are not allowed in threads.");
      return;
    }
    setMine([{ who: "You", level: "Scout", ago: "just now", text: t || tag![1], tag: tag ?? undefined }, ...mine]);
    setText("");
    setTag(null);
    setWarn("");
  };

  return (
    <section className={"talk" + (flat ? " flat" : "")} aria-label={kind === "deal" ? "Talk about this deal" : "Talk about this tip"}>
      <header className="talk-head">
        <h3>
          {kind === "deal" ? "Talk about this deal" : "Scouts on this tip"}
          <span className="talk-sample">Sample</span>
        </h3>
        <small>
          {kind === "deal"
            ? "One thread for everyone in the UK buying this deal."
            : `Only about ${shop}${area ? " " + area : ""}. A "Still there" or "Gone" updates the tip and earns points.`}
        </small>
      </header>

      <div className="talk-quick" role="group" aria-label="Quick reply">
        {QUICK[kind].map(([k, label]) => (
          <button
            key={label}
            type="button"
            className={"talk-chip " + k + (tag?.[1] === label ? " on" : "")}
            aria-pressed={tag?.[1] === label}
            onClick={() => setTag(tag?.[1] === label ? null : [k, label])}
          >
            <i aria-hidden="true">{TAG_ICON[k]}</i>
            {label}
          </button>
        ))}
      </div>

      <form
        className="talk-form"
        onSubmit={(e) => {
          e.preventDefault();
          post();
        }}
      >
        <input
          value={text}
          onChange={(e) => (setText(e.target.value), setWarn(""))}
          placeholder={kind === "deal" ? "Add an update, like a code or a sold price" : "Add an update, like how many are left"}
          aria-label="Your update"
          maxLength={280}
        />
        <button type="submit" className="talk-post" disabled={!text.trim() && !tag}>
          Post
        </button>
      </form>
      {warn && <p className="talk-warn">{warn}</p>}

      <ol className="talk-list">
        {all.map((r, i) => {
          const id = r.who + r.ago + r.text;
          return (
          <li key={id + i} className={reported[id] ? "hid" : ""}>
            <span className="talk-av" aria-hidden="true">
              {r.who[0]}
            </span>
            <div className="talk-body">
              <span className="talk-meta">
                <b>{r.who}</b>
                <span>{r.level}</span>
                <span>· {r.ago}</span>
              </span>
              {r.tag && (
                <span className={"talk-tag " + r.tag[0]}>
                  <i aria-hidden="true">{TAG_ICON[r.tag[0]]}</i>
                  {r.tag[1]}
                </span>
              )}
              {reported[id] ? <p className="talk-gone">Reported. Hidden while we check it.</p> : r.text !== r.tag?.[1] && <p>{r.text}</p>}
            </div>
            {r.who !== "You" && !reported[id] && (
              <button type="button" className="talk-report" onClick={() => setReported({ ...reported, [id]: true })}>
                Report
              </button>
            )}
          </li>
          );
        })}
      </ol>
      <p className="talk-note">
        Example only: these replies are made up and your post stays on this screen. No links or phone numbers, and
        anything can be reported.
      </p>
    </section>
  );
}
