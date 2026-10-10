import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { ROLE_LABEL, useAuth } from '../auth.jsx';

const DEMO_PINS = { manager: '1234', reception: '1111', technician: '2222' };

export default function LoginPage() {
  const { refresh } = useAuth();
  const [staff, setStaff] = useState(null);
  const [demo, setDemo] = useState(false);
  const [selected, setSelected] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/staff').then(
      (r) => {
        setStaff(r.staff);
        setDemo(r.demo);
      },
      (e) => setError(e.message),
    );
  }, []);

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
        <h1>Who’s signing in?</h1>
        {!staff && !error && <p className="muted">Loading staff…</p>}
        {staff?.length === 0 && (
          <p className="muted">
            No staff accounts yet. Run <code>npm run seed</code> to create the demo centre.
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
                <span className="muted small">{ROLE_LABEL[s.role]}</span>
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
        {demo && (
          <p className="muted small login-hint">
            Demo centre: manager {DEMO_PINS.manager} · front desk {DEMO_PINS.reception} · technician {DEMO_PINS.technician}
          </p>
        )}
      </div>
    </div>
  );
}
