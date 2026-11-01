import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./look.css";
import Scan from "./Scan";
import Planner from "./Planner";
import Goals from "./Goals";
import Research from "./Research";
import { clearResearchDraft } from "./ResearchCalculator";
import Bounties from "./Bounties";
import Ledger from "./Ledger";
import Sources from "./Sources";
import ProtoApp, { type View } from "./proto/App";

// The older screens, shown inside the new shell until each is ported.
const LEGACY: Partial<Record<View, React.ComponentType>> = {
  scan: Scan,
  planner: Planner,
  money: Goals,
  research: Research,
  tips: Bounties,
  stock: Ledger,
  sources: Sources,
};

// Keeps a failure in one tab from blanking the whole page. onError lets a
// tab forget state it saved for the session (the Research draft), so a
// reload starts it afresh instead of failing the same way again.
class TabBoundary extends React.Component<
  { children: React.ReactNode; onError?: () => void },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch() {
    this.props.onError?.();
  }
  render() {
    if (this.state.error)
      return (
        <p role="alert">
          This tab hit an error and stopped ({this.state.error}). Reload the
          page, or choose another tab.
        </p>
      );
    return this.props.children;
  }
}

// Tabs that keep a session draft to forget when they fail.
const ON_ERROR: Partial<Record<string, () => void>> = {
  research: clearResearchDraft,
};

function legacy(view: View) {
  const Screen = LEGACY[view];
  if (!Screen) return null;
  return (
    <TabBoundary key={view} onError={ON_ERROR[view]}>
      <Screen />
    </TabBoundary>
  );
}

createRoot(document.getElementById("root")!).render(
  <ProtoApp legacy={legacy} />,
);
