-- Work labels (jobs) on the employee portal's clock-in, as the kiosk already offers them.
-- Requested by Lumi Conseil: technicians move between client jobs and labelling afterwards in
-- Activity is extra work.
--
-- NOT APPLIED. Written on branch agent/portal-job-picker for review. Before applying, confirm the
-- deployed portal_punch is in the 48h state (see 20261015_portal_punch_late_sync_window_48h.sql):
--   select pg_get_functiondef('public.portal_punch(text,text,uuid,date,text,timestamptz,double precision,double precision,double precision)'::regprocedure);
-- The body below is the 72h body with the 48h interval, plus the label handling. Nothing else changes.
--
-- Same rules as the kiosk (see kioskLabelContext in secure-db):
--   * labels exist only while the company's owner has the Scheduling add-on or its free trial
--     (admins.scheduling_addon, or scheduling_trial_ends_at in the future);
--   * the company setting punch_label_mode decides: off (no picker), optional, required;
--   * a label is recorded on the IN only; an OUT never carries one;
--   * the label must be one of the company's own active labels, otherwise the punch is refused.
--
-- 1) What the portal may know: its own company's active labels, with the mode. An empty result means
--    "do not show a picker" (feature off, add-on inactive, no labels, or an invalid session).
create or replace function public.portal_get_punch_labels(p_session text)
returns table(mode text, id uuid, name text, color text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_company_id uuid;
  v_mode text;
  v_addon boolean;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;

  select e.company_id into v_company_id from employees e where e.id = v_emp;
  if v_company_id is null then return; end if;

  select c.punch_label_mode,
         coalesce(a.scheduling_addon or coalesce(a.scheduling_trial_ends_at > now(), false), false)
    into v_mode, v_addon
    from companies c left join admins a on a.id = c.admin_id
   where c.id = v_company_id;

  if coalesce(v_mode, 'off') = 'off' or not coalesce(v_addon, false) then return; end if;

  return query
  select v_mode, l.id, l.name, l.color
    from work_labels l
   where l.company_id = v_company_id and l.active
   order by l.sort_order asc, l.name asc;
end;
$function$;

revoke all on function public.portal_get_punch_labels(text) from public;
grant execute on function public.portal_get_punch_labels(text) to anon, authenticated, service_role;

-- 2) portal_punch gains p_label_id (last, default null). The signature changes, so the old one is
--    dropped in the same transaction; a cached older portal page that sends nine arguments still
--    resolves to this function with p_label_id null.
drop function if exists public.portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision);

