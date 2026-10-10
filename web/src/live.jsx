import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { setCentreFormat } from './format.js';

const LiveContext = createContext(null);

/**
 * One shared live connection: fetches the board, then listens to the server's
 * event stream and re-fetches (debounced) whenever something changes. The
 * browser's EventSource resends Last-Event-ID on reconnect, so missed events
 * are replayed; a slow poll keeps time-based estimates fresh between events.
 * Each refresh says which event it has seen, so the server never answers it
 * with a cached board from before that event.
 */
export function LiveProvider({ children }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const timer = useRef(null);
  const seen = useRef(0);

  const refresh = useCallback(
    () =>
      api(`/board?after=${seen.current}`).then(
        (b) => {
          setCentreFormat(b.centre);
          seen.current = Math.max(seen.current, b.lastEventId);
          setBoard(b);
          setError(null);
          return b;
        },
        (err) => {
          setError(err.message);
          return null;
        },
      ),
    [],
  );

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
        const evt = JSON.parse(e.data);
        seen.current = Math.max(seen.current, evt.id ?? 0);
        setLastEvent(evt);
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
