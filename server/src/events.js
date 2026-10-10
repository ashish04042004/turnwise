/** Appends to the audit log. The insert trigger fans it out to live dashboards on commit. */
export async function recordEvent(db, centreId, type, subjectId, payload = {}, actor = 'system') {
  const { rows } = await db.query(
    `INSERT INTO events (centre_id, type, subject_id, payload, actor) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [centreId, type, subjectId, JSON.stringify(payload), actor],
  );
  return rows[0].id;
}

/**
 * Records a side effect ('notify.patient' | 'capacity.released') in the
 * caller's transaction. Delivery happens later and may be retried, so the
 * idempotency key must identify the logical effect.
 */
export async function enqueueOutbox(db, centreId, topic, payload, idempotencyKey) {
  await db.query(
    `INSERT INTO outbox (centre_id, topic, payload, idempotency_key) VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [centreId, topic, JSON.stringify(payload), idempotencyKey],
  );
}

export async function notifyPatient(db, centreId, { visitId, phone, name, message, key }) {
  await enqueueOutbox(db, centreId, 'notify.patient', { visitId, recipient: phone, name, message }, key);
}
