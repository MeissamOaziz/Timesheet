-- Arrival and departure reminders in the employee phone app (Growth and up).
--
-- The phone notices the workplace zone and asks "Clock in?" / "Clock out?"; the employee taps and the punch goes
-- through portal_punch as before. Nothing about the phone's whereabouts reaches the server until that tap.
--
-- Three switches, all off by default:
--   companies.arrival_prompts_enabled  the owner turns the feature on for the company (Growth and up)
--   employees.arrival_prompts_enabled  an admin turns it on employee by employee (mixed crews: some on site, some on the road)
--   the employee's own opt-in, kept on the phone
-- The prompt only makes sense for someone who may clock in from the phone, so phone clock-in must be on too
-- (companies.remote_punch_enabled and employees.remote_punch_enabled).
--
-- portal_arrival_status is the one thing the app asks, on opening and right before it shows a prompt:
-- "may I prompt this person, and are they clocked in?". The plan is checked live, so a downgrade stops prompts at once.

alter table public.companies add column if not exists arrival_prompts_enabled boolean not null default false;
alter table public.employees add column if not exists arrival_prompts_enabled boolean not null default false;

create or replace function public.portal_arrival_status(p_session text)
returns table(allowed boolean, last_type text, last_punched_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_allowed boolean;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;

  select (c.arrival_prompts_enabled and e.arrival_prompts_enabled
          and coalesce(c.remote_punch_enabled, false) and coalesce(e.remote_punch_enabled, false)
          and public.company_plan_rank(c.id) >= 2)
    into v_allowed
  from employees e join companies c on c.id = e.company_id
  where e.id = v_emp;

  return query
  select coalesce(v_allowed, false), p.type, p.punched_at
  from (select 1) one
  left join lateral (
    select x.type, x.punched_at from punches x
    where x.emp_id = v_emp
    order by x.punched_at desc
    limit 1
  ) p on true;
end;
$function$;

revoke all on function public.portal_arrival_status(text) from public, anon, authenticated;
-- The employee app calls it with the public key and a portal session token (allowlisted on purpose).
grant execute on function public.portal_arrival_status(text) to anon;

-- Same rule as lunch breaks and visitor check-in: below Growth the company switch goes off.
create or replace function public.enforce_plan_features()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n_ot int; n_lunch int; n_visitor int; n_evening int; n_geo int; n_remote int; n_geo_back int; n_remote_back int; n_arrival int;
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

  update public.companies c set arrival_prompts_enabled = false
   where c.arrival_prompts_enabled and public.company_plan_rank(c.id) < 2;
  get diagnostics n_arrival = row_count;

  update public.companies c set evening_start = null, evening_end = null, evening_days = null
   where c.evening_start is not null and not public.company_has_paid_features(c.id);
  get diagnostics n_evening = row_count;

  update public.sites s set
      geo_lat_bak = s.geo_lat, geo_lng_bak = s.geo_lng, geo_radius_m_bak = s.geo_radius_m, geo_strict_bak = s.geo_strict,
      geo_lat = null, geo_lng = null, geo_radius_m = null, geo_strict = false
   where s.geo_lat is not null and not public.company_has_paid_features(s.company_id);
  get diagnostics n_geo = row_count;

  update public.companies c set remote_punch_bak = true, remote_punch_enabled = false
   where c.remote_punch_enabled and not public.company_has_paid_features(c.id);
  get diagnostics n_remote = row_count;

  update public.sites s set
      geo_lat = s.geo_lat_bak, geo_lng = s.geo_lng_bak, geo_radius_m = s.geo_radius_m_bak, geo_strict = coalesce(s.geo_strict_bak, false),
      geo_lat_bak = null, geo_lng_bak = null, geo_radius_m_bak = null, geo_strict_bak = null
   where s.geo_lat is null and s.geo_lat_bak is not null and public.company_has_paid_features(s.company_id);
  get diagnostics n_geo_back = row_count;

  update public.companies c set remote_punch_enabled = true, remote_punch_bak = null
   where c.remote_punch_bak and not c.remote_punch_enabled and public.company_has_paid_features(c.id);
  get diagnostics n_remote_back = row_count;

  return jsonb_build_object('overtime_off', n_ot, 'lunch_off', n_lunch, 'visitor_off', n_visitor, 'arrival_off', n_arrival,
    'evening_off', n_evening, 'geofence_off', n_geo, 'remote_off', n_remote, 'geofence_restored', n_geo_back, 'remote_restored', n_remote_back);
end $function$;
