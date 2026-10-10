import { useState } from 'react';
import { post } from '../api.js';
import { FLAG_LABEL, relative, STEP_LABEL, time, VISIT_LABEL } from '../format.js';
import { useAction, useToast } from '../toast.jsx';

const TABS = {
  active: { label: 'On the floor', match: (v) => ['arrived', 'in_progress'].includes(v.status) || v.flags.includes('needs_replan') },
  upcoming: { label: 'Upcoming', match: (v) => ['booked', 'held'].includes(v.status) && !v.flags.includes('needs_replan') },
  done: { label: 'Done', match: (v) => ['completed', 'cancelled', 'no_show'].includes(v.status) },
};

function StepRow({ step, visit }) {
  const run = useAction();
  const toast = useToast();
  const late = step.delayMin >= 3 && step.status === 'scheduled';
  const canAct = ['arrived', 'in_progress'].includes(visit.status);

  const start = async (force = false) => {
    try {
      const r = await post(`/steps/${step.id}/start`, { force });
      const where = r.swapped ? ` in ${r.swapped.to.join(' + ')} (${r.swapped.from.join(' + ')} was busy)` : '';
      toast(
        r.displaced.length
          ? `${step.serviceCode} started${where}; ${r.displaced.length} later booking(s) need a new time`
          : `${step.serviceCode} started${where}`,
        r.displaced.length ? 'info' : 'success',
      );
    } catch (err) {
      if (err.details?.canForce && window.confirm(`${err.message}.\n\nStart anyway? The other booking will be re-planned.`)) return start(true);
      toast(err.message, 'error');
    }
  };

  return (
    <li className={`step step-${step.status}`}>
      <div className="step-main">
        <span className={`chip cat-${step.category}`}>{step.serviceCode}</span>
        <span className="step-status">{STEP_LABEL[step.status]}</span>
        <span className="step-time">
          {step.status === 'completed' && `${time(step.actualStart)}–${time(step.actualEnd)}`}
          {step.status === 'in_service' && `since ${time(step.actualStart)} · ends ~${time(step.projectedEnd)}`}
          {step.status === 'scheduled' && (
            <>
              {late ? <s>{time(step.plannedStart)}</s> : time(step.plannedStart)}
              {late && <strong className="late"> → ~{time(step.projectedStart)} (+{step.delayMin}m)</strong>}
            </>
          )}
          {step.status === 'displaced' && `was ${time(step.plannedStart)}`}
        </span>
      </div>
      {step.resources.length > 0 && step.status !== 'displaced' && <div className="step-res">{step.resources.join(' · ')}</div>}
      <div className="step-actions">
        {step.status === 'scheduled' && canAct && step.id === visit.nextStepId && (
          <button className="btn btn-sm btn-primary" onClick={() => start()}>
            Start
          </button>
        )}
        {step.status === 'in_service' && (
          <>
            <button className="btn btn-sm btn-primary" onClick={() => run(() => post(`/steps/${step.id}/complete`), `${step.serviceCode} completed`)}>
              Complete
            </button>
            <button
              className="btn btn-sm"
              title="Report that this service needs more time"
              onClick={() =>
                run(
                  () => post(`/steps/${step.id}/extend`, { minutes: 10 }),
                  (r) => (r.displaced.length ? `Extended; ${r.displaced.length} booking(s) displaced` : 'Extended by 10 min'),
                )
              }
            >
              +10 min
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function VisitCard({ visit, now }) {
  const run = useAction();
  return (
    <article className={`visit visit-${visit.status}`}>
      <header className="visit-head">
        <div>
          <div className="visit-name">
            {visit.patient}
            {visit.priority > 0 && <span className="badge badge-priority">P{visit.priority}</span>}
          </div>
          <div className="visit-meta">
            <span className={`badge badge-${visit.kind}`}>{visit.kind === 'walk_in' ? 'Walk-in' : visit.source === 'waitlist' ? 'Waitlist' : 'Appointment'}</span>
            {visit.scheduledAt && <span>booked {time(visit.scheduledAt)}</span>}
            {visit.arrivedAt && <span>arrived {time(visit.arrivedAt)}</span>}
          </div>
        </div>
        <div className="visit-right">
          <span className={`status status-${visit.status}`}>{VISIT_LABEL[visit.status]}</span>
          {visit.waitRange && visit.status === 'arrived' && (
            <div className="wait" title="Estimated wait for the next service, calibrated by today's estimate accuracy">
              {visit.waitRange.low}–{visit.waitRange.high} min
            </div>
          )}
          {visit.status === 'booked' && visit.scheduledAt && <div className="wait muted">{relative(visit.scheduledAt, now)}</div>}
        </div>
      </header>
      {visit.flags.length > 0 && (
        <div className="flags">
          {visit.flags.map((f) => (
            <span key={f} className={`flag flag-${f}`}>
              {FLAG_LABEL[f]}
            </span>
          ))}
        </div>
      )}
      <ul className="steps">
        {visit.steps
          .filter((s) => s.status !== 'cancelled' || visit.status === 'cancelled')
          .map((s) => (
            <StepRow key={s.id} step={s} visit={visit} />
          ))}
      </ul>
      <footer className="visit-actions">
        {visit.status === 'booked' && (
          <button className="btn btn-sm btn-primary" onClick={() => run(() => post(`/visits/${visit.id}/check-in`), `${visit.patient} checked in`)}>
            Check in
          </button>
        )}
        {visit.status === 'booked' && visit.flags.includes('late_arrival') && (
          <button className="btn btn-sm" onClick={() => run(() => post(`/visits/${visit.id}/no-show`), (r) => `Marked no-show; ${r.releasedSlots} slot(s) released to the waitlist`)}>
            No-show
          </button>
        )}
        {['booked', 'arrived', 'held'].includes(visit.status) && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => window.confirm(`Cancel ${visit.patient}'s visit?`) && run(() => post(`/visits/${visit.id}/cancel`, { reason: 'Cancelled at reception' }), (r) => `Cancelled; ${r.releasedSlots} slot(s) released`)}
          >
            Cancel
          </button>
        )}
        <a className="btn btn-sm btn-ghost" href={`/p/${visit.publicToken}`} target="_blank" rel="noreferrer" title="What the patient sees">
          Patient view ↗
        </a>
      </footer>
    </article>
  );
}

export default function QueueList({ visits, now }) {
  const [tab, setTab] = useState('active');
  const [query, setQuery] = useState('');
  const shown = visits.filter((v) => TABS[tab].match(v) && v.patient.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <div className="panel-head">
        <h2>Live queue</h2>
        <input className="search" placeholder="Search patient…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="tabs">
        {Object.entries(TABS).map(([key, t]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {t.label} <span className="count">{visits.filter(t.match).length}</span>
          </button>
        ))}
      </div>
      <div className="queue">
        {shown.length === 0 && <div className="empty-sm">Nobody here.</div>}
        {(tab === 'done' ? [...shown].reverse() : shown).map((v) => (
          <VisitCard key={v.id} visit={v} now={now} />
        ))}
      </div>
    </>
  );
}
