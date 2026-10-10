import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { useAuth } from './auth.jsx';
import { useLive } from './live.jsx';

const ConfigContext = createContext(null);

// Colour slots for service categories, assigned in the centre's category order.
const CATEGORY_TONES = 6;

/**
 * The centre's configuration (roles, priority levels, categories, settings)
 * as stored in the database. Reloaded whenever a manager changes a setting.
 */
export function ConfigProvider({ children }) {
  const { lastEvent } = useLive();
  const { refresh: refreshSession } = useAuth();
  const [config, setConfig] = useState(null);

  const reload = useCallback(() => api('/config').then(setConfig, () => undefined), []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (lastEvent?.type === 'settings.changed' || lastEvent?.type === 'catalogue.changed') reload();
    // What each role may do changed: the menu and buttons follow without signing in again.
    if (lastEvent?.type === 'roles.changed') {
      reload();
      refreshSession();
    }
  }, [lastEvent, reload, refreshSession]);

  const value = useMemo(() => {
    const roles = new Map(config?.roles.map((r) => [r.code, r.label]));
    const priorities = new Map(config?.priorityLevels.map((p) => [p.level, p]));
    const categories = new Map(config?.categories.map((c, i) => [c.code, { ...c, tone: i % CATEGORY_TONES }]));
    return {
      config,
      reload,
      roleLabel: (code) => roles.get(code) ?? code,
      priorityLabel: (level) => priorities.get(level)?.label ?? `P${level}`,
      categoryName: (code) => categories.get(code)?.name ?? code,
      categoryClass: (code) => (categories.has(code) ? `cat-tone-${categories.get(code).tone}` : ''),
    };
  }, [config, reload]);

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export const useConfig = () => useContext(ConfigContext);
