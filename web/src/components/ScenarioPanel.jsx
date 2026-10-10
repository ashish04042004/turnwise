import { useEffect, useRef, useState } from 'react';
import { post } from '../api.js';
import { useAction, useToast } from '../toast.jsx';

/** Demo controls: run the floor on autopilot and inject the disruptions from the case study. */
export default function ScenarioPanel() {
  const run = useAction();
  const toast = useToast();
  const [auto, setAuto] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!auto) return undefined;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await post('/sim/tick');
        if (r.actions.length) toast(r.actions.slice(0, 3).join(' · ') + (r.actions.length > 3 ? ` · +${r.actions.length - 3} more` : ''));
      } catch (err) {
        toast(err.message, 'error');
        setAuto(false);
      } finally {
        busy.current = false;
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [auto, toast]);

  const scenarios = [
    ['Walk-in rush', 'Three walk-ins arrive at once; they are placed concurrently.', () => post('/sim/walk-in-rush', { count: 3 }), (r) => `${r.created} walk-ins placed`],
    ['Ultrasound breaks down', 'The busiest ultrasound machine goes down for 30 minutes.', () => post('/sim/breakdown', { minutes: 30 }), (r) => r.skipped ?? `${r.resource} down; ${r.displaced.length} affected`],
    ['Scan overruns', 'A service in progress needs 15 more minutes.', () => post('/sim/overrun', { minutes: 15 }), (r) => r.skipped ?? `Overrun recorded; ${r.displaced.length} booking(s) displaced`],
    ['Patient cancels', 'A later booking cancels; the opening goes to the waitlist.', () => post('/sim/cancel'), (r) => r.skipped ?? `Cancelled; ${r.releasedSlots} slot(s) offered to the waitlist`],
  ];

  return (
    <>
      <div className="panel-head">
        <h2>Simulate a morning</h2>
        <span className="muted">Synthetic data only</span>
      </div>
      <label className="autopilot">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        <span>
          <strong>Floor autopilot</strong> — patients arrive (some late, some never), services start and finish with realistic, sometimes overrunning durations.
        </span>
      </label>
      <div className="scenarios">
        {scenarios.map(([title, desc, fn, msg]) => (
          <button key={title} className="scenario" onClick={() => run(fn, msg)}>
            <strong>{title}</strong>
            <span>{desc}</span>
          </button>
        ))}
      </div>
    </>
  );
}
