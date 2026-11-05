// A crew character as a picture on another screen: empty screens, the
// welcome card, sign-in and the plans. Each spot has its own picture
// (public/crew/<id>-<look>.jpg), always on white as in the campaign.
import { CREW } from "./CrewScreen";
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
  | "negotiator-receipt";

export function CrewArt({ look, className }: { look: CrewLook; className?: string }) {
  const id = look.split("-")[0];
  const who = CREW.find((c) => c.id === id);
  return (
    <span className={"crew-art" + (className ? " " + className : "")}>
      <img src={`/crew/${look}.jpg`} alt={who ? who.name : ""} loading="lazy" decoding="async" />
    </span>
  );
}
