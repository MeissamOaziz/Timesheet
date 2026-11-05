-- Admin mobile app (PunchClock Crew Admin), backend step: push tokens for owners, co-admins and managers.
--
-- Mirror of the employee design (employee_push_tokens + portal_register_push_token), with the same rules:
--  * The table is closed: RLS on, no policies, service_role only. Nothing in a browser or app reads it; only the
--    send-push edge function (service key) does.
--  * The app calls the two RPCs below with the PUBLIC key and authenticates with its admin SESSION TOKEN
--    (admin_sessions.token, the one mint_admin_session returns). The admin id comes ONLY from that token, never
--    from an argument.
--  * A token identifies one physical device: whoever registered it last owns it (on a shared phone the previous
--    admin stops receiving this device's pushes).
--  * At most 10 devices per admin; the oldest are dropped.
--  * An admin who is not active (suspended, pending invite) or whose account has expired cannot register, and the
--    senders (notify-time-off, notify-missed-punch, punch-alerts) only ever select active admins.
--
-- Nothing here is applied automatically. Order: this migration first, then send-push, then the three callers
-- (see docs/admin-push-notes.md).

-- ---- 1. table ----
create table if not exists public.admin_push_tokens (
  token        text primary key,
  admin_id     uuid not null references public.admins(id) on delete cascade,
  platform     text,
  device_label text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint admin_push_tokens_platform_check check (platform is null or platform in ('ios', 'android'))
);

create index if not exists admin_push_tokens_admin_id_idx on public.admin_push_tokens (admin_id);

comment on table public.admin_push_tokens is
  'Expo push tokens of admin phones (owners, co-admins, managers). Written only by admin_register_push_token, read only by send-push (service key). Private: no RLS policies, no browser-role grants.';

alter table public.admin_push_tokens enable row level security;

revoke all on public.admin_push_tokens from public, anon, authenticated;
grant select, insert, update, delete on public.admin_push_tokens to service_role;

-- ---- 2. session resolver (server-side only) ----
-- Returns the admin id behind an unexpired admin session whose admin is active and not expired, else NULL.
-- NULL, empty and malformed tokens are refused explicitly. Does not touch the session row.
create or replace function public._resolve_admin_push_session(p_session text)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_admin uuid;
begin
  if p_session is null or btrim(p_session) = '' or p_session !~ '^[A-Za-z0-9_-]{16,128}$' then
    return null;
  end if;
  select s.admin_id into v_admin
    from admin_sessions s
    join admins a on a.id = s.admin_id
   where s.token = p_session
     and s.expires_at > now()
     and a.status = 'active'
     and (a.expires_at is null or a.expires_at > now());
  return v_admin;
end;
$function$;

-- ---- 3. register ----
drop function if exists public.admin_register_push_token(text, text, text, text);
create function public.admin_register_push_token(p_session text, p_token text, p_platform text, p_label text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_admin uuid;
  v_label text;
begin
  v_admin := public._resolve_admin_push_session(p_session);
  if v_admin is null then
    return false;
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    return false;
  end if;
  -- Expo push token shape only; nothing else is ever stored or later sent to Expo.
  if p_token is null or length(p_token) > 120 or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,80}\]$' then
    return false;
  end if;
  -- Display label only: no control characters or angle brackets, trimmed, at most 60 characters.
  v_label := nullif(btrim(left(btrim(regexp_replace(coalesce(p_label, ''), '[[:cntrl:]<>]', '', 'g')), 60)), '');

  -- One registration at a time per admin so the cap below cannot be raced past.
  perform pg_advisory_xact_lock(hashtextextended('admin_push_tokens:' || v_admin::text, 0));

  -- Last signer owns the token: drop it from any other admin first.
  delete from admin_push_tokens t where t.token = p_token and t.admin_id <> v_admin;

  -- clock_timestamp (not now) so rows registered in one transaction still order correctly.
  insert into admin_push_tokens (token, admin_id, platform, device_label, created_at, last_seen_at)
  values (p_token, v_admin, p_platform, v_label, clock_timestamp(), clock_timestamp())
  on conflict (token) do update
    set admin_id = excluded.admin_id,   -- covers a concurrent takeover that slipped in after the delete
        platform = excluded.platform,
        device_label = excluded.device_label,
        last_seen_at = clock_timestamp();

  -- Cap: keep this admin's 10 most recently seen devices.
  delete from admin_push_tokens t
   where t.token in (
     select x.token from admin_push_tokens x
      where x.admin_id = v_admin
      order by x.last_seen_at desc, x.created_at desc, x.token
      offset 10
   );

  return true;
end;
$function$;

-- ---- 4. unregister ----
drop function if exists public.admin_unregister_push_token(text, text);
create function public.admin_unregister_push_token(p_session text, p_token text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_admin uuid;
  v_n integer;
begin
  v_admin := public._resolve_admin_push_session(p_session);
  if v_admin is null or p_token is null or btrim(p_token) = '' or length(p_token) > 120 then
    return false;
  end if;
  -- Only this admin's own row; another admin's registration of the same token is untouched.
  delete from admin_push_tokens t where t.token = p_token and t.admin_id = v_admin;
  get diagnostics v_n = row_count;
  return v_n >= 1;
end;
$function$;

-- ---- 5. grants ----
-- The two RPCs are called by the app with the public key and check the session token in code, so anon may
-- execute them (and they are on tools/secure-db-regression/anon-function-allowlist.txt). The resolver is not.
revoke all on function public._resolve_admin_push_session(text) from public, anon, authenticated;
revoke all on function public.admin_register_push_token(text, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_unregister_push_token(text, text) from public, anon, authenticated;

grant execute on function public._resolve_admin_push_session(text) to service_role;
grant execute on function public.admin_register_push_token(text, text, text, text) to anon, service_role;
grant execute on function public.admin_unregister_push_token(text, text) to anon, service_role;

notify pgrst, 'reload schema';
