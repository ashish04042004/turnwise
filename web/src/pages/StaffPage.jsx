import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useConfig } from '../config.jsx';
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
            Reset PIN
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
