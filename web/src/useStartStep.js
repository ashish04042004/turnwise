import { post } from './api.js';
import { useToast } from './toast.jsx';

/** Starts a step, explaining any resource swap or bumped booking, and offering to force past a protected one. */
export function useStartStep() {
  const toast = useToast();
  const start = async (stepId, label, force = false) => {
    try {
      const r = await post(`/steps/${stepId}/start`, { force });
      const where = r.swapped ? ` in ${r.swapped.to.join(' + ')} (${r.swapped.from.join(' + ')} was busy)` : '';
      toast(
        r.displaced.length ? `${label} started${where}; ${r.displaced.length} later booking(s) need a new time` : `${label} started${where}`,
        r.displaced.length ? 'info' : 'success',
      );
    } catch (err) {
      if (err.details?.canForce && window.confirm(`${err.message}.\n\nStart anyway? The other booking will be re-planned.`)) return start(stepId, label, true);
      toast(err.message, 'error');
    }
  };
  return start;
}
