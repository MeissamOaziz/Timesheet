-- Employee mobile app, backend step 2: sessions, push tokens, deactivated employees, minimum app version.
--
--  1. portal_sessions gets a public id plus device_label / platform / app_version. The app names its device after
--     login (portal_set_session_device); the employee can list their own devices and sign one out. The token itself
--     is never returned.
--  2. A deactivated employee (employees.active = false) or a deleted one no longer resolves to a session, so the
--     phone stops working at once. Before this a valid session kept working after deactivation (changing or
--     resetting the password already revoked sessions; that is unchanged).
--  3. Push tokens: on a shared phone the last person to sign in now owns the token (before, the previous owner kept
--     it and the new person's registration silently failed, so one employee's notifications landed on the other's
--     login). portal_unregister_push_token removes it on sign-out.
--  4. portal_app_config(): returns whether the installed app is below the minimum version, so a bad release can be
--     retired. The minimum lives in internal_secrets (key min_employee_app_version, default 0.0.0 = nobody blocked).
--  5. portal_get_sites now also returns geo_strict, so the app can explain a strict site before the employee taps.
--  6. Grants: the functions below are called by the app with the public key and authenticate with the session token.

-- ---- 1. sessions ----
alter table public.portal_sessions
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists device_label text,
  add column if not exists platform text,
  add column if not exists app_version text;

create unique index if not exists portal_sessions_id_uidx on public.portal_sessions (id);

