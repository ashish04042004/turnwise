import { useState } from 'react';
import { post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { time } from '../format.js';
import { useAction } from '../toast.jsx';

/** Staff-facing re-plan decision: Turnwise proposes, a person approves. */
export default function ProposalPanel({ proposal }) {
  const run = useAction();
  const { can } = useAuth();
  const recommended = proposal.options.find((o) => o.recommended) ?? proposal.options[0];
  const [chosen, setChosen] = useState(recommended.key);
  const [busy, setBusy] = useState(false);
  const option = proposal.options.find((o) => o.key === chosen) ?? recommended;

  const act = async (fn, msg) => {
    setBusy(true);
    await run(fn, msg);
    setBusy(false);
  };

  return (
    <section className="proposal">
      <div className="proposal-head">
        <div>
          <div className="eyebrow">Re-plan needed · {time(proposal.createdAt)}</div>
          <h2>{proposal.trigger}</h2>
          <p className="muted">Pick how to absorb the disruption. Nothing changes until you apply, and the plan is re-checked against live capacity when you do.</p>
        </div>
      </div>
      <div className="options">
        {proposal.options.map((o) => (
          <button key={o.key} className={`option ${o.key === chosen ? 'selected' : ''}`} onClick={() => setChosen(o.key)}>
            <div className="option-title">
              {o.title} {o.recommended && <span className="badge badge-rec">Recommended</span>}
            </div>
            <div className="option-summary">{o.summary}</div>
            <div className="option-metrics">
              <span>
                <strong>{o.metrics.patientsAffected}</strong> patients
              </span>
              <span>
                <strong>{o.metrics.maxDelayMin}</strong> min worst delay
              </span>
              <span>
                <strong>{o.metrics.totalDelayMin}</strong> min total
              </span>
              <span className={o.metrics.unschedulable ? 'bad' : ''}>
                <strong>{o.metrics.unschedulable}</strong> without a slot
              </span>
            </div>
          </button>
        ))}
      </div>
      <div className="moves">
        {option.moves.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Service</th>
                <th>Was</th>
                <th>Becomes</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {option.moves.map((m) => (
                <tr key={m.stepId} className={m.wasDisplaced ? 'row-hit' : ''}>
                  <td>
                    {m.patient}
                    {m.wasDisplaced && <span className="badge badge-hit">affected</span>}
                  </td>
                  <td>{m.service}</td>
                  <td>
                    {m.from ? time(m.from.start) : '—'} <span className="muted">{m.from?.resources.join(' + ')}</span>
                  </td>
                  <td>
                    {time(m.to.start)} <span className="muted">{m.to.resources.join(' + ')}</span>
                  </td>
                  <td className={m.delayMin > 15 ? 'bad' : m.delayMin > 0 ? 'warn' : 'good'}>{m.delayMin > 0 ? `+${m.delayMin} min` : m.delayMin < 0 ? `${m.delayMin} min` : 'same time'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {option.unschedulable.length > 0 && (
          <div className="unschedulable">
            <strong>No feasible slot today:</strong>
            <ul>
              {option.unschedulable.map((u) => (
                <li key={u.stepId}>
                  {u.patient} · {u.service} — {u.reason}
                </li>
              ))}
            </ul>
            <span className="muted">These stay flagged for staff to decide (call the patient, rebook another day, or cancel).</span>
          </div>
        )}
      </div>
      <div className="proposal-actions">
        {can('replan') ? (
          <>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => act(() => post(`/proposals/${proposal.id}/apply`, { option: option.key }), (r) => `Applied: ${r.applied} service(s) re-timed, patients notified`)}
            >
              Apply “{option.title}”
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => post(`/proposals/${proposal.id}/reject`), 'Proposal dismissed')}>
              Dismiss
            </button>
          </>
        ) : (
          <span className="role-note">The front desk or a manager approves re-plans.</span>
        )}
      </div>
    </section>
  );
}
