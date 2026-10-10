import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, post, SIGNED_OUT } from './api.js';

const AuthContext = createContext(null);

export const ROLE_LABEL = { manager: 'Manager', reception: 'Front desk', technician: 'Technician' };

/** The signed-in staff member and what their role allows. `session` is undefined while loading, null when signed out. */
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
    const onSignedOut = () => setSession(null);
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, [refresh]);

  const signOut = useCallback(async () => {
    await post('/auth/logout').catch(() => undefined);
    setSession(null);
  }, []);

  const can = useCallback((permission) => Boolean(session?.permissions.includes(permission)), [session]);

  return <AuthContext.Provider value={{ session, staff: session?.staff ?? null, can, refresh, signOut }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
