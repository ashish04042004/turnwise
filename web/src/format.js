let tz = 'Asia/Kolkata';
export const setTimezone = (zone) => {
  if (zone) tz = zone;
};

export function time(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
}

export function clock(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz });
}

export const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60_000);

export function relative(iso, nowIso) {
  if (!iso) return '';
  const m = minutesBetween(nowIso, iso);
  if (m === 0) return 'now';
  return m > 0 ? `in ${m} min` : `${-m} min ago`;
}

export const STEP_LABEL = {
  scheduled: 'Scheduled',
  in_service: 'In service',
  completed: 'Done',
  cancelled: 'Cancelled',
  displaced: 'Needs new time',
  unscheduled: 'No slot',
};

export const VISIT_LABEL = {
  held: 'On hold',
  booked: 'Booked',
  arrived: 'Waiting',
  in_progress: 'In service',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  expired: 'Expired',
};

export const FLAG_LABEL = {
  needs_replan: 'Needs re-plan',
  late_arrival: 'Late',
  running_late: 'Running late',
  overrun: 'Overrunning',
};
