import { createHash } from 'node:crypto';
import { getReference } from './reference.js';

/** Deterministic pseudo-random in [0, 1) so the same key behaves the same on every run. */
export const unit = (key) => createHash('sha1').update(key).digest().readUInt32BE(0) / 2 ** 32;

/** Picks from `[{ weight, ... }]` in proportion to weight, using r in [0, 1). */
export function pickWeighted(options, r) {
  const total = options.reduce((t, o) => t + o.weight, 0);
  let x = r * total;
  for (const o of options) {
    x -= o.weight;
    if (x < 0) return o;
  }
  return options.at(-1);
}

/**
 * Synthetic people for demos, load tests and the simulator, built from the
 * synthetic_names table. Never real patient data.
 */
export async function syntheticPeople(centre) {
  return peopleFrom((await getReference()).syntheticNames, centre.settings.sim_phone_prefix);
}

export function peopleFrom(names, prefix) {
  if (!names.first.length || !names.last.length) throw new Error('No synthetic names loaded (run `npm run seed`)');
  return {
    name: (seed = Math.random().toString()) =>
      `${names.first[Math.floor(unit(`f${seed}`) * names.first.length)]} ${names.last[Math.floor(unit(`l${seed}`) * names.last.length)]}`,
    phone: (seed = Math.random().toString()) => `${prefix}${String(Math.floor(unit(`p${seed}`) * 1e9)).padStart(9, '0')}`,
  };
}

/** A visit's service codes drawn from one of the centre's demand mixes, keeping only codes the centre offers. */
export function drawServices(centre, purpose, r, byCode) {
  const mixes = centre.demand[purpose];
  if (!mixes?.length) throw new Error(`${centre.name} has no ${purpose} demand mix configured`);
  return pickWeighted(mixes, r).services.filter((c) => byCode.has(c));
}
