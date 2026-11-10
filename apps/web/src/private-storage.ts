// Browser drafts belong to the signed-in member. Hosted sessions never adopt
// old unscoped drafts: their ownership is unknown. Keep those bytes intact for
// an explicit, reviewed migration. Local account-free use keeps its old keys.
type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
let identity: string | undefined;
let local: DraftStore | undefined;
let session: DraftStore | undefined;
const memory = (): DraftStore => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
};
function scoped(kind: 'localStorage' | 'sessionStorage', prefix: string): DraftStore {
  return {
    getItem: key => window[kind].getItem(prefix + key),
    setItem: (key, value) => window[kind].setItem(prefix + key, value),
    removeItem: key => window[kind].removeItem(prefix + key),
  };
}

/** Returns false on an identity change: reload before rendering any new user. */
export async function initialisePrivateStorage(required: boolean, memberId: string | null): Promise<boolean> {
  const next = required ? memberId ? 'member:' + memberId : 'guest' : 'local';
  if (identity !== undefined) return identity === next;
  let prefix = '';
  if (required && memberId) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(next));
    prefix = 'bounty:member:' + [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('') + ':';
  }
  if (identity !== undefined) return identity === next;
  identity = next;
  local = next === 'guest' ? memory() : scoped('localStorage', prefix);
  session = next === 'guest' ? memory() : scoped('sessionStorage', prefix);
  return true;
}
function active(value: DraftStore | undefined): DraftStore {
  if (!value) throw Error('Private storage is unavailable before the session check');
  return value;
}
export const privateLocal: DraftStore = {
  getItem: key => active(local).getItem(key),
  setItem: (key, value) => active(local).setItem(key, value),
  removeItem: key => active(local).removeItem(key),
};
export const privateSession: DraftStore = {
  getItem: key => active(session).getItem(key),
  setItem: (key, value) => active(session).setItem(key, value),
  removeItem: key => active(session).removeItem(key),
};
export const SESSION_CHANGED = 'bounty:session-changed';
export function announceSessionChange() {
  try { localStorage.setItem(SESSION_CHANGED, crypto.randomUUID()); } catch { /* focus rechecks too */ }
}
