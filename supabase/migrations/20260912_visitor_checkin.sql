-- Visitor check-in, requested by a real prospect (Julia Natarelli/Ursola, 2026-09-11 sales call)
-- alongside lunch/break tracking: an emergency-preparedness "who's in the building" view that
-- needs to include visitors, not just staff. One mutable row per visit (not an append-only
-- IN/OUT log like punches) because "who's currently here" is then a single
-- checked_out_at is null query instead of pairing rows every time.
create table visitors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  site_id uuid references sites(id) on delete cascade,
  full_name text not null,
  company_name text,
  phone text,
  email text,
  checked_in_at timestamptz not null default now(),
  checked_out_at timestamptz
);

create index visitors_site_open_idx on visitors(site_id) where checked_out_at is null;

-- Same blanket lockdown already used on every other tenant table (punches, employees, sites,
-- companies): RLS enabled with zero policies means anon/authenticated get nothing via the
-- public anon key, and only the service role (used inside secure-db, which does the real
-- tenant/kiosk scoping) can reach this table at all.
alter table visitors enable row level security;
