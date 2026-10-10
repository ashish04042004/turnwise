CREATE TYPE staff_role AS ENUM ('reception', 'technician', 'manager');

CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id uuid NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  name text NOT NULL,
  role staff_role NOT NULL,
  pin_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  -- Bumped on sign-out so every outstanding session token for this person stops working.
  session_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (centre_id, name)
);
