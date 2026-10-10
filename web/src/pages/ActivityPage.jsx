import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useConfig } from '../config.jsx';
import { clock, time } from '../format.js';
import { useLive } from '../live.jsx';

const DESCRIBE = {
  'centre.seeded': () => 'Synthetic day generated',
  'booking.held': (p) => `${p.patient} — slot held for ${time(p.start)}`,
  'booking.confirmed': (p) => `${p.patient} — booking confirmed`,
  'hold.expired': () => 'Unconfirmed hold expired; capacity released',
  'hold.revoked': (p) => `${p.patient} — hold revoked (${p.reason})`,
  'walkin.created': (p) => `${p.patient} walked in${p.unplaced?.length ? ` — no slot for ${p.unplaced.map((u) => u.serviceCode).join(', ')}` : ''}`,
  'visit.checked_in': (p) => `${p.patient} checked in${p.lateMin > 5 ? ` (${p.lateMin} min late)` : ''}`,
  'visit.cancelled': (p) => `${p.patient} cancelled${p.reason ? ` — ${p.reason}` : ''}`,
  'visit.no_show': (p) => `${p.patient} marked no-show`,
  'step.started': (p) => `${p.patient} started ${p.service}${p.lateMin > 2 ? ` (${p.lateMin} min late)` : ''}${p.forced ? ' — staff override' : ''}`,
  'step.resources_swapped': (p) => `${p.patient}'s ${p.service} moved from ${p.from.join(', ')} to ${p.to.join(', ')} (free and interchangeable)`,
  'step.completed': (p) => `${p.patient} finished ${p.service} in ${p.durationMin} min`,
  'step.extended': (p) => `${p.patient}'s ${p.service} extended by ${p.minutes} min${p.displaced ? `, displacing ${p.displaced}` : ''}`,
  'step.displaced': (p) => `${p.patient}'s ${p.service} lost its slot — ${p.reason}`,
  'resource.down': (p) => `${p.resource} unavailable until ${time(p.until)}${p.reason ? ` (${p.reason})` : ''}; ${p.displaced} affected`,
  'resource.up': (p) => `${p.resource} back in service`,
  'staff.added': (p, { roleLabel }) => `${p.name} added as ${roleLabel(p.role)}`,
  'staff.updated': (p, { roleLabel }) =>
    p.active === false
      ? `${p.name} deactivated`
      : p.active === true
        ? `${p.name} reactivated`
        : p.role
          ? `${p.name} is now ${roleLabel(p.role)}`
          : `${p.name}'s ${p.changed.includes('pin') ? 'PIN was reset' : 'details changed'}`,
  'catalogue.changed': (p) =>
    `${{ centre: 'Centre', category: 'Category', capability: 'Capability', resource: 'Resource', service: 'Service', priority: 'Priority level' }[p.entity] ?? p.entity} ${p.name} ${p.action}${
      p.changed?.length ? ` (${p.changed.join(', ')})` : ''
    }${p.displaced ? `; ${p.displaced} booking(s) need a new time` : ''}`,
  'settings.changed': (p) => `Setting ${p.key} ${p.reset ? 'reset to default' : 'changed'}: ${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}`,
  'replan.proposed': (p) => `Re-plan proposed: ${p.trigger}`,
  'replan.applied': (p) => `Re-plan applied (${p.option}): ${p.moved} moved, ${p.unschedulable} without slot, decided in ${p.decisionSec}s`,
  'replan.rejected': () => 'Re-plan dismissed',
  'waitlist.added': (p) => `${p.patient} joined the waitlist`,
  'waitlist.offered': (p) => `Opening at ${time(p.start)} offered to ${p.patient}`,
  'waitlist.booked': (p) => `Waitlist offer accepted — capacity recovered in ${p.recoveryMin} min`,
  'waitlist.declined': () => 'Waitlist offer declined',
  'capacity.unclaimed': (p) => `Opening ${time(p.start)}–${time(p.end)} had no eligible waitlist match`,
  'centre.created': (p) => `Centre ${p.name} created${p.starter === 'sample' ? ' from the sample catalogue' : ''}`,
  'roles.changed': (p) => `Role ${p.label} ${p.action}${p.permissions ? ` — can: ${p.permissions.join(', ') || 'nothing'}` : ''}`,
  'join.requested': (p) => `${p.name} (${p.email}) asked to join`,
  'join.approved': (p, { roleLabel }) => `${p.name} joined as ${roleLabel(p.role)}`,
  'join.rejected': (p) => `${p.name}'s request to join was declined`,
  'join.code_changed': (p) => (p.enabled ? 'New join code issued' : 'Join code turned off'),
  'terminal.enrolled': (p) => `Shared terminal "${p.name}" enrolled for PIN sign-in`,
  'terminal.revoked': (p) => `Shared terminal "${p.name}" revoked`,
};

const tone = (type) => (/down|displaced|no_show|unclaimed|expired|revoked/.test(type) ? 'bad' : /replan|extended|offered/.test(type) ? 'warn' : /completed|booked|confirmed|applied|up$/.test(type) ? 'good' : '');

export default function ActivityPage() {
  const { lastEvent } = useLive();
  const labels = useConfig();
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api('/events?limit=300').then(setEvents, () => undefined);
  }, [lastEvent?.id]);

  const shown = events.filter((e) => !filter || filter.split('|').some((prefix) => e.type.startsWith(prefix)));
  return (
    <section className="panel activity">
      <div className="panel-head">
        <h2>Audit trail</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All events</option>
          <option value="replan">Re-planning</option>
          <option value="resource">Resources</option>
          <option value="step">Services</option>
          <option value="visit">Visits</option>
          <option value="booking">Bookings</option>
          <option value="waitlist">Waitlist</option>
          <option value="staff">Staff</option>
          <option value="settings">Settings</option>
          <option value="catalogue">Catalogue</option>
          <option value="roles|join|terminal">Access</option>
        </select>
      </div>
      <p className="muted small">Every scheduling change is recorded in the same transaction as the change itself. Dashboards replay from this log after reconnecting.</p>
      <ol className="events">
        {shown.map((e) => (
          <li key={e.id} className={tone(e.type)}>
            <span className="ev-time">{clock(e.created_at)}</span>
            <span className="ev-type">{e.type}</span>
            <span className="ev-text">{(DESCRIBE[e.type] ?? (() => JSON.stringify(e.payload)))(e.payload, labels)}</span>
            <span className="ev-actor">{e.actor}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
