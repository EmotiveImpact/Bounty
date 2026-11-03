import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { Member } from "./types";

// Who is signed in, using the same member accounts as the website. Anyone
// can look around; saving anything needs a member.

type Me = { required: boolean; user: Member | null; inviteOpen?: boolean };

type Auth = {
  /** Still asking the server who is signed in. */
  checking: boolean;
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
  const [checking, setChecking] = useState(true);
  const [me, setMe] = useState<Me>({ required: true, user: null });

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("auth/me"));
    } catch {
      // Offline: stay as we were, and let screens show their own message.
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    api<Me>("auth/me")
      .then((m) => live && setMe(m))
      .catch(() => {})
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, []);

  const value = useMemo<Auth>(
    () => ({
      checking,
      user: me.user,
      signedIn: !!me.user || me.required === false,
      inviteOpen: me.inviteOpen === true,
      refresh,
      async signIn(email, password) {
        const r = await api<{ user: Member }>("auth/signin", { email: email.trim(), password });
        setMe((m) => ({ ...m, user: r.user }));
      },
      async signUp({ email, password, name, invite }) {
        const r = await api<{ user: Member }>("auth/signup", { email: email.trim(), password, name: name.trim(), invite: invite.trim() });
        setMe((m) => ({ ...m, user: r.user }));
      },
      async signOut() {
        await api("auth/signout", {});
        setMe((m) => ({ ...m, user: null }));
      },
    }),
    [checking, me, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw Error("useAuth needs AuthProvider");
  return auth;
}
