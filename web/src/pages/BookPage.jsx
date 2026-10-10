import { useEffect, useState } from 'react';
import { post } from '../api.js';
import { time } from '../format.js';
import { useLive } from '../live.jsx';
import { useAction } from '../toast.jsx';

const MODES = {
  walk_in: 'Walk-in now',
  appointment: 'Book appointment',
  waitlist: 'Add to waitlist',
};

/** datetime-local value for "now + minutes" in the browser's zone. */
function localInput(offsetMin = 0) {
  const d = new Date(Date.now() + offsetMin * 60_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function ServicePicker({ services, selected, onChange }) {
  const groups = Object.groupBy ? Object.groupBy(services, (s) => s.category) : services.reduce((g, s) => ({ ...g, [s.category]: [...(g[s.category] ?? []), s] }), {});
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="service-picker">
      {Object.entries(groups).map(([cat, list]) => (
        <fieldset key={cat}>
          <legend>{cat}</legend>
          {list.map((s) => (
            <label key={s.id} className={`svc ${selected.includes(s.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
              <span className={`chip cat-${s.category}`}>{s.code}</span>
              <span className="svc-name">{s.name}</span>
              <span className="muted">{s.duration_min} min</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function Countdown({ until, onExpire }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000)));
  useEffect(() => {
    const id = setInterval(() => {
      const s = Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) {
        clearInterval(id);
        onExpire();
      }
    }, 500);
    return () => clearInterval(id);
  }, [until, onExpire]);
  return <span className={left < 30 ? 'bad' : ''}>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>;
}

function PlanList({ steps }) {
  return (
    <ul className="plan">
      {steps.map((s) => (
        <li key={s.stepId}>
          <strong>{time(s.start)}</strong> <span className="chip">{s.serviceCode}</span> {s.serviceName} <span className="muted">· {s.resources.join(' + ')}</span>
        </li>
      ))}
    </ul>
  );
}

export default function BookPage() {
  const { board } = useLive();
  const run = useAction();
  const [mode, setMode] = useState('walk_in');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [priority, setPriority] = useState(0);
  const [serviceIds, setServiceIds] = useState([]);
  const [from, setFrom] = useState(localInput(30));
  const [latest, setLatest] = useState(localInput(240));
  const [options, setOptions] = useState(null);
  const [hold, setHold] = useState(null);
  const [result, setResult] = useState(null);

  const patient = { name: name.trim(), phone: phone.trim() || null };
  const valid = patient.name.length >= 2 && serviceIds.length > 0;

  const reset = () => {
    setOptions(null);
    setHold(null);
    setResult(null);
  };

  const submitWalkIn = async () => {
    const r = await run(() => post('/walk-ins', { patient, serviceIds, priority: Number(priority) }), (r) => (r.unplaced.length ? 'Walk-in registered — some services have no slot today' : 'Walk-in placed'));
    if (r) setResult({ title: `${patient.name} is in the queue`, ...r });
  };

  const search = async () => {
    setHold(null);
    const r = await run(() => post('/slots/search', { serviceIds, from: new Date(from).toISOString() }));
    if (r) setOptions(r);
  };

  const placeHold = async (start) => {
    const r = await run(() => post('/bookings/hold', { patient, serviceIds, start, priority: Number(priority) }), 'Slot held — confirm before the timer runs out');
    if (r) setHold(r);
    else search();
  };

  const confirm = async () => {
    const r = await run(() => post(`/bookings/${hold.visitId}/confirm`), 'Booking confirmed; patient notified');
    if (r) {
      setResult({ title: `${patient.name} is booked`, steps: hold.steps, publicToken: hold.publicToken, unplaced: [] });
      setHold(null);
      setOptions(null);
    }
  };

  const joinWaitlist = async () => {
    const r = await run(
      () => post('/waitlist', { patient, serviceIds, earliest: new Date(from).toISOString(), latest: new Date(latest).toISOString() }),
      `${patient.name} added to the waitlist; they’ll be offered the first suitable cancellation`,
    );
    if (r) setResult({ title: `${patient.name} is on the waitlist`, steps: [], unplaced: [] });
  };

  return (
    <div className="book">
      <section className="panel book-form">
        <div className="panel-head">
          <h2>New patient visit</h2>
        </div>
        <div className="seg seg-lg">
          {Object.entries(MODES).map(([k, label]) => (
            <button
              key={k}
              className={mode === k ? 'active' : ''}
              onClick={() => {
                setMode(k);
                reset();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="form-row">
          <label>
            Patient name <span className="muted">(synthetic for demos)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rohan Verma" />
          </label>
          <label>
            Phone
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 9…" />
          </label>
          {mode !== 'waitlist' && (
            <label title="Configured by the centre for operational urgency; not a clinical judgement">
              Priority
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value={0}>Standard</option>
                <option value={3}>Elevated</option>
                <option value={7}>Urgent (staff override)</option>
              </select>
            </label>
          )}
        </div>
        <ServicePicker services={board.services} selected={serviceIds} onChange={(ids) => (setServiceIds(ids), reset())} />

        {mode === 'walk_in' && (
          <button className="btn btn-primary" disabled={!valid} onClick={submitWalkIn}>
            Place in queue
          </button>
        )}
        {mode === 'appointment' && (
          <div className="form-row">
            <label>
              Earliest time
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <button className="btn btn-primary" disabled={!valid} onClick={search}>
              Find slots
            </button>
          </div>
        )}
        {mode === 'waitlist' && (
          <div className="form-row">
            <label>
              Available from
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              Until
              <input type="datetime-local" value={latest} onChange={(e) => setLatest(e.target.value)} />
            </label>
            <button className="btn btn-primary" disabled={!valid} onClick={joinWaitlist}>
              Join waitlist
            </button>
          </div>
        )}
      </section>

      <aside className="panel book-side">
        {hold && (
          <div className="hold">
            <h3>Slot on hold</h3>
            <p>
              Every resource below is reserved for this patient. The hold releases automatically in{' '}
              <strong>
                <Countdown until={hold.holdExpiresAt} onExpire={() => setHold(null)} />
              </strong>
              .
            </p>
            <PlanList steps={hold.steps} />
            <button className="btn btn-primary" onClick={confirm}>
              Confirm booking
            </button>
          </div>
        )}
        {!hold && options && (
          <div>
            <h3>Feasible starts</h3>
            {options.options.length === 0 && <p className="bad">{options.exhaustedReason ?? 'No feasible slot today.'}</p>}
            {options.options.map((o) => (
              <div key={o.start} className="slot">
                <div>
                  <strong>{time(o.start)}</strong> <span className="muted">done by {time(o.end)}</span>
                  <PlanList steps={o.steps} />
                </div>
                <button className="btn btn-sm btn-primary" onClick={() => placeHold(o.start)}>
                  Hold
                </button>
              </div>
            ))}
            {options.exhaustedReason && options.options.length > 0 && <p className="muted">No more options today: {options.exhaustedReason}</p>}
          </div>
        )}
        {result && (
          <div className="result">
            <h3>{result.title}</h3>
            {result.steps.length > 0 && <PlanList steps={result.steps} />}
            {result.unplaced?.map((u) => (
              <p key={u.serviceCode} className="bad">
                {u.serviceCode}: {u.reason}
              </p>
            ))}
            {result.publicToken && (
              <a className="btn btn-sm" href={`/p/${result.publicToken}`} target="_blank" rel="noreferrer">
                Open patient status page ↗
              </a>
            )}
          </div>
        )}
        {!hold && !options && !result && (
          <div className="muted explainer">
            <h3>How placement works</h3>
            <p>Turnwise checks every resource a service needs — the machine, the person operating it and the patient’s own other tests — and only offers times when all of them are free together.</p>
            <p>Configured rules (for example, post-prandial sugar at least 120 minutes after fasting sugar) are respected automatically.</p>
            <p>Appointments are held briefly while you confirm, so two receptionists can never book the same slot.</p>
          </div>
        )}
        {board.waitlist.length > 0 && (
          <div className="waitlist">
            <h3>Waitlist</h3>
            <ul>
              {board.waitlist.map((w) => (
                <li key={w.id}>
                  {w.patient} <span className="muted">· {w.services.join(', ')}</span>
                  <span className={`badge ${w.status === 'offered' ? 'badge-rec' : ''}`}>{w.status === 'offered' ? `offered, until ${time(w.offer_expires_at)}` : 'waiting'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
