import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, post, SIGNED_OUT } from './api.js';

const AuthContext = createContext(null);

/**
 * Who is signed in. `session` is undefined while loading and null when signed
 * out. Otherwise it has `user` (an email account, or null for a PIN session on
 * a shared terminal), `staff` (who they act as at a centre, or null while an
 * account is choosing one), `permissions`, `memberships` and join `requests`.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined);

  const refresh = useCallback(
    () =>
      api('/auth/me').then(
        (me) => setSession(me),
        () => setSession(null),
      ),
    [],
  );

  useEffect(() => {
    refresh();
    // A revoked staff session may still leave the account signed in, so ask rather than assume.
    const onSignedOut = () => refresh();
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, [refresh]);

  const signOut = useCallback(async ({ everywhere = false } = {}) => {
    await post('/auth/logout', { everywhere }).catch(() => undefined);
    setSession(null);
  }, []);

  /** Act at one of the account's centres, or (null) step back to the account itself. */
  const switchCentre = useCallback(
    async (centreId) => {
      await post('/account/switch', { centreId });
      await refresh();
      return true;
    },
    [refresh],
  );

  const can = useCallback((permission) => Boolean(session?.permissions.includes(permission)), [session]);

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, staff: session?.staff ?? null, can, refresh, signOut, switchCentre }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
