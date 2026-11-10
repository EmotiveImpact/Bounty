import type { Member } from './types';

export type Me = { required: boolean; user: Member | null; inviteOpen?: boolean };
type State = { checking: boolean; error: string; me: Me };
type Request = <T>(route: string, body?: unknown) => Promise<T>;

// No native dependencies: races are exercised with deferred synthetic replies.
export function createSession(request: Request) {
  let state: State = { checking: true, error: '', me: { required: true, user: null } };
  let version = 0;
  let changing = false;
  const listeners = new Set<() => void>();
  const publish = (next: State) => { state = next; listeners.forEach(fn => fn()); };
  const checked = (me: Me) => {
    if (!me || typeof me.required !== 'boolean' || (me.user !== null &&
      (!me.user || typeof me.user.id !== 'string' || !me.user.id)))
      throw Error('The account response could not be confirmed.');
    return me;
  };
  const blocked = () => publish({ checking: false,
    error: 'Your account could not be checked. Reconnect and try again to open your records.',
    me: { required: true, user: null } });

  async function refresh() {
    // A foreground check must not race a request changing the session cookie.
    if (changing) return;
    const mine = ++version;
    try {
      const me = checked(await request<Me>('auth/me'));
      if (mine === version) publish({ checking: false, error: '', me });
    } catch {
      if (mine === version) blocked();
    }
  }

  async function change(route: string, body: unknown, signingOut = false) {
    if (changing) throw Error('An account change is still in progress. Please wait.');
    changing = true;
    ++version; // Any earlier lookup is no longer authoritative.
    try {
      const result = await request<{ user: Member }>(route, body);
      const me = checked({ ...state.me, user: signingOut ? null : result.user });
      publish({ checking: false, error: '', me });
    } catch (error) {
      if (state.checking) blocked();
      throw error; // In particular, never pretend that a failed sign-out worked.
    } finally { changing = false; }
  }

  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh,
    signIn: (email: string, password: string) => change('auth/signin', { email: email.trim(), password }),
    signUp: (fields: { email: string; password: string; name: string; invite: string }) =>
      change('auth/signup', { ...fields, email: fields.email.trim(), name: fields.name.trim(), invite: fields.invite.trim() }),
    signOut: () => change('auth/signout', {}, true),
  };
}
