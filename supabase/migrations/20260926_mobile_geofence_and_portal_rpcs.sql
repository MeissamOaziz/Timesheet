-- Mobile app backend readiness: close the one real gap in an otherwise-already-built layer.
--
-- portal_get_sites and portal_get_schedule_status already existed (built in an earlier session,
-- undocumented in a migration file until now -- recorded here for the record, unchanged).
-- portal_punch already computed distance-to-site and recorded it (geo_distance_m/geo_status) but
-- never rejected a punch for being too far -- that enforcement was intentionally removed for the
-- web portal's "remote clock-in" feature (trusted, off-site by design). A phone-based app for
-- field workers needs the opposite: hard proximity enforcement. Both cases share this one RPC,
-- differentiated by the site's own geo_strict flag (already used for the kiosk's strict mode) --
-- geo_strict stays false (today's behaviour, unchanged) for existing remote-punch sites, and a
-- future mobile-app site opts into enforcement by turning it on. No new column needed.
create or replace function portal_punch(
  p_session text, p_type text, p_site_id uuid, p_punch_date date, p_punch_time text,
  p_client_time timestamptz default null, p_lat double precision default null,
  p_lng double precision default null, p_accuracy_m double precision default null
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

  -- Strict sites require a location fix before anything else -- no distance can be judged
  -- without one, and silently letting the punch through would defeat the setting entirely.
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

  if p_client_time is not null
     and p_client_time <= now() + interval '5 minutes'
     and p_client_time >= now() - interval '16 hours' then
    v_punched_at := p_client_time;
    v_synced_late := (now() - p_client_time) > interval '2 minutes';
  else
    v_punched_at := now();
    v_synced_late := (p_client_time is not null);
  end if;

  insert into punches (
    emp_id, emp_name, company_id, type, punch_date, punch_time, punched_at,
    site_id, site_name, is_manual, source, synced_late,
    geo_lat, geo_lng, geo_accuracy_m, geo_distance_m, geo_status
  ) values (
    v_emp, v_emp_name, v_company_id, p_type, p_punch_date, p_punch_time, v_punched_at,
    v_site_id, v_site_name, false, 'mobile', v_synced_late,
    p_lat, p_lng, p_accuracy_m, v_distance, v_geo_status
  ) returning id into v_new_id;

  return query select true, null::text, v_new_id, v_distance, v_synced_late;
end;
$function$;

grant execute on function portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision) to anon, authenticated, service_role;
