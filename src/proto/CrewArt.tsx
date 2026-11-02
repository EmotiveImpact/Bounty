// A crew character as a picture on another screen: empty screens, the
// welcome card and the plans. Always on white, as in the campaign photos.
import { CREW } from "./CrewScreen";
import "./crew-art.css";

export type CrewId = "boss" | "scout" | "hauler" | "insider" | "fixer" | "negotiator";

export function CrewArt({
  id,
  pose = true,
  className,
}: {
  id: CrewId;
  /** The action pose (default) or the standing campaign photo. */
  pose?: boolean;
  className?: string;
}) {
  const who = CREW.find((c) => c.id === id);
  return (
    <span className={"crew-art" + (className ? " " + className : "")}>
      <img src={`/crew/${id}${pose ? "-pose" : ""}.jpg`} alt={who ? who.name : ""} loading="lazy" decoding="async" />
    </span>
  );
}
