import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { useAuth } from '../auth.jsx';

// The centre last signed in to on this device, so a shared front-desk screen opens on its own centre.
const CENTRE_KEY = 'turnwise:centre';

export default function LoginPage() {
  const { refresh } = useAuth();
  const [centres, setCentres] = useState([]);
  const [centreId, setCentreId] = useState(() => localStorage.getItem(CENTRE_KEY) ?? '');
  const [directory, setDirectory] = useState(null);
  const [selected, setSelected] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/centres').then((r) => setCentres(r.centres), () => undefined);
  }, []);

  useEffect(() => {
    // An unknown or deleted centre falls back to the default one.
    const known = !centreId || centres.length === 0 || centres.some((c) => c.id === centreId);
    let stale = false;
    api(`/auth/staff${known && centreId ? `?centreId=${centreId}` : ''}`).then(
      (r) => stale || setDirectory(r),
      (e) => stale || setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [centreId, centres]);

  const staff = directory?.staff;
  const roleLabel = (code) => directory?.roles.find((r) => r.code === code)?.label ?? code;
  const chooseCentre = (id) => {
    localStorage.setItem(CENTRE_KEY, id);
    setCentreId(id);
    setSelected(null);
    setError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/login', { staffId: selected.id, pin });
      await refresh();
    } catch (err) {
      setError(err.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-brand">
          <img src="/favicon.svg" alt="" width="40" height="40" />
          <div>
            <div className="login-name">Turnwise</div>
            <div className="muted small">Smarter turns. Smoother operations.</div>
          </div>
        </div>
        {centres.length > 1 && (
          <label className="login-centre">
            Centre
            <select value={directory?.centre.id ?? centreId} onChange={(e) => chooseCentre(e.target.value)}>
              {centres.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.city}
                </option>
              ))}
            </select>
          </label>
        )}
        <h1>Who’s signing in?</h1>
        {!staff && !error && <p className="muted">Loading staff…</p>}
        {staff?.length === 0 && (
          <p className="muted">
            No staff accounts yet. Run <code>npm run seed</code> to create the demo centres.
          </p>
        )}
        <div className="login-staff">
          {staff?.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`login-person ${selected?.id === s.id ? 'selected' : ''}`}
              onClick={() => {
                setSelected(s);
                setPin('');
                setError(null);
              }}
            >
              <span className="login-avatar">{s.name[0]}</span>
              <span>
                <strong>{s.name}</strong>
                <span className="muted small">{roleLabel(s.role)}</span>
              </span>
            </button>
          ))}
        </div>
        {selected && (
          <form onSubmit={submit} className="login-form">
            <label>
              PIN for {selected.name}
              <input
                autoFocus
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                pattern="\d{4,8}"
                maxLength={8}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <button className="btn btn-primary" disabled={busy || pin.length < 4}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
        {error && <p className="bad small">{error}</p>}
        {directory?.hint && <p className="muted small login-hint">{directory.hint}</p>}
      </div>
    </div>
  );
}
