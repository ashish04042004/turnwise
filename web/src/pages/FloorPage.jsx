import { useAuth } from '../auth.jsx';
import { useLive } from '../live.jsx';
import NextUp from '../components/NextUp.jsx';
import ProposalPanel from '../components/ProposalPanel.jsx';
import QueueList from '../components/QueueList.jsx';
import ResourcePanel from '../components/ResourcePanel.jsx';
import ScenarioPanel from '../components/ScenarioPanel.jsx';
import Timeline from '../components/Timeline.jsx';

function Summary({ summary }) {
  const items = [
    ['Waiting', summary.waiting, 'Checked in, next service not started'],
    ['In service', summary.inService, 'Currently with a technician or machine'],
    ['Upcoming', summary.upcoming, 'Booked, not yet arrived'],
    ['Needs re-plan', summary.needsReplan, 'Services that lost their slot'],
    ['Completed', summary.completed, 'Visits finished today'],
    ['Estimate band', summary.estimateBandMin == null ? '—' : `±${summary.estimateBandMin}m`, '80% of today’s start-time promises were within this'],
  ];
  return (
    <div className="summary">
      {items.map(([label, value, hint]) => (
        <div key={label} className={`kpi ${label === 'Needs re-plan' && value > 0 ? 'kpi-warn' : ''}`} title={hint}>
          <div className="kpi-value">{value}</div>
          <div className="kpi-label">{label}</div>
        </div>
      ))}
    </div>
  );
}

export default function FloorPage() {
  const { board } = useLive();
  const { can } = useAuth();
  return (
    <div className="floor">
      <Summary summary={board.summary} />
      {board.alerts.length > 0 && (
        <div className="alerts">
          {board.alerts.map((a, i) => (
            <div key={i} className={`alert alert-${a.level}`}>
              {a.text.replace(/until (\S+Z)/, (_, iso) => `until ${new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: board.centre.timezone })}`)}
            </div>
          ))}
        </div>
      )}
      {board.proposal && <ProposalPanel key={board.proposal.id} proposal={board.proposal} />}
      <NextUp items={board.nextUp ?? []} />
      <div className="floor-grid">
        <section className="panel queue-panel">
          <QueueList visits={board.visits} now={board.now} />
        </section>
        <div className="floor-right">
          <section className="panel">
            <Timeline board={board} />
          </section>
          <section className="panel">
            <ResourcePanel resources={board.resources} />
          </section>
          {can('simulate') && (
            <section className="panel">
              <ScenarioPanel />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
