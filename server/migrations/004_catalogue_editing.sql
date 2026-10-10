-- Managers edit the catalogue from the dashboard. Visits keep referring to the
-- services they were booked for, so a service is retired rather than deleted:
-- it stops being offered for new bookings but history still resolves.
ALTER TABLE services ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE services ADD COLUMN sort_order int NOT NULL DEFAULT 0;

-- Codes are what resources, services, settings and demand mixes refer to; keep them tidy.
ALTER TABLE service_categories ADD CONSTRAINT service_categories_code_format CHECK (code ~ '^[A-Za-z][A-Za-z0-9_]*$');
ALTER TABLE capabilities ADD CONSTRAINT capabilities_code_format CHECK (code ~ '^[A-Za-z][A-Za-z0-9_]*$');
ALTER TABLE services ADD CONSTRAINT services_code_format CHECK (code ~ '^[A-Za-z][A-Za-z0-9_]*$');
ALTER TABLE centres ADD CONSTRAINT centres_hours_order CHECK (opens_at < closes_at);
