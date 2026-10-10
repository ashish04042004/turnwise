import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { time } from '../format.js';
import { useLive } from '../live.jsx';

const fmt = (v, unit = '') => (v == null ? '—' : `${v}${unit}`);

function Stat({ label, value, hint }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Bars({ data }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="bars">
      {data.map((d) => (
        <div key={d.bucket} className="bar-col">
          <div className="bar-count">{d.count || ''}</div>
          <div className="bar" style={{ height: `${(d.count / max) * 100}%` }} />
          <div className="bar-label">{d.bucket}</div>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const { lastEvent } = useLive();
  const [a, setA] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/analytics').then(setA, (e) => setError(e.message));
  }, [lastEvent?.id]);

  if (error) return <div className="empty bad">{error}</div>;
  if (!a) return <div className="empty">Crunching today’s numbers…</div>;

  return (
    <div className="analytics">
      <div className="analytics-head">
        <h1>Today’s operations</h1>
        <span className="muted">
          {time(a.window.from)}–{time(a.window.to)} · computed from recorded events and actual service times · synthetic data
        </span>
      </div>

      <div className="stat-grid">
        <Stat label="Visits" value={a.counts.visits} />
        <Stat label="Walk-ins" value={a.counts.walk_ins} />
        <Stat label="Completed" value={a.counts.completed} />
        <Stat label="Cancelled" value={a.counts.cancelled} />
        <Stat label="No-shows" value={a.counts.no_shows} />
        <Stat label="p50 wait" value={fmt(a.waits.all.p50, ' min')} hint="Median minutes from ready (arrival or booked time) to first service" />
        <Stat label="p90 wait" value={fmt(a.waits.all.p90, ' min')} />
        <Stat label="Estimate error p50" value={fmt(a.estimateAccuracy.p50, ' min')} hint={a.estimateAccuracy.note} />
      </div>

      <div className="analytics-grid">
        <section className="panel">
          <h2>Waiting time distribution</h2>
          <Bars data={a.waits.histogram} />
          <table className="mini">
            <thead>
              <tr>
                <th />
                <th>n</th>
                <th>p50</th>
                <th>p90</th>
                <th>max</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['All', a.waits.all],
                ['Appointments', a.waits.appointments],
                ['Walk-ins', a.waits.walkIns],
              ].map(([k, d]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{d.samples}</td>
                  <td>{fmt(d.p50)}</td>
                  <td>{fmt(d.p90)}</td>
                  <td>{fmt(d.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">{a.waits.note}</p>
        </section>

        <section className="panel">
          <h2>Resource utilisation</h2>
          <div className="util">
            {a.utilization.map((u) => (
              <div key={u.id} className="util-row" title={`${u.busyMin} busy of ${u.availableMin} available min; ${u.downMin} min down`}>
                <span className="util-name">{u.name}</span>
                <span className="util-track">
                  <span className="util-fill" style={{ width: `${Math.min(100, u.pct ?? 0)}%` }} />
                  {u.downMin > 0 && <span className="util-down">{u.downMin}m down</span>}
                </span>
                <span className="util-pct">{fmt(u.pct, '%')}</span>
              </div>
            ))}
          </div>
          <p className="muted small">Busy minutes ÷ available minutes since opening; downtime is excluded from availability.</p>
        </section>

        <section className="panel">
          <h2>Estimate accuracy</h2>
          <div className="stat-grid compact">
            <Stat label="Samples" value={a.estimateAccuracy.samples} />
            <Stat label="Mean |error|" value={fmt(a.estimateAccuracy.mean, ' min')} />
            <Stat label="p90 |error|" value={fmt(a.estimateAccuracy.p90, ' min')} />
            <Stat label="Bias" value={fmt(a.estimateAccuracy.biasMin, ' min')} hint="Positive means services started later than promised" />
          </div>
          <p className="muted small">{a.estimateAccuracy.note}</p>
        </section>

        <section className="panel">
          <h2>Disruption & recovery</h2>
          <div className="stat-grid compact">
            <Stat label="Outages" value={a.disruptions.downtimes} />
            <Stat label="Overrun extensions" value={a.disruptions.overrunExtensions} />
            <Stat label="Services displaced" value={a.disruptions.displacedSteps} />
            <Stat label="Re-plans applied" value={`${a.disruptions.proposalsApplied}/${a.disruptions.proposals}`} />
            <Stat label="Mean decision time" value={fmt(a.disruptions.meanDecisionSec, ' s')} hint="From proposal to staff approval" />
            <Stat label="Capacity released" value={a.recovery.capacityReleases} />
            <Stat label="Waitlist offers" value={a.recovery.offersMade} />
            <Stat label="Offers accepted" value={a.recovery.offersAccepted} />
            <Stat label="Cancellation → rebooked" value={fmt(a.recovery.meanRecoveryMin, ' min')} />
          </div>
        </section>

        <section className="panel">
          <h2>Reliability</h2>
          <div className="stat-grid compact">
            <Stat label="Side effects delivered" value={a.reliability.delivered} />
            <Stat label="Pending" value={a.reliability.pending} />
            <Stat label="Failed (gave up)" value={a.reliability.failed} />
            <Stat label="Retries" value={a.reliability.retries} />
            <Stat label="Recovered after retry" value={a.reliability.recovered_after_retry} />
          </div>
          <p className="muted small">Notifications and capacity recovery go through a transactional outbox; deliveries retry with exponential backoff (5 attempts).</p>
        </section>

        <section className="panel">
          <h2>Service durations</h2>
          <table className="mini">
            <thead>
              <tr>
                <th>Service</th>
                <th>Configured</th>
                <th>Observed</th>
                <th>n</th>
              </tr>
            </thead>
            <tbody>
              {a.serviceDurations.map((s) => (
                <tr key={s.code}>
                  <td title={s.name}>{s.code}</td>
                  <td>{s.configuredMin} min</td>
                  <td className={s.observedMin > s.configuredMin * 1.15 ? 'warn' : ''}>{fmt(s.observedMin, ' min')}</td>
                  <td>{s.samples}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Live estimates blend configured durations with observed ones as samples accumulate.</p>
        </section>

        <section className="panel">
          <h2>API latency</h2>
          {a.apiLatency.length === 0 ? (
            <p className="muted">No requests recorded since the API started.</p>
          ) : (
            <table className="mini">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>n</th>
                  <th>p50 ms</th>
                  <th>p95 ms</th>
                </tr>
              </thead>
              <tbody>
                {a.apiLatency.slice(0, 10).map((l) => (
                  <tr key={l.route}>
                    <td>
                      <code>{l.route}</code>
                    </td>
                    <td>{l.count}</td>
                    <td>{l.p50}</td>
                    <td>{l.p95}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
