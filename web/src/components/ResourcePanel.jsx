import { useState } from 'react';
import { post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { time } from '../format.js';
import { useAction } from '../toast.jsx';

function DownForm({ resource, onDone }) {
  const run = useAction();
  const [minutes, setMinutes] = useState(30);
  const [reason, setReason] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    const r = await run(
      () => post(`/resources/${resource.id}/down`, { minutes: Number(minutes), reason: reason || null }),
      (r) => `${resource.name} marked unavailable; ${r.displaced.length} booking(s) affected`,
    );
    if (r) onDone();
  };
  return (
    <form className="down-form" onSubmit={submit}>
      <label>
        For
        <select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
          {[15, 30, 45, 60, 90, 120, 240].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
      </label>
      <input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      <button className="btn btn-sm btn-danger">Mark unavailable</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

export default function ResourcePanel({ resources }) {
  const run = useAction();
  const canReport = useAuth().can('resources');
  const [editing, setEditing] = useState(null);
  return (
    <>
      <div className="panel-head">
        <h2>Resources</h2>
        <span className="muted">Machines, rooms and staff</span>
      </div>
      <div className="resources">
        {resources.map((r) => (
          <div key={r.id} className={`resource res-card-${r.state}`}>
            <div className="resource-top">
              <span className={`res-dot res-${r.state}`} />
              <strong>{r.name}</strong>
              <span className="res-kind">{r.kind}</span>
            </div>
            <div className="resource-body">
              {r.state === 'down' && (
                <span className="bad">
                  Unavailable until {time(r.downUntil)}
                  {r.downReason ? ` · ${r.downReason}` : ''}
                </span>
              )}
              {r.state === 'busy' && (
                <span>
                  {r.current.patient} · {r.current.service} (since {time(r.current.since)})
                </span>
              )}
              {r.state === 'idle' && <span className="muted">Free now</span>}
            </div>
            {!canReport ? null : editing === r.id ? (
              <DownForm resource={r} onDone={() => setEditing(null)} />
            ) : r.state === 'down' ? (
              <button className="btn btn-sm" onClick={() => run(() => post(`/resources/${r.id}/up`), `${r.name} back in service`)}>
                Back in service
              </button>
            ) : (
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(r.id)}>
                Report unavailable…
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
