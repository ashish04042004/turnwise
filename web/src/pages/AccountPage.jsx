import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useAction } from '../toast.jsx';

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';

function CreateCentre({ onCreated }) {
  const run = useAction();
  const [form, setForm] = useState({ name: '', city: '', timezone: browserZone(), opensAt: '08:00', closesAt: '20:00', starter: 'sample' });
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const valid = form.name.trim().length >= 2 && form.city.trim() && form.opensAt < form.closesAt;

  const submit = async (e) => {
    e.preventDefault();
    const created = await run(() => post('/account/centres', { ...form, name: form.name.trim(), city: form.city.trim() }), `${form.name.trim()} is ready`);
    if (created) onCreated();
  };

  return (
    <form className="account-form" onSubmit={submit}>
      <label>
        Centre name
        <input value={form.name} onChange={set('name')} placeholder="e.g. Lakeside Diagnostics" />
      </label>
      <label>
        City
        <input value={form.city} onChange={set('city')} />
      </label>
      <label>
        Time zone
        <input value={form.timezone} onChange={set('timezone')} />
      </label>
      <label>
        Opens
        <input type="time" value={form.opensAt} onChange={set('opensAt')} />
      </label>
      <label>
        Closes
        <input type="time" value={form.closesAt} onChange={set('closesAt')} />
      </label>
      <fieldset className="starter">
        <legend>Start with</legend>
        <label>
          <input type="radio" name="starter" value="sample" checked={form.starter === 'sample'} onChange={set('starter')} /> The sample catalogue (imaging, lab and
          consults you can edit)
        </label>
        <label>
          <input type="radio" name="starter" value="blank" checked={form.starter === 'blank'} onChange={set('starter')} /> Nothing: I’ll add my own services and
          resources
        </label>
      </fieldset>
      <button className="btn btn-primary" disabled={!valid}>
        Create centre
      </button>
      <p className="muted small">You become its manager, with every permission. Invite colleagues with the join code on the Staff page.</p>
    </form>
  );
}

function JoinCentre({ onAsked }) {
  const run = useAction();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    const asked = await run(() => post('/account/join', { code, message: message.trim() || undefined }), (r) => `Asked to join ${r.centreName}; a manager will review it`);
    if (asked) {
      setCode('');
      setMessage('');
      onAsked();
    }
  };
  return (
    <form className="account-form" onSubmit={submit}>
      <label>
        Join code
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="8 letters and digits" maxLength={12} />
      </label>
      <label className="wide">
        Note for the manager <span className="muted small">(optional)</span>
        <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. New radiographer, starting Monday" maxLength={300} />
      </label>
      <button className="btn" disabled={code.replace(/[^A-Z0-9]/g, '').length !== 8}>
        Ask to join
      </button>
    </form>
  );
}

function ChangePassword() {
  const run = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (await run(() => api('/account/password', { method: 'PUT', body: { current, next } }), 'Password changed; other devices are signed out')) {
      setCurrent('');
      setNext('');
    }
  };
  return (
    <form className="account-form" onSubmit={submit}>
      <label>
        Current password
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label>
        New password
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 10 characters" />
      </label>
      <button className="btn" disabled={!current || next.length < 10}>
        Change password
      </button>
    </form>
  );
}

/** The account itself: its centres, requests to join others, and creating a new one. */
export default function AccountPage() {
  const { session, user, staff, refresh, signOut, switchCentre } = useAuth();
  const navigate = useNavigate();
  const run = useAction();
  const [adding, setAdding] = useState(null);

  if (!user) {
    return (
      <div className="empty">
        <h2>Signed in with a PIN</h2>
        <p className="muted">This is a shared terminal session. Sign out and use your email to manage your account.</p>
      </div>
    );
  }

  const open = async (centreId) => {
    if (await run(() => switchCentre(centreId))) navigate('/');
  };
  const pending = session.requests.filter((r) => r.status === 'pending');
  const decided = session.requests.filter((r) => r.status !== 'pending');

  return (
    <div className={staff ? 'account-page' : 'account-page standalone'}>
      <header className="account-head">
        <div>
          <h1>{user.name}</h1>
          <span className="muted">{user.email}</span>
        </div>
        <div className="account-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => signOut()}>
            Sign out
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => window.confirm('Sign out on every device, including shared terminals where you used your PIN?') && signOut({ everywhere: true })}
          >
            Sign out everywhere
          </button>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Your centres</h2>
        </div>
        {session.memberships.length === 0 && <p className="muted">You don’t work at any centre yet. Create one, or ask to join your team’s with its join code.</p>}
        <ul className="memberships">
          {session.memberships.map((m) => (
            <li key={m.centreId}>
              <span>
                <strong>{m.centreName}</strong> <span className="muted">· {m.city}</span>
                <span className="role-chip">{m.roleLabel}</span>
              </span>
              {staff?.centre_id === m.centreId ? (
                <span className="muted small">Signed in here</span>
              ) : (
                <button type="button" className="btn btn-sm btn-primary" onClick={() => open(m.centreId)}>
                  Open
                </button>
              )}
            </li>
          ))}
        </ul>
        {(pending.length > 0 || decided.length > 0) && (
          <>
            <h3>Requests to join</h3>
            <ul className="memberships">
              {[...pending, ...decided].map((r) => (
                <li key={r.id}>
                  <span>
                    <strong>{r.centreName}</strong> <span className="muted">· {r.city}</span>
                    <span className={`status status-${r.status === 'approved' ? 'completed' : r.status === 'pending' ? 'booked' : 'cancelled'}`}>{r.status}</span>
                  </span>
                  {r.status === 'pending' && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={async () => (await run(() => api(`/account/requests/${r.id}`, { method: 'DELETE' }), 'Request withdrawn')) && refresh()}>
                      Withdraw
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="account-add">
          <button type="button" className={`btn btn-sm ${adding === 'create' ? 'btn-primary' : ''}`} onClick={() => setAdding(adding === 'create' ? null : 'create')}>
            Create a centre
          </button>
          <button type="button" className={`btn btn-sm ${adding === 'join' ? 'btn-primary' : ''}`} onClick={() => setAdding(adding === 'join' ? null : 'join')}>
            Join with a code
          </button>
        </div>
        {adding === 'create' && (
          <CreateCentre
            onCreated={async () => {
              await refresh();
              navigate('/');
            }}
          />
        )}
        {adding === 'join' && (
          <JoinCentre
            onAsked={() => {
              setAdding(null);
              refresh();
            }}
          />
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Password</h2>
        </div>
        <ChangePassword />
      </section>
      <p className="notice small">Turnwise is a demonstration: use synthetic data only and never enter real patient records.</p>
    </div>
  );
}
