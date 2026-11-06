// A crew character as a picture on another screen: empty screens, the
// welcome card, sign-in and the plans. Each spot has its own picture
// (public/crew/<id>-<look>.jpg), always on white as in the campaign.
import { CREW } from "./CrewScreen";
import type { ReactNode } from "react";
import "./crew-art.css";

export type CrewId = "boss" | "scout" | "hauler" | "insider" | "fixer" | "negotiator";

// The pictures made for particular spots, by character.
export type CrewLook =
  | "boss-cheer"
  | "boss-thumbs"
  | "scout-walk"
  | "scout-lookout"
  | "scout-shrug"
  | "hauler-trolley"
  | "hauler-boxes"
  | "insider-shush"
  | "insider-idea"
  | "fixer-handover"
  | "fixer-parcels"
  | "negotiator-deal"
  | "negotiator-receipt"
  | "scout-map"
  | "scout-search"
  | "negotiator-count"
  | "fixer-tape";

export function CrewArt({ look, className }: { look: CrewLook; className?: string }) {
  const id = look.split("-")[0];
  const who = CREW.find((c) => c.id === id);
  return (
    <span className={"crew-art" + (className ? " " + className : "")}>
      <img src={`/crew/${look}.jpg`} alt={who ? who.name : ""} loading="lazy" decoding="async" />
    </span>
  );
}

// While a screen waits for its figures: a character at work beside the
// words, gently bobbing (still when reduced motion is asked for).
export function CrewLoading({ look, children }: { look: CrewLook; children: ReactNode }) {
  return (
    <div className="crew-loading" role="status" aria-live="polite">
      <CrewArt look={look} />
      <p>{children}</p>
    </div>
  );
}
