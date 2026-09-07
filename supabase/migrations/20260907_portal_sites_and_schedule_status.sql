-- portal_get_sites: the employee's company's sites, for the app's nearest-site auto-suggest and
-- for registering native OS geofence regions (the "forgot to punch in" reminder). Mirrors
-- portal_get_shifts's shape exactly -- session in, no employee_id ever accepted.
create or replace function portal_get_sites(p_session text)
returns table(id uuid, name text, geo_lat double precision, geo_lng double precision, geo_radius_m integer)
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
  select s.id, s.name, s.geo_lat, s.geo_lng, s.geo_radius_m
  from sites s
  where s.company_id = v_company_id
  order by s.name;
end;
$function$;

grant execute on function portal_get_sites(text) to anon, authenticated, service_role;

-- portal_get_schedule_status: whether the employee's company has the scheduling add-on active.
-- Lets the app tell "no shifts this period" apart from "your company hasn't added scheduling" --
-- today employee.html's renderSchedule() (977-1010) treats both as one empty state. companies.
-- admin_id is always the tenant OWNER (co-admins/managers never own a company row directly), so
-- one join is enough -- no parent_admin_id chase needed, matching how the admin side itself reads
-- scheduling_addon off C.primaryAdmin rather than the logged-in admin's own row.
create or replace function portal_get_schedule_status(p_session text)
returns table(scheduling_addon boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_company_id uuid;
  v_addon boolean;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;

  select e.company_id into v_company_id from employees e where e.id = v_emp;
  if v_company_id is null then return; end if;

  select a.scheduling_addon into v_addon
  from companies c join admins a on a.id = c.admin_id
  where c.id = v_company_id;

  return query select coalesce(v_addon, false);
end;
$function$;

grant execute on function portal_get_schedule_status(text) to anon, authenticated, service_role;
