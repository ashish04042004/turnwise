-- Reference data that used to live in code. Behaviour that varies by centre
-- (settings, categories, priority levels, message wording, demand mixes) and
-- access control (roles and their permissions) are rows, so they can change
-- without a deploy. Code only defines which permission guards which action.

-- Access control ------------------------------------------------------------

CREATE TABLE roles (
  code       text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label      text NOT NULL,
  sort_order int  NOT NULL DEFAULT 0
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles(code) ON UPDATE CASCADE ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON UPDATE CASCADE ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

INSERT INTO roles (code, label, sort_order) VALUES
  ('manager', 'Manager', 0),
  ('reception', 'Front desk', 1),
  ('technician', 'Technician', 2);

INSERT INTO permissions (code, description) VALUES
  ('frontDesk', 'Walk-ins, bookings, check-in, cancellations and the waitlist'),
  ('floor', 'Start, complete and extend services'),
  ('resources', 'Mark machines, rooms and staff unavailable or back in service'),
  ('replan', 'Request, apply and reject re-plan proposals'),
  ('simulate', 'Drive the demo simulator'),
  ('staff', 'Add staff, change roles, reset PINs and deactivate accounts'),
  ('settings', 'Change centre settings and reference data');

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('manager', 'frontDesk'), ('manager', 'floor'), ('manager', 'resources'), ('manager', 'replan'),
  ('manager', 'simulate'), ('manager', 'staff'), ('manager', 'settings'),
  ('reception', 'frontDesk'), ('reception', 'replan'),
  ('technician', 'floor'), ('technician', 'resources');

ALTER TABLE staff ALTER COLUMN role TYPE text USING role::text;
DROP TYPE staff_role;
ALTER TABLE staff ADD CONSTRAINT staff_role_fk FOREIGN KEY (role) REFERENCES roles(code) ON UPDATE CASCADE;

-- Centres -------------------------------------------------------------------

ALTER TABLE centres ADD COLUMN locale text NOT NULL DEFAULT 'en-IN';
-- Order on the sign-in screen; the first centre is the default.
ALTER TABLE centres ADD COLUMN display_order int NOT NULL DEFAULT 0;

-- Settings ------------------------------------------------------------------

-- What can be configured, with a default and bounds. Code reads settings by key;
-- a centre overrides only what differs from the default.
CREATE TABLE setting_definitions (
  key           text PRIMARY KEY,
  description   text  NOT NULL,
  value_type    text  NOT NULL CHECK (value_type IN ('integer', 'number', 'boolean', 'text')),
  default_value jsonb NOT NULL,
  min_value     numeric,
  max_value     numeric,
  category      text  NOT NULL DEFAULT 'general'
);

CREATE TABLE centre_settings (
  centre_id  uuid  NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  key        text  NOT NULL REFERENCES setting_definitions(key) ON UPDATE CASCADE ON DELETE CASCADE,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (centre_id, key)
);

INSERT INTO setting_definitions (key, description, value_type, default_value, min_value, max_value, category) VALUES
  ('slot_granularity_min', 'Planner time granularity; start times round up to this many minutes', 'integer', '5', 1, 60, 'planning'),
  ('overrun_grace_min', 'Overruns shorter than this only show as projected delay', 'integer', '5', 0, 60, 'planning'),
  ('overrun_extend_min', 'How far the overrun sweeper extends a service each time', 'integer', '5', 1, 60, 'planning'),
  ('slot_search_step_min', 'Spacing between alternative start times offered when booking', 'integer', '15', 5, 120, 'booking'),
  ('slot_search_options', 'How many alternative start times to offer when booking', 'integer', '5', 1, 20, 'booking'),
  ('late_arrival_flag_min', 'Flag a booked patient as late after this many minutes', 'integer', '10', 1, 120, 'floor'),
  ('running_late_flag_min', 'Flag a service as running late when projected this many minutes behind', 'integer', '10', 1, 120, 'floor'),
  ('waitlist_offer_cooldown_min', 'After someone lets an offer expire, wait this long before offering them another', 'integer', '30', 0, 1440, 'waitlist'),
  ('comparison_replications', 'Service-duration draws per policy comparison', 'integer', '8', 1, 50, 'analytics'),
  ('demo_sign_in_hint', 'Text shown under the sign-in form (for demo centres)', 'text', '""', NULL, NULL, 'general'),
  ('sim_breakdown_capability', 'Simulator: which kind of machine breaks down', 'text', '"ultrasound"', NULL, NULL, 'simulator'),
  ('sim_breakdown_reason', 'Simulator: reason recorded for a breakdown', 'text', '"Equipment fault — service engineer called"', NULL, NULL, 'simulator'),
  ('sim_focus_category', 'Simulator: category preferred for cancellations and overruns', 'text', '"imaging"', NULL, NULL, 'simulator'),
  ('sim_no_show_rate', 'Simulator: share of booked patients who never arrive', 'number', '0.08', 0, 1, 'simulator'),
  ('sim_early_rate', 'Simulator: share of arriving patients who come early rather than late', 'number', '0.7', 0, 1, 'simulator'),
  ('sim_phone_prefix', 'Simulator: prefix for synthetic phone numbers (never real ones)', 'text', '"+91 9"', NULL, NULL, 'simulator');

-- Catalogue labels ----------------------------------------------------------

CREATE TABLE service_categories (
  centre_id  uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  -- Order a token system would send patients through departments (used by the baseline comparison).
  sort_order int  NOT NULL DEFAULT 0,
  PRIMARY KEY (centre_id, code)
);
INSERT INTO service_categories (centre_id, code, name)
  SELECT DISTINCT centre_id, category, initcap(category) FROM services;
ALTER TABLE services ADD CONSTRAINT services_category_fk
  FOREIGN KEY (centre_id, category) REFERENCES service_categories(centre_id, code) ON UPDATE CASCADE;

-- What a requirement means ("ultrasound", "radiologist"); resources and services refer to these codes.
CREATE TABLE capabilities (
  centre_id uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  code      text NOT NULL,
  name      text NOT NULL,
  PRIMARY KEY (centre_id, code)
);
INSERT INTO capabilities (centre_id, code, name)
  SELECT DISTINCT centre_id, c, initcap(replace(c, '_', ' ')) FROM (
    SELECT centre_id, unnest(capabilities) AS c FROM resources
    UNION SELECT centre_id, unnest(requirements) FROM services
  ) x;

-- Operational urgency levels front desk can choose (not clinical triage).
CREATE TABLE priority_levels (
  centre_id   uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  level       int  NOT NULL CHECK (level BETWEEN 0 AND 10),
  label       text NOT NULL,
  description text,
  PRIMARY KEY (centre_id, level)
);
INSERT INTO priority_levels (centre_id, level, label)
  SELECT id, 0, 'Standard' FROM centres;

-- Patient messages ----------------------------------------------------------

-- Default wording for every message the system sends; {placeholders} are
-- filled in when a message is queued. Kept apart from centre overrides so
-- clearing centres never loses the defaults.
CREATE TABLE message_templates (
  key         text NOT NULL,
  channel     text NOT NULL DEFAULT 'sms',
  body        text NOT NULL,
  description text,
  PRIMARY KEY (key, channel)
);
INSERT INTO message_templates (key, body, description) VALUES
  ('booking.confirmed', 'Your visit at {centre} is confirmed for {time}.', 'Sent when a booking is confirmed. {time}'),
  ('visit.cancelled', 'Your visit at {centre} has been cancelled.', 'Sent when a visit is cancelled.'),
  ('replan.moved', 'Update from {centre}: your {service} is now at {time} ({resources}).', 'Sent when a re-plan moves a service. {service} {time} {resources}'),
  ('waitlist.offer', '{centre}: a slot opened at {time}. Accept within {minutes} min: {link}', 'Offer to a waitlisted patient. {time} {minutes} {link}');

-- A centre's own wording for a message.
CREATE TABLE centre_message_templates (
  centre_id uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  key       text NOT NULL,
  channel   text NOT NULL DEFAULT 'sms',
  body      text NOT NULL,
  PRIMARY KEY (centre_id, key, channel),
  FOREIGN KEY (key, channel) REFERENCES message_templates(key, channel) ON UPDATE CASCADE ON DELETE CASCADE
);

-- Demand profiles -----------------------------------------------------------

-- Typical combinations of tests patients ask for, with relative frequency.
-- Used to generate synthetic demand (seeding, simulator) and nothing else.
CREATE TABLE demand_mixes (
  id            serial PRIMARY KEY,
  centre_id     uuid    NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  purpose       text    NOT NULL CHECK (purpose IN ('appointment', 'walk_in', 'waitlist')),
  weight        numeric NOT NULL CHECK (weight > 0),
  service_codes text[]  NOT NULL CHECK (cardinality(service_codes) > 0)
);
CREATE INDEX demand_mixes_centre_idx ON demand_mixes (centre_id, purpose);

-- Name pools for synthetic patients. Never real people.
CREATE TABLE synthetic_names (
  part  text NOT NULL CHECK (part IN ('first', 'last')),
  value text NOT NULL,
  PRIMARY KEY (part, value)
);

-- Cache invalidation --------------------------------------------------------

-- Any change to reference data, including a hand-edited row, tells every API
-- process and worker to drop what it cached for that centre (or for all
-- centres when the row is global). Delivered only on commit.
CREATE FUNCTION turnwise_notify_config() RETURNS trigger AS $$
DECLARE
  rec record;
  centre uuid;
  subject text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    -- No rows to inspect: tell every process to drop everything.
    PERFORM pg_notify('turnwise_config', json_build_object('table', TG_TABLE_NAME, 'centreId', NULL, 'id', NULL)::text);
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  IF TG_TABLE_NAME = 'centres' THEN
    centre := rec.id;
  ELSIF TG_TABLE_NAME = 'service_prerequisites' THEN
    SELECT s.centre_id INTO centre FROM services s WHERE s.id = rec.service_id;
  ELSIF TG_TABLE_NAME IN ('roles', 'permissions', 'role_permissions', 'setting_definitions', 'synthetic_names', 'message_templates') THEN
    centre := NULL;
  ELSE
    centre := rec.centre_id;
  END IF;
  IF TG_TABLE_NAME = 'staff' THEN
    subject := rec.id::text;
  END IF;
  PERFORM pg_notify('turnwise_config', json_build_object('table', TG_TABLE_NAME, 'centreId', centre, 'id', subject)::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['centres', 'centre_settings', 'setting_definitions', 'roles', 'permissions', 'role_permissions',
                           'staff', 'service_categories', 'capabilities', 'priority_levels', 'message_templates', 'centre_message_templates',
                           'demand_mixes', 'synthetic_names', 'resources', 'services', 'service_prerequisites']
  LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION turnwise_notify_config()',
                   t || '_config_notify', t);
    EXECUTE format('CREATE TRIGGER %I AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION turnwise_notify_config()',
                   t || '_config_truncate', t);
  END LOOP;
END $$;
