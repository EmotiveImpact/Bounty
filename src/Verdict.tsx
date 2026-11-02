// The plain answer the server gives each deal or scan, worded the same way
// everywhere.

export type Verdict = "buy" | "think" | "leave" | "unknown";
export const VERDICT_LABEL: Record<Verdict, string> = {
  buy: "Buy",
  think: "Think",
  leave: "Leave",
  unknown: "Not sure",
};
