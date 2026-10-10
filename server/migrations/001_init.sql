-- Turnwise core schema.
-- PostgreSQL is the source of truth: double-booking is prevented by exclusion
-- constraints, not by application-level locks.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE centres (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  city               text NOT NULL,
  timezone           text NOT NULL DEFAULT 'Asia/Kolkata',
  opens_at           time NOT NULL,
  closes_at          time NOT NULL,
  hold_ttl_seconds   int  NOT NULL DEFAULT 120 CHECK (hold_ttl_seconds > 0),
  offer_ttl_seconds  int  NOT NULL DEFAULT 600 CHECK (offer_ttl_seconds > 0),
  offer_lead_minutes int  NOT NULL DEFAULT 20 CHECK (offer_lead_minutes >= 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- A resource is anything with finite capacity: a machine, a room or a person.
-- A capability says what kind of requirement the resource can satisfy.
CREATE TABLE resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id    uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('equipment', 'staff', 'room')),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) > 0),
  active       boolean NOT NULL DEFAULT true,
  sort_order   int NOT NULL DEFAULT 0,
  UNIQUE (centre_id, name)
);

-- Each entry in requirements needs one distinct resource with that capability
-- for the whole duration of the service.
CREATE TABLE services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id    uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  category     text NOT NULL,
  duration_min int  NOT NULL CHECK (duration_min > 0),
  requirements text[] NOT NULL CHECK (cardinality(requirements) > 0),
  UNIQUE (centre_id, code)
);

-- Centre-configured ordering rules, e.g. post-prandial sugar >= 120 min after fasting sugar.
CREATE TABLE service_prerequisites (
  service_id          uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  requires_service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  min_gap_min         int  NOT NULL DEFAULT 0 CHECK (min_gap_min >= 0),
  PRIMARY KEY (service_id, requires_service_id),
  CHECK (service_id <> requires_service_id)
);

CREATE TABLE patients (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id  uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  name       text NOT NULL,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE visits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id    uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  patient_id   uuid NOT NULL REFERENCES patients(id),
  kind         text NOT NULL CHECK (kind IN ('appointment', 'walk_in')),
  status       text NOT NULL CHECK (status IN ('held', 'booked', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_show', 'expired')),
  scheduled_at timestamptz,
  arrived_at   timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  priority     int  NOT NULL DEFAULT 0,
  notes        text,
  source       text NOT NULL DEFAULT 'staff',
  public_token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(9), 'hex'),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visits_centre_sched_idx ON visits (centre_id, scheduled_at);
CREATE INDEX visits_centre_created_idx ON visits (centre_id, created_at);

-- One row per service a visit needs. The patient is also a constrained
-- resource: they cannot be in two active steps at the same time.
CREATE TABLE visit_steps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id       uuid NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  service_id     uuid NOT NULL REFERENCES services(id),
  status         text NOT NULL CHECK (status IN ('scheduled', 'displaced', 'unscheduled', 'in_service', 'completed', 'cancelled')),
  planned        tstzrange,
  original_start timestamptz,
  actual_start   timestamptz,
  actual_end     timestamptz,
  version        int NOT NULL DEFAULT 0,
  CHECK (status NOT IN ('scheduled', 'in_service') OR planned IS NOT NULL),
  CONSTRAINT visit_steps_patient_no_overlap
    EXCLUDE USING gist (visit_id WITH =, planned WITH &&)
    WHERE (status IN ('scheduled', 'in_service'))
);
CREATE INDEX visit_steps_visit_idx ON visit_steps (visit_id);
CREATE INDEX visit_steps_status_idx ON visit_steps (status);

-- Every claim on a resource's time: bookings (held/confirmed/in_use) and downtime.
CREATE TABLE reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id       uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  resource_id     uuid NOT NULL REFERENCES resources(id),
  step_id         uuid REFERENCES visit_steps(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('service', 'downtime')),
  status          text NOT NULL CHECK (status IN ('held', 'confirmed', 'in_use', 'completed', 'released', 'expired')),
  during          tstzrange NOT NULL CHECK (NOT isempty(during)),
  hold_expires_at timestamptz,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  CHECK (kind = 'downtime' OR step_id IS NOT NULL),
  CHECK (status <> 'held' OR hold_expires_at IS NOT NULL),
  CONSTRAINT reservations_no_double_booking
    EXCLUDE USING gist (resource_id WITH =, during WITH &&)
    WHERE (status IN ('held', 'confirmed', 'in_use'))
);
CREATE INDEX reservations_step_idx ON reservations (step_id);
CREATE INDEX reservations_held_idx ON reservations (hold_expires_at) WHERE status = 'held';
CREATE INDEX reservations_centre_during_idx ON reservations USING gist (centre_id, during);

CREATE TABLE replan_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id     uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  trigger       text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'stale', 'superseded')),
  options       jsonb NOT NULL,
  chosen_option text,
  decided_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE INDEX replan_pending_idx ON replan_proposals (centre_id) WHERE status = 'pending';

CREATE TABLE waitlist_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id             uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  patient_id            uuid NOT NULL REFERENCES patients(id),
  service_ids           uuid[] NOT NULL,
  earliest              timestamptz NOT NULL,
  latest                timestamptz NOT NULL,
  status                text NOT NULL CHECK (status IN ('waiting', 'offered', 'booked', 'withdrawn')),
  offered_visit_id      uuid REFERENCES visits(id),
  offer_expires_at      timestamptz,
  capacity_released_at  timestamptz,
  last_offer_expired_at timestamptz,
  offers_made           int NOT NULL DEFAULT 0,
  booked_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (latest > earliest)
);

-- What Turnwise promised a patient, so estimate accuracy can be measured later.
CREATE TABLE estimate_snapshots (
  id              bigserial PRIMARY KEY,
  step_id         uuid NOT NULL REFERENCES visit_steps(id) ON DELETE CASCADE,
  predicted_start timestamptz NOT NULL,
  made_at         timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL
);
CREATE INDEX estimate_snapshots_step_idx ON estimate_snapshots (step_id, made_at);

-- Append-only audit log; also the replay source for live dashboards.
CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  centre_id  uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  type       text NOT NULL,
  subject_id uuid,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor      text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_centre_id_idx ON events (centre_id, id);
CREATE INDEX events_type_idx ON events (centre_id, type, created_at);

-- Transactional outbox: side effects are recorded in the same transaction as
-- the state change and delivered later by workers.
CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  centre_id       uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  topic           text NOT NULL,
  payload         jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'delivered', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz,
  delivered_at    timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (id) WHERE status IN ('pending', 'dispatched');

CREATE TABLE notifications (
  id        bigserial PRIMARY KEY,
  outbox_id bigint NOT NULL UNIQUE REFERENCES outbox(id) ON DELETE CASCADE,
  centre_id uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  channel   text NOT NULL,
  recipient text,
  body      text NOT NULL,
  sent_at   timestamptz NOT NULL DEFAULT now()
);

-- pg_notify is transactional: listeners only hear about committed events.
CREATE FUNCTION turnwise_notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'turnwise_events',
    json_build_object('id', NEW.id, 'centreId', NEW.centre_id, 'type', NEW.type, 'subjectId', NEW.subject_id)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_notify AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION turnwise_notify_event();
