import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./look.css";
import Scan from "./Scan";
import Planner from "./Planner";
import { BasketSection } from "./Goals";
import Research from "./Research";
import { clearResearchDraft } from "./ResearchCalculator";
import Bounties from "./Bounties";
import Ledger from "./Ledger";
import Sources from "./Sources";
import ProtoApp, { type View } from "./proto/App";
import SignIn, { type Member } from "./SignIn";
import { SIGN_IN_EVENT } from "./api";

// The trip planner, with the several-items basket plan under it. Money has
// its own screen in the new shell (proto/Money.tsx).
function PlannerPage() {
  return (
    <>
      <Planner />
      <div className="planner goals">
        <BasketSection />
      </div>
    </>
  );
}

// The older screens, shown inside the new shell until each is ported.
const LEGACY: Partial<Record<View, React.ComponentType>> = {
  scan: Scan,
  planner: PlannerPage,
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

// On a hosted pilot with member accounts the site opens for everyone, with a
// Sign in button at the top. Saving a change while signed out opens the
// sign-in window too. On your own computer there are no accounts.
type Auth = { required: boolean; inviteOpen: boolean; member: Member | null };

function Root() {
  const [auth, setAuth] = React.useState<Auth>({ required: false, inviteOpen: false, member: null });
  const [signingIn, setSigningIn] = React.useState(false);
  React.useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.required)
          setAuth({ required: true, inviteOpen: Boolean(data.inviteOpen), member: data.user ?? null });
      })
      .catch(() => undefined);
    const open = () => setSigningIn(true);
    window.addEventListener(SIGN_IN_EVENT, open);
    return () => window.removeEventListener(SIGN_IN_EVENT, open);
  }, []);
  const close = React.useCallback(() => setSigningIn(false), []);
  return (
    <>
      <ProtoApp
        legacy={legacy}
        account={
          auth.required
            ? {
                email: auth.member?.email ?? null,
                signIn: () => setSigningIn(true),
                signOut: async () => {
                  await fetch("/api/auth/signout", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                  }).catch(() => undefined);
                  setAuth({ ...auth, member: null });
                },
              }
            : undefined
        }
      />
      {signingIn && (
        <SignIn
          inviteOpen={auth.inviteOpen}
          onClose={close}
          onSignedIn={(member) => (setAuth({ ...auth, required: true, member }), setSigningIn(false))}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