create function public.portal_punch(
  p_session text, p_type text, p_site_id uuid, p_punch_date date, p_punch_time text,
  p_client_time timestamptz default null, p_lat double precision default null,
  p_lng double precision default null, p_accuracy_m double precision default null,
  p_label_id uuid default null
)
returns table(ok boolean, error_code text, punch_id uuid, distance_m double precision, synced_late boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_company_id uuid;
  v_emp_name text;
  v_emp_remote_ok boolean;
  v_remote_enabled boolean;
  v_site_id uuid;
  v_site_name text;
  v_geo_lat double precision;
  v_geo_lng double precision;
  v_geo_radius_m integer;
  v_geo_strict boolean;
  v_distance double precision := null;
  v_geo_status text;
  v_last_type text;
  v_punched_at timestamptz;
  v_synced_late boolean := false;
  v_new_id uuid;
  v_label_mode text;
  v_label_addon boolean;
  v_label_id uuid := null;
begin
  v_emp := _resolve_portal_session(p_session);
  if v_emp is null then
    return query select false, 'unauthorized'::text, null::uuid, null::double precision, false; return;
  end if;

  if p_type not in ('IN', 'OUT') then
    return query select false, 'bad_type'::text, null::uuid, null::double precision, false; return;
  end if;

  select e.company_id, e.name, e.remote_punch_enabled into v_company_id, v_emp_name, v_emp_remote_ok
    from employees e where e.id = v_emp;
  if v_company_id is null then
    return query select false, 'unauthorized'::text, null::uuid, null::double precision, false; return;
  end if;

  select c.remote_punch_enabled into v_remote_enabled from companies c where c.id = v_company_id;
  if not coalesce(v_remote_enabled, false) then
    return query select false, 'remote_punch_disabled'::text, null::uuid, null::double precision, false; return;
  end if;

  if not coalesce(v_emp_remote_ok, false) then
    return query select false, 'employee_not_authorized'::text, null::uuid, null::double precision, false; return;
  end if;

  select s.id, s.name, s.geo_lat, s.geo_lng, s.geo_radius_m, s.geo_strict
    into v_site_id, v_site_name, v_geo_lat, v_geo_lng, v_geo_radius_m, v_geo_strict
    from sites s
    where s.id = p_site_id and s.company_id = v_company_id;
  if v_site_id is null then
    return query select false, 'invalid_site'::text, null::uuid, null::double precision, false; return;
  end if;

  if coalesce(v_geo_strict, false) and (p_lat is null or p_lng is null) then
    return query select false, 'location_required'::text, null::uuid, null::double precision, false; return;
  end if;

  if v_geo_lat is not null and v_geo_lng is not null and p_lat is not null and p_lng is not null then
    v_distance := 6371000 * acos(
      least(1.0, greatest(-1.0,
        cos(radians(v_geo_lat)) * cos(radians(p_lat)) * cos(radians(p_lng) - radians(v_geo_lng))
        + sin(radians(v_geo_lat)) * sin(radians(p_lat))
      ))
    );
    v_geo_status := 'ok';
  elsif p_lat is not null and p_lng is not null then
    v_geo_status := 'ok';
  else
    v_geo_status := 'skipped';
  end if;

  if coalesce(v_geo_strict, false) and v_distance is not null and v_geo_radius_m is not null
     and v_distance > v_geo_radius_m then
    return query select false, 'too_far'::text, null::uuid, v_distance, false; return;
  end if;

  select p.type into v_last_type
    from punches p where p.emp_id = v_emp order by p.punched_at desc limit 1;

  if p_type = 'IN' and v_last_type = 'IN' then
    return query select false, 'already_in'::text, null::uuid, v_distance, false; return;
  end if;
  if p_type = 'OUT' and (v_last_type is null or v_last_type = 'OUT') then
    return query select false, 'not_in'::text, null::uuid, v_distance, false; return;
  end if;

  -- Work label: only ever on an IN, and only while the company uses labels at clock-in.
  if p_type = 'IN' then
    select c.punch_label_mode,
           coalesce(a.scheduling_addon or coalesce(a.scheduling_trial_ends_at > now(), false), false)
      into v_label_mode, v_label_addon
      from companies c left join admins a on a.id = c.admin_id
     where c.id = v_company_id;

    if p_label_id is not null then
      if coalesce(v_label_mode, 'off') = 'off' or not coalesce(v_label_addon, false) then
        return query select false, 'invalid_label'::text, null::uuid, v_distance, false; return;
      end if;
      select l.id into v_label_id
        from work_labels l
       where l.id = p_label_id and l.company_id = v_company_id and l.active;
      if v_label_id is null then
        return query select false, 'invalid_label'::text, null::uuid, v_distance, false; return;
      end if;
    elsif coalesce(v_label_mode, 'off') = 'required' and coalesce(v_label_addon, false)
          and exists (select 1 from work_labels l where l.company_id = v_company_id and l.active) then
      return query select false, 'label_required'::text, null::uuid, v_distance, false; return;
    end if;
  end if;

  if p_client_time is not null
     and p_client_time <= now() + interval '5 minutes'
     and p_client_time >= now() - interval '48 hours' then
    v_punched_at := p_client_time;
    v_synced_late := (now() - p_client_time) > interval '2 minutes';
  else
    v_punched_at := now();
    v_synced_late := (p_client_time is not null);
  end if;

  insert into punches (
    emp_id, emp_name, company_id, type, punch_date, punch_time, punched_at,
    site_id, site_name, is_manual, source, synced_late,
    geo_lat, geo_lng, geo_accuracy_m, geo_distance_m, geo_status, label_id
  ) values (
    v_emp, v_emp_name, v_company_id, p_type, p_punch_date, p_punch_time, v_punched_at,
    v_site_id, v_site_name, false, 'mobile', v_synced_late,
    p_lat, p_lng, p_accuracy_m, v_distance, v_geo_status, v_label_id
  ) returning id into v_new_id;

  return query select true, null::text, v_new_id, v_distance, v_synced_late;
end;
$function$;

revoke all on function public.portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision, uuid) from public;
grant execute on function public.portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision, uuid) to anon, authenticated, service_role;
