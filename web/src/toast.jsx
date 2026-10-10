import { createContext, useCallback, useContext, useState } from 'react';

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Runs an API action, toasting its outcome. Returns the result, or null on failure. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async (fn, success) => {
      try {
        const result = await fn();
        if (success) toast(typeof success === 'function' ? success(result) : success, 'success');
        return result;
      } catch (err) {
        toast(err.message, 'error');
        return null;
      }
    },
    [toast],
  );
}
