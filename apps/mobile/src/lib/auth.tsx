import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState } from "react-native";
import { createSession } from "./session";
import { api } from "./api";
import type { Member } from "./types";

// Who is signed in, using the same member accounts as the website. Anyone
// can look around; saving anything needs a member.

type Auth = {
  /** Still asking the server who is signed in. */
  checking: boolean;
  error: string;
  sessionKey: string;
  user: Member | null;
  /** A member is signed in, or the server has no accounts (a local test server). */
  signedIn: boolean;
  /** Sign-up is open when the server has an invite code set. */
  inviteOpen: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (fields: { email: string; password: string; name: string; invite: string }) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => createSession(api));
  const { checking, error, me } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  useEffect(() => {
    void session.refresh();
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void session.refresh();
    });
    return () => subscription.remove();
  }, [session]);

  const value = useMemo<Auth>(() => ({
    checking, error,
    user: me.user,
    signedIn: !error && (!!me.user || me.required === false),
    sessionKey: me.user ? "member:" + me.user.id : me.required === false ? "local" : "guest",
    inviteOpen: me.inviteOpen === true,
    refresh: session.refresh,
    signIn: session.signIn,
    signUp: session.signUp,
    signOut: session.signOut,
  }), [checking, error, me, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw Error("useAuth needs AuthProvider");
  return auth;
}
