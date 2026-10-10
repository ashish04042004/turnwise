import { useEffect, useState } from 'react';
import { api } from '../api.js';

const ROWS = [
  ['Waiting (excludes required gaps between linked tests)'],
  ['Median wait, everyone', 'waitP50', ' min'],
  ['90th percentile wait, everyone', 'waitP90', ' min'],
  ['Median wait, appointments', 'appointmentWaitP50', ' min'],
  ['90th percentile wait, appointments', 'appointmentWaitP90', ' min'],
  ['Median wait, walk-ins', 'walkInWaitP50', ' min'],
  ['90th percentile wait, walk-ins', 'walkInWaitP90', ' min'],
  ['Median wait for first test', 'firstWaitP50', ' min'],
  ['Visit'],
  ['Median time in centre', 'inCentreP50', ' min'],
  ['90th percentile time in centre', 'inCentreP90', ' min'],
  ['Patients waiting over 30 min', 'waitOver30', '%'],
  ['Overtime after closing', 'overtimeMin', ' min'],
];

function Delta({ baseline, turnwise }) {
  if (baseline == null || turnwise == null) return <td className="delta">—</td>;
  const diff = Math.round((turnwise - baseline) * 10) / 10;
  if (Math.abs(diff) < 0.5) return <td className="delta">≈ same</td>;
  return <td className={`delta ${diff < 0 ? 'better' : 'worse'}`}>{diff > 0 ? `+${diff}` : diff}</td>;
}

/** Counterfactual: the same demand and service durations run through a token-queue system. */
export default function BaselinePanel() {
  const [data, setData] = useState(undefined);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/analytics/baseline').then(setData, (e) => setError(e.message));
  }, []);

  return (
    <section className="panel wide">
      <div className="compare-head">
        <h2>Turnwise vs department queues</h2>
        {data && (
          <span className="muted small">
            {data.visits} visits · {data.replications} service-duration draws · Turnwise had the lower median wait in {data.turnwiseWins} of {data.replications}
          </span>
        )}
      </div>
      {error && <p className="bad">{error}</p>}
      {data === undefined && !error && <p className="muted">Replaying today’s demand…</p>}
      {data === null && <p className="muted">No visits yet today to compare.</p>}
      {data && (
        <table className="mini compare">
          <thead>
            <tr>
              <th />
              <th>Department queues</th>
              <th>Turnwise</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([label, key, unit]) =>
              key ? (
                <tr key={key}>
                  <td>{label}</td>
                  <td>{data.metrics[key].baseline ?? '—'}{data.metrics[key].baseline != null && unit}</td>
                  <td>{data.metrics[key].turnwise ?? '—'}{data.metrics[key].turnwise != null && unit}</td>
                  <Delta {...data.metrics[key]} />
                </tr>
              ) : (
                <tr key={label} className="group">
                  <td colSpan={4}>{label}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      <p className="muted small">
        Replays today’s patients (same arrival times, same tests, same simulated service durations) through two policies. Department queues: each patient takes
        tests in a fixed order and waits first-come-first-served at each one, as with paper tokens. Turnwise: appointments are reserved ahead, walk-ins are planned
        on arrival, and staff follow “Next up”: among patients who are present and whose booked resource (or an identical one) is free, call whoever was due
        longest ago, by appointment time for bookings and arrival time for walk-ins.
        It is a model, not a trial; lower is better throughout.
      </p>
    </section>
  );
}
