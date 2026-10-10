import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useLive } from '../live.jsx';
import { useAction } from '../toast.jsx';

const toCode = (label) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40);

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function RoleRow({ role, permissions, isMine, onSaved }) {
  const run = useAction();
  const [label, setLabel] = useState(role.label);
  const [granted, setGranted] = useState(role.permissions);

  const dirty = label.trim() !== role.label || !sameSet(granted, role.permissions);
  const toggle = (code) => setGranted(granted.includes(code) ? granted.filter((p) => p !== code) : [...granted, code]);

  const save = async () => {
    if (await run(() => api(`/roles/${role.code}`, { method: 'PATCH', body: { label: label.trim(), permissions: granted } }), `${label.trim()} saved`)) onSaved();
  };
  const remove = async () => {
    if (!window.confirm(`Delete the ${role.label} role?`)) return;
    if (await run(() => api(`/roles/${role.code}`, { method: 'DELETE' }), `${role.label} deleted`)) onSaved();
  };

  return (
    <tr className={dirty ? 'dirty' : ''}>
      <th scope="row">
        <input aria-label={`Name of the ${role.code} role`} value={label} onChange={(e) => setLabel(e.target.value)} />
        <span className="muted small">
          {role.code} · {role.activeStaff} active{isMine && ' · your role'}
        </span>
      </th>
      {permissions.map((p) => (
        <td key={p.code}>
          <input type="checkbox" aria-label={`${role.label}: ${p.code}`} checked={granted.includes(p.code)} onChange={() => toggle(p.code)} />
        </td>
      ))}
      <td className="role-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || !label.trim()} onClick={save}>
          Save
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={role.totalStaff > 0}
          title={role.totalStaff > 0 ? 'Give its staff another role first' : undefined}
          onClick={remove}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

function AddRole({ permissions, onAdded }) {
  const run = useAction();
  const [label, setLabel] = useState('');
  const [granted, setGranted] = useState([]);
  const code = toCode(label);

  const submit = async (e) => {
    e.preventDefault();
    if (await run(() => post('/roles', { code, label: label.trim(), permissions: granted }), `${label.trim()} added`)) {
      setLabel('');
      setGranted([]);
      onAdded();
    }
  };

  return (
    <form className="add-role" onSubmit={submit}>
      <label>
        New role
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Shift lead" />
      </label>
      <fieldset>
        <legend>Can</legend>
        {permissions.map((p) => (
          <label key={p.code} title={p.description}>
            <input type="checkbox" checked={granted.includes(p.code)} onChange={() => setGranted(granted.includes(p.code) ? granted.filter((x) => x !== p.code) : [...granted, p.code])} />{' '}
            {p.code}
          </label>
        ))}
      </fieldset>
      <button className="btn btn-primary" disabled={!code}>
        Add role
      </button>
    </form>
  );
}

function RolesEditor() {
  const { staff } = useAuth();
  const { lastEvent } = useLive();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(
    () =>
      api('/roles').then(
        (r) => setData(r),
        (e) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (lastEvent?.type === 'roles.changed' || lastEvent?.type?.startsWith('staff.') || lastEvent?.type === 'join.approved') load();
  }, [lastEvent, load]);

  if (error) return <p className="bad">{error}</p>;
  if (!data) return <div className="empty">Loading…</div>;

  return (
    <div className="roles-page">
      <section className="panel">
        <div className="panel-head">
          <h2>Roles at this centre</h2>
          <span className="muted">Changes apply at once, without anyone signing in again. Someone active must always be able to manage roles and staff.</span>
        </div>
        <div className="table-scroll">
          <table className="mini roles-matrix">
            <thead>
              <tr>
                <th>Role</th>
                {data.permissions.map((p) => (
                  <th key={p.code} title={p.description}>
                    {p.code}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {data.roles.map((r) => (
                // Keyed on the saved state, so a row starts over when anyone saves it.
                <RoleRow key={`${r.code}:${r.label}:${r.permissions.join()}`} role={r} permissions={data.permissions} isMine={r.code === staff.role} onSaved={load} />
              ))}
            </tbody>
          </table>
        </div>
        <dl className="permission-key small">
          {data.permissions.map((p) => (
            <div key={p.code}>
              <dt>{p.code}</dt>
              <dd className="muted">{p.description}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="panel">
        <AddRole permissions={data.permissions} onAdded={load} />
      </section>
    </div>
  );
}

export default function RolesPage() {
  const { can } = useAuth();
  if (!can('roles')) {
    return (
      <div className="empty">
        <h2>Not available</h2>
        <p className="muted">Ask someone who manages roles.</p>
      </div>
    );
  }
  return <RolesEditor />;
}
