import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { setTimezone } from './format.js';

const LiveContext = createContext(null);

/**
 * One shared live connection: fetches the board, then listens to the server's
 * event stream and re-fetches (debounced) whenever something changes. The
 * browser's EventSource resends Last-Event-ID on reconnect, so missed events
 * are replayed; a slow poll keeps time-based estimates fresh between events.
 */
export function LiveProvider({ children }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const b = await api('/board');
      setTimezone(b.centre.timezone);
      setBoard(b);
      setError(null);
      return b;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 250);
  }, [refresh]);

  useEffect(() => {
    let es;
    let cancelled = false;
    refresh().then((b) => {
      if (cancelled) return;
      es = new EventSource(`/api/stream?lastEventId=${b?.lastEventId ?? 0}`);
      es.onopen = () => {
        setConnected(true);
        scheduleRefresh();
      };
      es.onerror = () => setConnected(false);
      es.onmessage = (e) => {
        setLastEvent(JSON.parse(e.data));
        scheduleRefresh();
      };
      es.addEventListener('reset', scheduleRefresh);
    });
    const poll = setInterval(refresh, 20_000);
    return () => {
      cancelled = true;
      es?.close();
      clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, [refresh, scheduleRefresh]);

  return <LiveContext.Provider value={{ board, error, connected, lastEvent, refresh }}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);
