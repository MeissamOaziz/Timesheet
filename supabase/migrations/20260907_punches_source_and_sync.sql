-- Mobile app backend readiness (Phase 7). Two things this migration exists to fix:
--
-- 1. `punches` has never had a tracked migration in this repo at all -- the table (like `sites`
--    and `employee_portal`) was created directly in Supabase, outside git. That silence is what
--    caused the FK surprises during the 2026-09-04 dormant-account cleanup (discovering
--    `punches.company_id`, `missed_punch_requests.punch_id` and `join_requests` were all
--    NO ACTION, not CASCADE, only by hitting the errors live). This file at least starts
--    tracking `punches` going forward; it does not attempt to retroactively CREATE TABLE for
--    tables that already exist and hold real customer data -- that's needless risk for a
--    documentation goal. The current full column list, for the record, as read live from
--    information_schema on 2026-09-07:
--      id uuid, emp_id uuid, emp_name text, company_id uuid, type text, punch_date date,
--      punch_time text, punched_at timestamptz default now(), site_id uuid, site_name text,
--      is_manual boolean default false, geo_lat/geo_lng/geo_accuracy_m/geo_distance_m double
--      precision, geo_status text.
--
-- 2. A punch has never carried any record of *how* it was made -- only `is_manual` (admin-entered
--    or not) exists. The employee mobile app (Phase 7) is a second insert path alongside the
--    kiosk, and the whole point of one of its requirements is that admins can tell them apart in
--    the Activity log and see a mobile punch's own GPS pin against the site's registered point.
--    `source` is that discriminator. Existing rows and the unchanged kiosk insert path
--    (index.html's executePunch, which never sets this column) both get 'kiosk' for free via the
--    default -- nothing about the kiosk path needs to change.
alter table punches
  add column if not exists source text not null default 'kiosk'
    check (source in ('kiosk', 'mobile', 'admin'));

comment on column punches.source is
  'How this punch was created. kiosk = shared tablet/terminal (default, unchanged path). mobile = employee''s own phone via portal_punch. admin = manually entered/edited by an admin.';

-- A mobile punch is queued offline and synced once the phone regains connectivity, so the
-- client-supplied punch time can legitimately be hours before the request actually reaches the
-- server. `punched_at` stores that real, client-captured moment (see portal_punch) -- this flag
-- just marks that it arrived late, so admins reviewing the Activity log see it was a delayed
-- sync rather than assuming every punch timestamp reflects when the server heard about it.
alter table punches
  add column if not exists synced_late boolean not null default false;

comment on column punches.synced_late is
  'True when a mobile punch''s client-captured time was significantly earlier than when the request reached the server (queued offline, synced later). Never set for kiosk/admin punches.';
