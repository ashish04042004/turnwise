import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, post } from '../api.js';
import { setTimezone, STEP_LABEL, time, VISIT_LABEL } from '../format.js';
import { useAction } from '../toast.jsx';

/** The patient's own page: no other patients' details, just progress and a realistic wait range. */
export default function PatientPage() {
  const { token } = useParams();
  const run = useAction();
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api(`/public/visits/${token}`).then(
      (v) => {
        setTimezone(v.centre.timezone);
        setView(v);
      },
      (e) => setError(e.message),
    );
  }, [token]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  if (error) return <div className="patient"><div className="patient-card">{error}</div></div>;
  if (!view) return <div className="patient"><div className="patient-card">Loading…</div></div>;

  const next = view.steps.find((s) => s.status === 'scheduled' || s.status === 'in_service');
  return (
    <div className="patient">
      <div className="patient-card">
        <div className="patient-brand">
          <img src="/favicon.svg" alt="" width="24" height="24" /> {view.centre.name}, {view.centre.city}
        </div>
        <h1>Hello {view.firstName}</h1>
        <div className={`status status-${view.status}`}>{VISIT_LABEL[view.status]}</div>

        {view.offer && (
          <div className="offer">
            <h2>A slot opened up for you</h2>
            <p>
              We can see you at <strong>{time(view.scheduledAt)}</strong>. This offer is held until {time(view.offer.expiresAt)}.
            </p>
            <div className="row">
              <button className="btn btn-primary" onClick={() => run(() => post(`/public/offers/${token}/accept`), 'Booked — see you soon').then(load)}>
                Accept
              </button>
              <button className="btn btn-ghost" onClick={() => run(() => post(`/public/offers/${token}/decline`), 'No problem — we’ve released it').then(load)}>
                Decline
              </button>
            </div>
          </div>
        )}

        {view.status === 'arrived' && view.waitRange && (
          <div className="big-wait">
            <div className="muted">Estimated wait for your next test</div>
            <div className="big">
              {view.waitRange.low}–{view.waitRange.high} min
            </div>
            <div className="muted small">Based on the live queue; updates automatically.</div>
          </div>
        )}
        {view.status === 'in_progress' && next && <div className="big-wait"><div className="big">{next.service}</div><div className="muted">in progress</div></div>}
        {view.status === 'booked' && view.scheduledAt && (
          <div className="big-wait">
            <div className="muted">Your appointment</div>
            <div className="big">{time(view.scheduledAt)}</div>
            <div className="muted small">Please arrive 10 minutes early.</div>
          </div>
        )}

        <ol className="patient-steps">
          {view.steps.map((s, i) => (
            <li key={i} className={`ps ps-${s.status}`}>
              <span className="ps-name">{s.service}</span>
              <span className="ps-status">
                {s.status === 'completed' ? `Done at ${time(s.actualEnd)}` : s.status === 'scheduled' ? `around ${time(s.projectedStart ?? s.plannedStart)}` : STEP_LABEL[s.status]}
              </span>
            </li>
          ))}
        </ol>
        {view.steps.some((s) => s.status === 'displaced') && (
          <p className="notice">One of your tests needs a new time because of an equipment or scheduling issue. Our staff will confirm it shortly.</p>
        )}
        <p className="muted small">Times are estimates and may change. Staff decide clinical priorities.</p>
      </div>
    </div>
  );
}
