import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./look.css";
import Planner from "./Planner";
import { BasketSection } from "./Goals";
import Research from "./Research";
import { clearResearchDraft } from "./ResearchCalculator";
import Ledger from "./Ledger";
import ProtoApp, { type View } from "./proto/App";
import SignIn, { type Member } from "./SignIn";
import { Button, Window } from "./ui/kit";
import { initialisePrivateStorage, announceSessionChange, SESSION_CHANGED } from "./private-storage";
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

// Stock's full records, without the month summary and tax note that the
// new Stock and Money screens already show.
function StockRecords() {
  return <Ledger />;
}

// The older screens, shown inside the new shell until each is ported.
const LEGACY: Partial<Record<View, React.ComponentType>> = {
  planner: PlannerPage,
  research: Research,
  stock: StockRecords,
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

function legacy(view: View, operator = false) {
  const Screen = LEGACY[view];
  if (!Screen) return null;
  return (
    <TabBoundary key={view} onError={ON_ERROR[view]}>
      {view === "research" ? <Research operator={operator} /> : <Screen />}
    </TabBoundary>
  );
}

// On a hosted pilot with member accounts the site opens for everyone, with a
// Sign in button at the top. Saving a change while signed out opens the
// sign-in window too. On your own computer there are no accounts.
// operator: may use Admin. Without accounts (your own computer, or the
// password-only demo) whoever is here is the operator.
type Auth = { required: boolean; inviteOpen: boolean; member: Member | null; operator: boolean };

function Root() {
  const [auth, setAuth] = React.useState<Auth>({ required: false, inviteOpen: false, member: null, operator: false });
  const [loaded, setLoaded] = React.useState(false);
  const sessionChecked = React.useRef(false);
  const [checking, setChecking] = React.useState(true);
  const [sessionError, setSessionError] = React.useState("");
  const [signOutError, setSignOutError] = React.useState("");
  const signingOut = React.useRef(false);
  const checkSequence = React.useRef(0);
  const [signingIn, setSigningIn] = React.useState<false | "in" | "up">(false);
  // Links in account emails: #reset=<token> and #verify=<token>.
  const [resetToken, setResetToken] = React.useState<string | null>(null);
  const [confirmed, setConfirmed] = React.useState<null | { ok: boolean; text: string }>(null);
  React.useEffect(() => {
    const m = /^#(reset|verify)=([A-Za-z0-9_-]{10,200})$/.exec(window.location.hash);
    if (!m) return;
    history.replaceState(null, "", window.location.pathname + window.location.search + "#Deals");
    if (m[1] === "reset") {
      setResetToken(m[2]);
      setSigningIn("in");
      return;
    }
    fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: m[2] }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (res.ok) window.dispatchEvent(new Event("bounty:auth-changed"));
        setConfirmed(
          res.ok
            ? { ok: true, text: "Thanks, your email " + (data?.email ?? "") + " is confirmed." }
            : { ok: false, text: data?.error || "That link did not work. Send a new one from Profile and settings." },
        );
      })
      .catch(() => setConfirmed({ ok: false, text: "We couldn’t reach Bounty. Try the link again in a moment." }));
  }, []);
  const refresh = React.useCallback(async () => {
    const sequence = ++checkSequence.current;
    if (!sessionChecked.current) setChecking(true);
    setSessionError("");
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (typeof data?.required !== "boolean" || (data.required && data.user && data.user.id == null)) throw Error("We couldn’t check your session. Retry before opening your records.");
      if (sequence !== checkSequence.current) return;
      if (!await initialisePrivateStorage(data.required, data.user?.id == null ? null : String(data.user.id))) {
        setLoaded(false);
        setChecking(true);
        window.location.reload();
        return;
      }
      if (sequence !== checkSequence.current) return;
      setAuth({ required: data.required, inviteOpen: Boolean(data.inviteOpen), member: data.user ?? null, operator: data.operator === true });
      sessionChecked.current = true;
      setLoaded(true);
      setChecking(false);
    } catch {
      if (sequence === checkSequence.current) {
        sessionChecked.current = false;
        setLoaded(false);
        setChecking(true);
        setSessionError("We couldn’t check your session. Retry before opening your records.");
      }
    }
  }, []);
  React.useEffect(() => {
    void refresh();
    const open = () => { setSigningIn("in"); void refresh(); };
    const changed = (event: StorageEvent) => {
      if (event.key === SESSION_CHANGED) {
        sessionChecked.current = false;
        setLoaded(false);
        setChecking(true);
        void refresh();
      }
    };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void refresh(); };
    window.addEventListener(SIGN_IN_EVENT, open);
    window.addEventListener("bounty:auth-changed", refresh);
    window.addEventListener("storage", changed);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", restored);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener(SIGN_IN_EVENT, open);
      window.removeEventListener("bounty:auth-changed", refresh);
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", restored);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const changedSession = () => {
    checkSequence.current++;
    setLoaded(false);
    setChecking(true);
    announceSessionChange();
    window.location.reload();
  };
  const close = React.useCallback(() => setSigningIn(false), []);
  return (
    <>
      {checking && (
        <div style={{ padding: 24 }} role={sessionError ? "alert" : "status"}>
          <p>{sessionError || "Checking your session…"}</p>
          {sessionError && <Button onClick={() => void refresh()}>Retry session check</Button>}
        </div>
      )}
      {loaded && <ProtoApp
        legacy={(view) => legacy(view, auth.operator)}
        operator={auth.operator}
        account={
          auth.required
            ? {
                email: auth.member?.email ?? null,
                signIn: () => setSigningIn("in"),
                signUp: () => setSigningIn("up"),
                signOut: async () => {
                  if (signingOut.current) return;
                  signingOut.current = true;
                  setSignOutError("");
                  try {
                    const res = await fetch("/api/auth/signout", {
                      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
                    });
                    if (!res.ok) throw Error("Sign-out was not confirmed");
                    changedSession();
                  } catch {
                    setSignOutError("Bounty could not confirm sign-out. Your session may still be active. Try signing out again before leaving this device.");
                  } finally { signingOut.current = false; }
                },
                signedOut: changedSession,
                refresh,
              }
            : undefined
        }
      />}
      {signOutError && <Window open onOpenChange={(open) => !open && setSignOutError("")} title="Sign-out not confirmed"
        footer={<Button onClick={() => setSignOutError("")}>OK</Button>}>
        <p role="alert">{signOutError}</p>
      </Window>}
      {confirmed && (
        <Window
          open
          onOpenChange={(o) => !o && setConfirmed(null)}
          title={confirmed.ok ? "Email confirmed" : "Link not working"}
          footer={
            <Button variant="main" onClick={() => setConfirmed(null)}>
              OK
            </Button>
          }
        >
          <p style={{ margin: 0 }}>{confirmed.text}</p>
        </Window>
      )}
      {signingIn && (
        <SignIn
          startMode={signingIn}
          resetToken={resetToken ?? undefined}
          inviteOpen={auth.inviteOpen}
          onClose={() => (close(), setResetToken(null))}
          onSignedIn={changedSession}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