drop function if exists public.portal_set_session_device(text, text, text, text);
create function public.portal_set_session_device(p_session text, p_label text, p_platform text, p_app_version text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_n integer;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return false;
  end if;
  update portal_sessions s
     set device_label = nullif(btrim(regexp_replace(left(coalesce(p_label, ''), 60), '[[:cntrl:]]', '', 'g')), ''),
         platform = case when p_platform in ('ios', 'android', 'web') then p_platform else null end,
         app_version = nullif(regexp_replace(left(coalesce(p_app_version, ''), 20), '[^0-9A-Za-z.\-]', '', 'g'), '')
   where s.token = p_session and s.employee_id = v_emp;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$function$;

drop function if exists public.portal_list_sessions(text);
create function public.portal_list_sessions(p_session text)
returns table(session_id uuid, device_label text, platform text, app_version text,
              created_at timestamptz, last_seen_at timestamptz, is_current boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return;
  end if;
  return query
    select s.id, s.device_label, s.platform, s.app_version, s.created_at, s.last_seen_at, (s.token = p_session)
      from portal_sessions s
     where s.employee_id = v_emp and s.expires_at > now()
     order by s.last_seen_at desc nulls last, s.created_at desc;
end;
$function$;

drop function if exists public.portal_revoke_session(text, uuid);
create function public.portal_revoke_session(p_session text, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_n integer;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null or p_session_id is null then
    return false;
  end if;
  -- Only the caller's own other devices; signing out of this one is portal_logout.
  delete from portal_sessions s
   where s.id = p_session_id and s.employee_id = v_emp and s.token <> p_session;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$function$;

-- ---- 2. deactivated or deleted employees lose their session ----
create or replace function public._resolve_portal_session(p_token text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_emp uuid;
begin
  if p_token is null then return null; end if;
  select employee_id into v_emp from portal_sessions where token = p_token and expires_at > now();
  if v_emp is null then return null; end if;
  if not exists (select 1 from employees e where e.id = v_emp and coalesce(e.active, true)) then
    return null;
  end if;
  if not coalesce((select public.company_has_paid_features(e.company_id) from employees e where e.id = v_emp), true) then
    return null;
  end if;
  update portal_sessions set last_seen_at = now() where token = p_token;
  return v_emp;
end;
$function$;

-- ---- 3. push tokens ----
create or replace function public.portal_register_push_token(p_session text, p_token text, p_platform text)
returns table(ok boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return query select false; return;
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    return query select false; return;
  end if;
  if p_token is null or length(p_token) < 10 or length(p_token) > 300 then
    return query select false; return;
  end if;

  -- The token identifies one physical device. Whoever is signed in on it now owns it.
  insert into employee_push_tokens (token, employee_id, platform, last_seen_at)
  values (p_token, v_emp, p_platform, now())
  on conflict (token) do update
    set employee_id = excluded.employee_id,
        platform = excluded.platform,
        last_seen_at = now();
  return query select true;
end;
$function$;

drop function if exists public.portal_unregister_push_token(text, text);
create function public.portal_unregister_push_token(p_session text, p_token text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_n integer;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null or p_token is null then
    return false;
  end if;
  delete from employee_push_tokens t where t.token = p_token and t.employee_id = v_emp;
  get diagnostics v_n = row_count;
  return v_n >= 1;
end;
$function$;

-- ---- 4. minimum app version ----
insert into public.internal_secrets (key, value) values ('min_employee_app_version', '0.0.0')
on conflict (key) do nothing;

create or replace function public._app_version_lt(p_a text, p_b text)
returns boolean
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_a text := regexp_replace(coalesce(p_a, ''), '[^0-9.]', '', 'g');
  v_b text := regexp_replace(coalesce(p_b, ''), '[^0-9.]', '', 'g');
begin
  -- A missing or malformed version must never lock someone out.
  if v_a !~ '^[0-9]+(\.[0-9]+)*$' or v_b !~ '^[0-9]+(\.[0-9]+)*$' then
    return false;
  end if;
  return string_to_array(v_a, '.')::int[] < string_to_array(v_b, '.')::int[];
exception when others then
  return false;
end;
$function$;

drop function if exists public.portal_app_config(text, text);
create function public.portal_app_config(p_platform text, p_version text)
returns table(min_version text, update_required boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_min text;
begin
  select s.value into v_min from internal_secrets s where s.key = 'min_employee_app_version';
  v_min := coalesce(nullif(v_min, ''), '0.0.0');
  return query select v_min, public._app_version_lt(left(p_version, 20), v_min);
end;
$function$;

-- ---- 5. sites with geo_strict ----
drop function if exists public.portal_get_sites(text);
create function public.portal_get_sites(p_session text)
returns table(id uuid, name text, geo_lat double precision, geo_lng double precision, geo_radius_m integer, geo_strict boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_company_id uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;

  select e.company_id into v_company_id from employees e where e.id = v_emp;
  if v_company_id is null then return; end if;

  return query
  select s.id, s.name, s.geo_lat, s.geo_lng, s.geo_radius_m, coalesce(s.geo_strict, false)
  from sites s
  where s.company_id = v_company_id
  order by s.name;
end;
$function$;

-- ---- 6. grants ----
revoke all on function public.portal_set_session_device(text, text, text, text) from public, anon, authenticated;
revoke all on function public.portal_list_sessions(text) from public, anon, authenticated;
revoke all on function public.portal_revoke_session(text, uuid) from public, anon, authenticated;
revoke all on function public.portal_register_push_token(text, text, text) from public, anon, authenticated;
revoke all on function public.portal_unregister_push_token(text, text) from public, anon, authenticated;
revoke all on function public.portal_app_config(text, text) from public, anon, authenticated;
revoke all on function public.portal_get_sites(text) from public, anon, authenticated;
revoke all on function public._app_version_lt(text, text) from public, anon, authenticated;

grant execute on function public.portal_set_session_device(text, text, text, text) to anon, service_role;
grant execute on function public.portal_list_sessions(text) to anon, service_role;
grant execute on function public.portal_revoke_session(text, uuid) to anon, service_role;
grant execute on function public.portal_register_push_token(text, text, text) to anon, service_role;
grant execute on function public.portal_unregister_push_token(text, text) to anon, service_role;
grant execute on function public.portal_app_config(text, text) to anon, service_role;
grant execute on function public.portal_get_sites(text) to anon, service_role;
grant execute on function public._app_version_lt(text, text) to service_role;

notify pgrst, 'reload schema';
