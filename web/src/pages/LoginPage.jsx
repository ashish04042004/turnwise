import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { useAuth } from '../auth.jsx';

// The centre last signed in to on this device, so a shared front-desk screen opens on its own centre.
const CENTRE_KEY = 'turnwise:centre';
// Which way this device signs in: quick PIN (demo centres, shared terminals) or an email account.
const MODE_KEY = 'turnwise:sign-in';

function PinSignIn({ centres, terminal }) {
  const { refresh } = useAuth();
  const [centreId, setCentreId] = useState(() => terminal?.centre.id ?? localStorage.getItem(CENTRE_KEY) ?? '');
  const [directory, setDirectory] = useState(null);
  const [selected, setSelected] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // An enrolled terminal's own centre comes first; demo centres are open to everyone.
  const choices = terminal ? [terminal.centre, ...centres.filter((c) => c.id !== terminal.centre.id)] : centres;

  useEffect(() => {
    // An unknown or deleted centre falls back to the terminal's, else the default one.
    const known = centreId === terminal?.centre.id || centres.some((c) => c.id === centreId);
    let stale = false;
    api(`/auth/staff${known && centreId ? `?centreId=${centreId}` : ''}`).then(
      (r) => stale || setDirectory(r),
      (e) => stale || setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [centreId, centres, terminal]);

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
    <>
      {terminal && (
        <p className="terminal-badge small">
          Shared terminal <strong>{terminal.name}</strong> · {terminal.centre.name}
        </p>
      )}
      {choices.length > 1 && (
        <label className="login-centre">
          Centre
          <select value={directory?.centre.id ?? centreId} onChange={(e) => chooseCentre(e.target.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.city}
              </option>
            ))}
          </select>
        </label>
      )}
      <h1>Who’s signing in?</h1>
      {!staff && !error && <p className="muted">Loading staff…</p>}
      {staff?.length === 0 && <p className="muted">Nobody here has a PIN yet. A manager can set one on the Staff page.</p>}
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
    </>
  );
}

function EmailSignIn({ onSignUp }) {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/password-login', { email, password });
      await refresh();
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="login-form stacked">
      <h1>Sign in to your account</h1>
      <label>
        Email
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </label>
      <label>
        Password
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button className="btn btn-primary" disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <p className="bad small">{error}</p>}
      <p className="muted small">
        New here?{' '}
        <button type="button" className="link" onClick={onSignUp}>
          Create an account
        </button>{' '}
        to set up your own centre or join your team’s.
      </p>
    </form>
  );
}

function SignUp({ onSignIn }) {
  const { refresh } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/signup', { ...form, name: form.name.trim() });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="login-form stacked">
      <h1>Create your account</h1>
      <label>
        Your name
        <input autoComplete="name" value={form.name} onChange={set('name')} autoFocus />
      </label>
      <label>
        Email
        <input type="email" autoComplete="username" value={form.email} onChange={set('email')} />
      </label>
      <label>
        Password <span className="muted small">(at least 10 characters)</span>
        <input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
      </label>
      <button className="btn btn-primary" disabled={busy || form.name.trim().length < 2 || !form.email || form.password.length < 10}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
      {error && <p className="bad small">{error}</p>}
      <p className="muted small">Next you can create a centre (and manage it) or ask to join one with its join code.</p>
      <p className="notice small">Turnwise is a demonstration: use synthetic data only and never enter real patient records.</p>
      <p className="muted small">
        Already have an account?{' '}
        <button type="button" className="link" onClick={onSignIn}>
          Sign in
        </button>
      </p>
    </form>
  );
}

export default function LoginPage() {
  const [lookup, setLookup] = useState(null);
  const [mode, setMode] = useState(() => localStorage.getItem(MODE_KEY) ?? 'pin');

  useEffect(() => {
    api('/auth/centres').then(setLookup, () => setLookup({ centres: [], terminal: null }));
  }, []);

  const terminal = lookup?.terminal ?? null;
  const pinAvailable = Boolean(terminal || lookup?.centres.length);
  const shown = !lookup ? null : mode === 'pin' && !pinAvailable ? 'email' : mode;
  const choose = (next) => {
    if (next !== 'signup') localStorage.setItem(MODE_KEY, next);
    setMode(next);
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
        {pinAvailable && (
          <div className="tabs login-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={shown === 'pin'} className={shown === 'pin' ? 'active' : ''} onClick={() => choose('pin')}>
              {terminal ? 'Staff PIN' : 'Demo centres'}
            </button>
            <button type="button" role="tab" aria-selected={shown !== 'pin'} className={shown !== 'pin' ? 'active' : ''} onClick={() => choose('email')}>
              Email account
            </button>
          </div>
        )}
        {!lookup && <p className="muted">Loading…</p>}
        {shown === 'pin' && <PinSignIn centres={lookup.centres} terminal={terminal} />}
        {shown === 'email' && <EmailSignIn onSignUp={() => choose('signup')} />}
        {shown === 'signup' && <SignUp onSignIn={() => choose('email')} />}
      </div>
    </div>
  );
}
