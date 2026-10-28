-- Geofencing, remote clock-in, the employee portal and time-off requests are paid features (Starter and up).
-- Free accounts keep them during the preview (see public.has_paid_features: 14 days after sign-up and in any
-- case until 2026-11-06). The rule is the same one that already governs overtime, evening hours and the
-- automatic reports; the server enforces it in three ways:
--   1. The employee portal checks the company's entitlement on every call (_resolve_portal_session), and its
--      login and invitation-activation refuse with 'portal_plan_locked' (the app shows a clear message).
--      This also covers remote clock-in (portal_punch), time-off requests and everything else in the portal.
--   2. enforce_plan_features (hourly) switches off geofences and the remote clock-in switch of an account that is
--      not entitled, KEEPING what it switched off in *_bak columns, and restores it as soon as the account is
--      entitled again (an upgrade), so nothing a customer configured is lost.
--   3. secure-db refuses admin writes to time_off and employee_portal for a non-entitled company, and the
--      employee_invite email (see the edge function).

alter table public.sites
  add column if not exists geo_lat_bak double precision,
  add column if not exists geo_lng_bak double precision,
  add column if not exists geo_radius_m_bak integer,
  add column if not exists geo_strict_bak boolean;
alter table public.companies add column if not exists remote_punch_bak boolean;

create or replace function public._resolve_portal_session(p_token text) returns uuid
language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare v_emp uuid;
begin
  if p_token is null then return null; end if;
  select employee_id into v_emp from portal_sessions where token = p_token and expires_at > now();
  if v_emp is null then return null; end if;
  -- The employee portal is part of the paid plans: a company that is not entitled has no portal.
  if not coalesce((select public.company_has_paid_features(e.company_id) from employees e where e.id = v_emp), true) then
    return null;
  end if;
  update portal_sessions set last_seen_at = now() where token = p_token;
  return v_emp;
end;
$function$;

create or replace function public.portal_login(p_email text, p_pass text)
returns table(portal_id uuid, employee_id uuid, email text, session_token text)
language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare v_row employee_portal%rowtype; v_session text;
begin
  select ep.* into v_row from employee_portal ep
  where lower(ep.email) = lower(p_email)
    and ep.password_hash is not null
    and ep.status = 'active'
    and crypt(p_pass, ep.password_hash) = ep.password_hash;
  if not found then return; end if;
  -- Only said after the password was right, so it reveals nothing to someone guessing.
  if not coalesce((select public.company_has_paid_features(e.company_id) from employees e where e.id = v_row.employee_id), false) then
    raise exception 'portal_plan_locked';
  end if;
  update employee_portal ep set last_login = now() where ep.id = v_row.id;
  v_session := public._issue_portal_session(v_row.id, v_row.employee_id);
  return query select v_row.id, v_row.employee_id, v_row.email, v_session;
end;
$function$;

create or replace function public.activate_employee_portal(p_token text, p_pass text)
returns table(portal_id uuid, employee_id uuid, email text, session_token text)
language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare v_row employee_portal%rowtype; v_session text;
begin
  select * into v_row from employee_portal
  where invite_token = p_token and invite_token is not null
    and status = 'invited' and (token_expires_at is null or token_expires_at > now());
  if not found then return; end if;
  if not coalesce((select public.company_has_paid_features(e.company_id) from employees e where e.id = v_row.employee_id), false) then
    raise exception 'portal_plan_locked';
  end if;
  if p_pass is null or length(p_pass) < 6 then raise exception 'password_too_short'; end if;
  update employee_portal
  set password_hash = crypt(p_pass, gen_salt('bf')),
      invite_token = null, token_expires_at = null, status = 'active', last_login = now()
  where id = v_row.id;
  v_session := public._issue_portal_session(v_row.id, v_row.employee_id);
  return query select v_row.id, v_row.employee_id, v_row.email, v_session;
end;
$function$;

create or replace function public.enforce_plan_features() returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_ot int; n_lunch int; n_visitor int; n_evening int; n_geo int; n_remote int; n_geo_back int; n_remote_back int;
begin
  update public.companies c set track_overtime = false
   where c.track_overtime and not public.company_has_paid_features(c.id);
  get diagnostics n_ot = row_count;

  update public.companies c set track_lunch_breaks = false
   where c.track_lunch_breaks and public.company_plan_rank(c.id) < 2;
  get diagnostics n_lunch = row_count;

  update public.companies c set visitor_checkin_enabled = false
   where c.visitor_checkin_enabled and public.company_plan_rank(c.id) < 2;
  get diagnostics n_visitor = row_count;

  update public.companies c set evening_start = null, evening_end = null, evening_days = null
   where c.evening_start is not null and not public.company_has_paid_features(c.id);
  get diagnostics n_evening = row_count;

  -- Geofences: keep the location, radius and mode aside, and clear the live ones.
  update public.sites s set
      geo_lat_bak = s.geo_lat, geo_lng_bak = s.geo_lng, geo_radius_m_bak = s.geo_radius_m, geo_strict_bak = s.geo_strict,
      geo_lat = null, geo_lng = null, geo_radius_m = null, geo_strict = false
   where s.geo_lat is not null and not public.company_has_paid_features(s.company_id);
  get diagnostics n_geo = row_count;

  -- Remote clock-in: the company switch goes off (each employee's own grant stays as it is).
  update public.companies c set remote_punch_bak = true, remote_punch_enabled = false
   where c.remote_punch_enabled and not public.company_has_paid_features(c.id);
  get diagnostics n_remote = row_count;

  -- An upgrade (or a grandfathered / re-entitled company) gets its geofences and remote switch back.
  update public.sites s set
      geo_lat = s.geo_lat_bak, geo_lng = s.geo_lng_bak, geo_radius_m = s.geo_radius_m_bak, geo_strict = coalesce(s.geo_strict_bak, false),
      geo_lat_bak = null, geo_lng_bak = null, geo_radius_m_bak = null, geo_strict_bak = null
   where s.geo_lat is null and s.geo_lat_bak is not null and public.company_has_paid_features(s.company_id);
  get diagnostics n_geo_back = row_count;

  update public.companies c set remote_punch_enabled = true, remote_punch_bak = null
   where c.remote_punch_bak and not c.remote_punch_enabled and public.company_has_paid_features(c.id);
  get diagnostics n_remote_back = row_count;

  return jsonb_build_object('overtime_off', n_ot, 'lunch_off', n_lunch, 'visitor_off', n_visitor, 'evening_off', n_evening,
    'geofence_off', n_geo, 'remote_off', n_remote, 'geofence_restored', n_geo_back, 'remote_restored', n_remote_back);
end $$;

revoke all on function public.enforce_plan_features() from public, anon, authenticated;
grant execute on function public.enforce_plan_features() to service_role;

-- hourly instead of daily, so an expired preview and an upgrade both take effect within the hour
select cron.unschedule('enforce-plan-features-daily');
select cron.schedule('enforce-plan-features-hourly', '10 * * * *', 'select public.enforce_plan_features()');
