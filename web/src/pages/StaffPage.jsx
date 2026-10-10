import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useConfig } from '../config.jsx';
import { useLive } from '../live.jsx';
import { useAction } from '../toast.jsx';

const validPin = (pin) => /^\d{4,8}$/.test(pin);
const patch = (id, body) => api(`/staff/${id}`, { method: 'PATCH', body });

function RoleOptions() {
  const { config } = useConfig();
  return (config?.roles ?? []).map((r) => (
    <option key={r.code} value={r.code}>
      {r.label}
    </option>
  ));
}

function AddStaff({ onAdded }) {
  const run = useAction();
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [pin, setPin] = useState('');
  const valid = name.trim().length >= 2 && role && validPin(pin);

  const submit = async (e) => {
    e.preventDefault();
    const added = await run(() => post('/staff', { name: name.trim(), role, pin }), `${name.trim()} can now sign in`);
    if (added) {
      setName('');
      setPin('');
      onAdded();
    }
  };

  return (
    <form className="form-row" onSubmit={submit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kavya Rao" />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="" disabled>
            Choose…
          </option>
          <RoleOptions />
        </select>
      </label>
      <label>
        Starting PIN
        <input type="password" inputMode="numeric" autoComplete="new-password" placeholder="4–8 digits" value={pin} onChange={(e) => setPin(e.target.value)} />
      </label>
      <button className="btn btn-primary" disabled={!valid}>
        Add
      </button>
    </form>
  );
}

function StaffRow({ person, isSelf, onChanged }) {
  const run = useAction();
  const { roleLabel } = useConfig();
  const [pin, setPin] = useState(null);

  const update = async (body, message) => {
    if (await run(() => patch(person.id, body), message)) onChanged();
  };

  return (
    <tr className={person.active ? '' : 'inactive'}>
      <td>
        <strong>{person.name}</strong>
        {isSelf && <span className="muted"> (you)</span>}
        <div className="muted small">{person.email ?? 'PIN only'}</div>
      </td>
      <td>
        <select
          value={person.role}
          disabled={isSelf || !person.active}
          onChange={(e) => update({ role: e.target.value }, `${person.name} is now ${roleLabel(e.target.value)}; signed out everywhere`)}
        >
          <RoleOptions />
        </select>
      </td>
      <td>{person.active ? <span className="status status-in_progress">Active</span> : <span className="status status-cancelled">Deactivated</span>}</td>
      <td>
        <div className="staff-actions">
        {pin === null ? (
          <button className="btn btn-sm" disabled={!person.active} onClick={() => setPin('')}>
            {person.hasPin ? 'Reset PIN' : 'Set PIN'}
          </button>
        ) : (
          <form
            className="pin-reset"
            onSubmit={async (e) => {
              e.preventDefault();
              await update({ pin }, isSelf ? 'Your PIN is changed; other devices are signed out' : `${person.name}'s PIN is reset; they are signed out everywhere`);
              setPin(null);
            }}
          >
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              placeholder="New PIN"
              aria-label={`New PIN for ${person.name}`}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
            />
            <button className="btn btn-sm btn-primary" disabled={!validPin(pin)}>
              Save
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPin(null)}>
              Cancel
            </button>
          </form>
        )}
        {!isSelf &&
          (person.active ? (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => window.confirm(`Deactivate ${person.name}? They will be signed out and can't sign in until reactivated.`) && update({ active: false }, `${person.name} deactivated`)}
            >
              Deactivate
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => update({ active: true }, `${person.name} reactivated`)}>
              Reactivate
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
}

function JoinRequests({ onDecided }) {
  const run = useAction();
  const { lastEvent } = useLive();
  const { config } = useConfig();
  const [requests, setRequests] = useState([]);
  const [roles, setRoles] = useState({});
  const load = useCallback(() => api('/join-requests').then((r) => setRequests(r.requests), () => undefined), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (lastEvent?.type?.startsWith('join.')) load();
  }, [lastEvent, load]);

  if (requests.length === 0) return null;
  const decide = async (r, approve) => {
    const role = roles[r.id];
    const done = approve
      ? await run(() => post(`/join-requests/${r.id}/approve`, { role }), `${r.name} joined`)
      : await run(() => post(`/join-requests/${r.id}/reject`), `${r.name}'s request declined`);
    if (done) {
      load();
      onDecided();
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Asking to join</h2>
        <span className="muted">They used this centre’s join code.</span>
      </div>
      <ul className="join-requests">
        {requests.map((r) => (
          <li key={r.id}>
            <span>
              <strong>{r.name}</strong> <span className="muted">{r.email}</span>
              {r.message && <span className="small"> — “{r.message}”</span>}
            </span>
            <select aria-label={`Role for ${r.name}`} value={roles[r.id] ?? ''} onChange={(e) => setRoles({ ...roles, [r.id]: e.target.value })}>
              <option value="" disabled>
                Role…
              </option>
              {(config?.roles ?? []).map((role) => (
                <option key={role.code} value={role.code}>
                  {role.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-sm btn-primary" disabled={!roles[r.id]} onClick={() => decide(r, true)}>
              Approve
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => decide(r, false)}>
              Decline
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function JoinCode() {
  const run = useAction();
  const [state, setState] = useState(null);
  useEffect(() => {
    api('/centre/join-code').then(setState, () => undefined);
  }, []);
  if (!state) return null;
  if (state.demo) {
    return <p className="muted small">This is a demo centre, rebuilt every day, so it doesn’t take join requests. Create your own centre from your account to invite colleagues.</p>;
  }
  const change = async (enabled) => {
    const next = await run(() => api('/centre/join-code', { method: enabled ? 'POST' : 'DELETE' }), enabled ? 'New join code issued; the old one stops working' : 'Join code turned off');
    if (next) setState(next);
  };
  return (
    <div className="join-code">
      {state.code ? (
        <>
          <span>
            Join code <code className="code-big">{state.code}</code>
          </span>
          <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(state.code)}>
            Copy
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => change(true)}>
            New code
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => change(false)}>
            Turn off
          </button>
          <span className="muted small">Colleagues create an account, enter this code, and you approve them here.</span>
        </>
      ) : (
        <>
          <span className="muted">Not taking join requests.</span>
          <button type="button" className="btn btn-sm" onClick={() => change(true)}>
            Issue a join code
          </button>
        </>
      )}
    </div>
  );
}

function Terminals() {
  const run = useAction();
  const [state, setState] = useState(null);
  const [name, setName] = useState('');
  const load = useCallback(() => api('/terminals').then(setState, () => undefined), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!state) return null;

  const enrol = async (e) => {
    e.preventDefault();
    if (await run(() => post('/terminals', { name: name.trim() }), `This device is now the shared terminal "${name.trim()}"`)) {
      setName('');
      load();
    }
  };
  const revoke = async (t) => {
    if (!window.confirm(`Stop PIN sign-in on "${t.name}"?`)) return;
    if (await run(() => api(`/terminals/${t.id}`, { method: 'DELETE' }), `${t.name} revoked`)) load();
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Shared terminals</h2>
        <span className="muted">Devices where colleagues switch with a PIN instead of their email. Everywhere else needs an account.</span>
      </div>
      {state.terminals.length > 0 && (
        <ul className="terminals">
          {state.terminals.map((t) => (
            <li key={t.id}>
              <span>
                <strong>{t.name}</strong>
                {t.id === state.thisDevice && <span className="role-chip">this device</span>}
                <span className="muted small"> enrolled by {t.createdBy}</span>
              </span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => revoke(t)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {!state.thisDevice && (
        <form className="form-row" onSubmit={enrol}>
          <label>
            Enrol this device as
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Front desk 1" />
          </label>
          <button className="btn" disabled={name.trim().length < 2}>
            Enrol
          </button>
        </form>
      )}
    </section>
  );
}

function StaffDirectory() {
  const { staff: me } = useAuth();
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(
    () =>
      api('/staff').then(
        (r) => setPeople(r.staff),
        (e) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="staff-page">
      <JoinRequests onDecided={load} />
      <section className="panel">
        <div className="panel-head">
          <h2>Invite colleagues</h2>
        </div>
        <JoinCode />
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Add a person</h2>
        </div>
        <AddStaff onAdded={load} />
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Staff</h2>
          <span className="muted">Changing someone’s role, PIN or status signs them out on every device.</span>
        </div>
        {error && <p className="bad">{error}</p>}
        {!people && !error && <p className="muted">Loading…</p>}
        {people && (
          <table className="mini staff-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <StaffRow key={p.id} person={p} isSelf={p.id === me.id} onChanged={load} />
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Terminals />
    </div>
  );
}

export default function StaffPage() {
  const { can } = useAuth();
  if (!can('staff')) {
    return (
      <div className="empty">
        <h2>Managers only</h2>
        <p className="muted">Ask a manager to add staff or reset a PIN.</p>
      </div>
    );
  }
  return <StaffDirectory />;
}
