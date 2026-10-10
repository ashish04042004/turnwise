import { useAuth } from '../auth.jsx';
import { useStartStep } from '../useStartStep.js';

/**
 * Who to call now, in the order patients were due (booked time, or arrival
 * for walk-ins). Only lists starts that are possible right now; any later
 * booking that would have to move is called out.
 */
export default function NextUp({ items }) {
  const { can } = useAuth();
  const start = useStartStep();
  if (items.length === 0) return null;
  return (
    <section className="panel next-up">
      <div className="panel-head">
        <h2>Next up</h2>
        <span className="muted">Can start now, longest-due first</span>
      </div>
      <ol className="next-up-list">
        {items.map((s) => (
          <li key={s.stepId}>
            <div>
              <strong>{s.patient}</strong> <span className="chip">{s.service}</span>
              <div className="muted">
                {s.resources.join(' + ')}
                {s.swapped && ' (swap)'} · {s.kind === 'walk_in' ? 'walk-in' : 'appointment'}
                {s.waitingMin > 0 && `, due ${s.waitingMin} min ago`}
              </div>
              {s.bumps > 0 && <div className="next-up-bump">Moves {s.bumps} later booking{s.bumps > 1 ? 's' : ''}</div>}
            </div>
            {can('floor') && (
              <button className="btn btn-sm btn-primary" onClick={() => start(s.stepId, s.service)}>
                Start
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
