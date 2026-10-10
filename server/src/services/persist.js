export async function insertPatient(tx, centreId, patient) {
  const { rows } = await tx.query('INSERT INTO patients (centre_id, name, phone) VALUES ($1, $2, $3) RETURNING id', [
    centreId,
    patient.name.trim(),
    patient.phone?.trim() || null,
  ]);
  return rows[0].id;
}

export async function insertVisit(tx, v) {
  const { rows } = await tx.query(
    `INSERT INTO visits (id, centre_id, patient_id, kind, status, scheduled_at, arrived_at, priority, notes, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING public_token`,
    [v.id, v.centreId, v.patientId, v.kind, v.status, v.scheduledAt, v.arrivedAt, v.priority, v.notes ?? null, v.source ?? 'staff'],
  );
  return rows[0];
}

export async function insertStep(tx, { id, visitId, serviceId, status }) {
  await tx.query('INSERT INTO visit_steps (id, visit_id, service_id, status) VALUES ($1, $2, $3, $4)', [id, visitId, serviceId, status]);
}

/**
 * Claims every resource of a placement and moves the step onto it.
 * If any claim overlaps an active reservation the exclusion constraint
 * raises 23P01 and the caller's whole transaction rolls back.
 */
export async function persistPlacement(tx, centreId, p, status, holdExpiresAt = null) {
  const start = new Date(p.start);
  const end = new Date(p.end);
  for (const rid of p.resourceIds) {
    await tx.query(
      `INSERT INTO reservations (centre_id, resource_id, step_id, kind, status, during, hold_expires_at)
       VALUES ($1, $2, $3, 'service', $4, tstzrange($5, $6, '[)'), $7)`,
      [centreId, rid, p.stepId, status, start, end, holdExpiresAt],
    );
  }
  await tx.query(
    `UPDATE visit_steps
     SET planned = tstzrange($2, $3, '[)'), status = 'scheduled',
         original_start = COALESCE(original_start, $2), version = version + 1
     WHERE id = $1`,
    [p.stepId, start, end],
  );
}

export async function releaseStepReservations(tx, stepIds, to = 'released') {
  if (stepIds.length === 0) return [];
  const { rows } = await tx.query(
    `UPDATE reservations SET status = $2, released_at = now()
     WHERE step_id = ANY($1) AND status IN ('held', 'confirmed', 'in_use')
     RETURNING step_id, resource_id, lower(during) AS start, upper(during) AS "end"`,
    [stepIds, to],
  );
  return rows;
}

export async function recordEstimates(tx, estimates, source) {
  for (const e of estimates) {
    await tx.query('INSERT INTO estimate_snapshots (step_id, predicted_start, source) VALUES ($1, $2, $3)', [
      e.stepId,
      new Date(e.predictedStart),
      source,
    ]);
  }
}
