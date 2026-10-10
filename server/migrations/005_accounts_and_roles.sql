-- Accounts, self-service centres and per-centre roles.
--
-- A user is a person with an email and password. Their membership of a
-- centre is a staff row, which carries the role, so one account can work at
-- several centres. Staff rows without an account still exist: shared
-- front-desk terminals switch between them by PIN.

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name            text NOT NULL,
  password_hash   text NOT NULL,
  -- Bumped on "sign out everywhere" or a password change so every outstanding session token stops working.
  session_version integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE staff ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX staff_centre_user ON staff (centre_id, user_id) WHERE user_id IS NOT NULL;
-- People who sign in with their account need no PIN until they use a shared terminal.
ALTER TABLE staff ALTER COLUMN pin_hash DROP NOT NULL;

-- Demo centres are synthetic, listed on the public sign-in screen and replaced
-- by the seeder. Everyone else's centre is private: no public staff list, and
-- PIN sign-in only on terminals its managers enrolled.
ALTER TABLE centres ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
UPDATE centres SET is_demo = true;
-- Shared with colleagues so they can ask to join; NULL means not accepting requests.
ALTER TABLE centres ADD COLUMN join_code text UNIQUE CHECK (join_code ~ '^[A-Z0-9]{8}$');

CREATE TABLE join_requests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id  uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    text,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text
);
CREATE UNIQUE INDEX join_requests_one_pending ON join_requests (centre_id, user_id) WHERE status = 'pending';

-- Devices a manager has enrolled for PIN switching between colleagues.
CREATE TABLE terminals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id  uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- Roles per centre -----------------------------------------------------------

INSERT INTO permissions (code, description) VALUES
  ('roles', 'Create roles and choose what each role may do');
INSERT INTO role_permissions (role_code, permission_code) VALUES ('manager', 'roles');

COMMENT ON TABLE roles IS 'Role templates: copied into every new centre, which then edits its own';
COMMENT ON TABLE role_permissions IS 'Permissions of the role templates';

CREATE TABLE centre_roles (
  centre_id   uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  code        text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       text NOT NULL,
  description text,
  sort_order  int  NOT NULL DEFAULT 0,
  PRIMARY KEY (centre_id, code)
);

CREATE TABLE centre_role_permissions (
  centre_id       uuid NOT NULL,
  role_code       text NOT NULL,
  permission_code text NOT NULL REFERENCES permissions(code) ON UPDATE CASCADE ON DELETE CASCADE,
  PRIMARY KEY (centre_id, role_code, permission_code),
  FOREIGN KEY (centre_id, role_code) REFERENCES centre_roles(centre_id, code) ON UPDATE CASCADE ON DELETE CASCADE
);

INSERT INTO centre_roles (centre_id, code, label, sort_order)
  SELECT c.id, r.code, r.label, r.sort_order FROM centres c CROSS JOIN roles r;
INSERT INTO centre_role_permissions (centre_id, role_code, permission_code)
  SELECT c.id, rp.role_code, rp.permission_code FROM centres c CROSS JOIN role_permissions rp;

ALTER TABLE staff DROP CONSTRAINT staff_role_fk;
ALTER TABLE staff ADD CONSTRAINT staff_centre_role_fk
  FOREIGN KEY (centre_id, role) REFERENCES centre_roles(centre_id, code) ON UPDATE CASCADE;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['centre_roles', 'centre_role_permissions']
  LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION turnwise_notify_config()',
                   t || '_config_notify', t);
    EXECUTE format('CREATE TRIGGER %I AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION turnwise_notify_config()',
                   t || '_config_truncate', t);
  END LOOP;
END $$;

-- Deleting a centre cascades through its rows in no fixed order, so these
-- references can be checked before the rows pointing at them are gone. They
-- stay immediate for everyday writes; the seeder defers them while it
-- replaces the demo centres.
ALTER TABLE services ALTER CONSTRAINT services_category_fk DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE visits ALTER CONSTRAINT visits_patient_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE visit_steps ALTER CONSTRAINT visit_steps_service_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE reservations ALTER CONSTRAINT reservations_resource_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE waitlist_entries ALTER CONSTRAINT waitlist_entries_patient_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE waitlist_entries ALTER CONSTRAINT waitlist_entries_offered_visit_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE staff ALTER CONSTRAINT staff_centre_role_fk DEFERRABLE INITIALLY IMMEDIATE;

-- Every API process caches who holds a session; tell them all when an account changes.
CREATE FUNCTION turnwise_notify_user() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('turnwise_config', json_build_object('table', 'users', 'centreId', NULL, 'id', OLD.id)::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_notify AFTER UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION turnwise_notify_user();
