import { useState } from 'react';
import { time } from '../format.js';

const SPANS = { '2h': [-30, 90], '4h': [-60, 180], '8h': [-120, 360] };

/** Gantt view of every resource: committed reservations, live projections and downtime. */
export default function Timeline({ board }) {
  const [span, setSpan] = useState('4h');
  const now = Date.parse(board.now);
  const [before, after] = SPANS[span];
  const from = now + before * 60_000;
  const to = now + after * 60_000;
  const pct = (t) => ((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100;

  const ticks = [];
  for (let t = Math.ceil(from / 1_800_000) * 1_800_000; t <= to; t += 1_800_000) ticks.push(t);

  const blocks = board.timeline.filter((b) => Date.parse(b.end) > from && Date.parse(b.start) < to);

  return (
    <>
      <div className="panel-head">
        <h2>Resource timeline</h2>
        <div className="seg">
          {Object.keys(SPANS).map((k) => (
            <button key={k} className={k === span ? 'active' : ''} onClick={() => setSpan(k)}>
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="legend">
        <span className="lg lg-completed">Done</span>
        <span className="lg lg-in_use">In service</span>
        <span className="lg lg-confirmed">Booked</span>
        <span className="lg lg-held">On hold</span>
        <span className="lg lg-downtime">Unavailable</span>
        <span className="lg lg-projected">Projected (running late)</span>
      </div>
      <div className="timeline">
        <div className="tl-axis">
          <div className="tl-label" />
          <div className="tl-track">
            {ticks.map((t) => (
              <span key={t} className="tl-tick" style={{ left: `${pct(t)}%` }}>
                {time(new Date(t).toISOString())}
              </span>
            ))}
          </div>
        </div>
        {board.resources.map((r) => (
          <div key={r.id} className={`tl-row ${r.state === 'down' ? 'tl-row-down' : ''}`}>
            <div className="tl-label" title={r.capabilities.join(', ')}>
              <span className={`res-dot res-${r.state}`} />
              {r.name}
            </div>
            <div className="tl-track">
              {ticks.map((t) => (
                <span key={t} className="tl-grid" style={{ left: `${pct(t)}%` }} />
              ))}
              {blocks
                .filter((b) => b.resourceId === r.id)
                .map((b) => {
                  const s = Date.parse(b.start);
                  const e = Date.parse(b.end);
                  const ps = b.projectedStart ? Date.parse(b.projectedStart) : null;
                  const pe = b.projectedEnd ? Date.parse(b.projectedEnd) : null;
                  const shifted = ps && b.status !== 'completed' && (ps - s > 2 * 60_000 || (b.status === 'in_use' && pe > e));
                  const title =
                    b.kind === 'downtime'
                      ? `Unavailable ${time(b.start)}–${time(b.end)}${b.reason ? ` · ${b.reason}` : ''}`
                      : `${b.patient} · ${b.service}\n${time(b.start)}–${time(b.end)} (${b.status})${shifted ? `\nprojected ${time(b.projectedStart)}–${time(b.projectedEnd)}` : ''}`;
                  return (
                    <span key={b.id}>
                      {shifted && (
                        <span className="tl-block tl-projected" style={{ left: `${pct(ps)}%`, width: `${Math.max(0.4, pct(pe) - pct(ps))}%` }} />
                      )}
                      <span
                        className={`tl-block tl-${b.kind === 'downtime' ? 'downtime' : b.status}`}
                        style={{ left: `${pct(s)}%`, width: `${Math.max(0.4, pct(e) - pct(s))}%` }}
                        title={title}
                      >
                        {b.kind === 'downtime' ? 'DOWN' : b.service}
                      </span>
                    </span>
                  );
                })}
              <span className="tl-now" style={{ left: `${pct(now)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
