import React from "react";
import type { Lens } from "./api";

// The plain answer the server gives each deal or scan, and the Simple or Pro
// switch. Shared by Deals and Scan so both say the same thing the same way.

export type Verdict = "buy" | "think" | "leave" | "unknown";
export const VERDICT_LABEL: Record<Verdict, string> = {
  buy: "Buy",
  think: "Think",
  leave: "Leave",
  unknown: "Not sure",
};

/** A small coloured label for a card or a row. Sample deals say so beside it. */
export function VerdictBadge({ verdict, sample }: { verdict: Verdict; sample?: boolean }) {
  return (
    <span className={"verdict-badge v-" + verdict}>
      {VERDICT_LABEL[verdict]}
      {sample && <span className="verdict-sample">{"\u00a0· sample"}</span>}
    </span>
  );
}

export function LensSwitch({ lens, onChange }: { lens: Lens; onChange: (l: Lens) => void }) {
  return (
    <div className="lens-switch" role="group" aria-label="How much detail">
      <button type="button" aria-pressed={lens === "simple"} onClick={() => onChange("simple")}>
        Simple
      </button>
      <button type="button" aria-pressed={lens === "pro"} onClick={() => onChange("pro")}>
        Pro
      </button>
    </div>
  );
}
