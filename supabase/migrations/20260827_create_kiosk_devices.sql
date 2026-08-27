-- Kiosk terminals, so an owner can SEE that the tablet they just set up is connected.
--
-- Registration used to live only in the tablet's localStorage, which meant clearing browser
-- data silently un-kiosked a terminal and left no trace anywhere the owner could look. The
-- setup wizard polls this table to confirm the tablet came online while the owner is still
-- holding it, and the Sites page lists (and can revoke) the terminals for each site.

create table if not exists kiosk_devices (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  site_id     uuid not null references sites(id)     on delete cascade,
  device_id   text not null,
  label       text,
  user_agent  text,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  revoked     boolean not null default false
);

-- One row per tablet per site; the check-in RPC upserts on this.
create unique index if not exists kiosk_devices_site_device_uniq on kiosk_devices (site_id, device_id);
create index if not exists kiosk_devices_site_idx on kiosk_devices (site_id, revoked, last_seen desc);

-- Project convention: RLS on with zero policies. Nothing reaches this table except through
-- secure-db (service role, tenant-scoped) or the SECURITY DEFINER check-in below.
alter table kiosk_devices enable row level security;

-- The tablet is unauthenticated when it opens the kiosk link — the site id in the URL is the
-- only credential it has — so check-in must be callable by anon. It is deliberately narrow:
-- it writes one row for one site and returns nothing.
create or replace function kiosk_device_checkin(p_site_id uuid, p_device_id text, p_user_agent text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  -- Unknown site: do nothing rather than error, so a stale bookmark can't be used to probe
  -- which site ids exist.
  select company_id into v_company from sites where id = p_site_id;
  if v_company is null then return; end if;
  if p_device_id is null or length(p_device_id) < 8 or length(p_device_id) > 64 then return; end if;

  insert into kiosk_devices (company_id, site_id, device_id, user_agent)
  values (v_company, p_site_id, p_device_id, left(coalesce(p_user_agent,''), 200))
  on conflict (site_id, device_id) do update
    set last_seen  = now(),
        user_agent = excluded.user_agent;
end;
$$;

grant execute on function kiosk_device_checkin(uuid, text, text) to anon, authenticated, service_role;
