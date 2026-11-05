-- Employee mobile app, backend step 3: duplicate guard on late sync, and a justification note for punches made
-- without location.
--
-- A. Duplicate guard. When an offline punch syncs late, the manager may already have entered the same punch by hand
--    ("it did not work"). portal_punch now looks at the punches around the punch's moment (not just the latest one):
--      * same type within 10 minutes of an existing punch (any source), with no opposite punch in between
--            -> not stored, answer already_recorded (+ the existing punch's time and source);
--      * IN while the previous punch is an IN / OUT while the previous is an OUT or none -> already_in / not_in (as before);
--      * a late IN whose NEXT punch is an IN, or a late OUT whose next is an OUT -> sequence_conflict, not stored
--        (it would double-count hours; the employee shows it to the manager);
--    Live punches keep exactly the old behaviour (latest punch decides, same error codes). The admin "Add punch" form
--    already refuses an IN right after an IN, so a manual entry made AFTER the app punch synced is covered there.
--    Existing punches are compared by both their punched_at and their local date/time strings, because manual and
--    kiosk rows carry a client-computed punched_at.
-- B. Location note. punches.geo_note (max 300 characters) justifies a punch made without location. It is only kept
--    when the punch has no location AND the site has geolocation set up (coordinates present); otherwise it is dropped.
--    A punch without location at such a site is now flagged no_location even when the site is not strict (it is still
--    never refused unless the site is strict and the punch is live, as before). portal_set_punch_note lets the employee
--    add or change the note afterwards on their own flagged punch for 14 days.
-- C. portal_get_punches also returns source, review_flags, geo_note and time_verified so the app can show state.
-- Display of the note anywhere must escape it (it is free text written by an employee).

alter table public.punches
  add column if not exists geo_note text;
alter table public.punches
  drop constraint if exists punches_geo_note_len;
alter table public.punches
  add constraint punches_geo_note_len check (geo_note is null or char_length(geo_note) <= 300);

drop function if exists public.portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision, uuid, uuid, bigint, text, bigint, text);

create function public.portal_punch(
  p_session text,
  p_type text,
  p_site_id uuid,
  p_punch_date date,
  p_punch_time text,
  p_client_time timestamptz default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_accuracy_m double precision default null,
  p_label_id uuid default null,
  p_client_op_id uuid default null,
  p_anchor_ms bigint default null,
  p_anchor_sig text default null,
  p_anchor_elapsed_ms bigint default null,
  p_geo_reason text default null,
  p_geo_note text default null
)
returns table(ok boolean, error_code text, punch_id uuid, distance_m double precision,
              synced_late boolean, flags text[], duplicate boolean,
              existing_at timestamptz, existing_source text)
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
  v_geo_set_up boolean;
  v_lat double precision := p_lat;
  v_lng double precision := p_lng;
  v_acc double precision;
  v_reason text;
  v_note text;
  v_distance double precision := null;
  v_geo_status text;
  v_punched_at timestamptz;
  v_synced_late boolean := false;
  v_new_id uuid;
  v_label_mode text;
  v_label_addon boolean;
  v_label_id uuid := null;
  v_flags text[] := '{}';
  v_verified boolean := true;
  v_skew integer := null;
  v_expected timestamptz;
  v_tz text;
  v_local timestamp;
  v_date date;
  v_time text;
  v_claimed timestamp;
  v_old record;
  v_prev record;
  v_next record;
  v_dup record;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return query select false, 'unauthorized'::text, null::uuid, null::double precision, false, null::text[], false, null::timestamptz, null::text; return;
  end if;

  -- Retry of a punch the server already stored: answer with the first result, insert nothing.
  if p_client_op_id is not null then
    select p.id, p.geo_distance_m, p.synced_late, p.review_flags into v_old
      from punches p where p.emp_id = v_emp and p.client_op_id = p_client_op_id;
    if found then
      return query select true, null::text, v_old.id, v_old.geo_distance_m, v_old.synced_late, v_old.review_flags, true, null::timestamptz, null::text; return;
    end if;
  end if;

  if p_type not in ('IN', 'OUT') then
    return query select false, 'bad_type'::text, null::uuid, null::double precision, false, null::text[], false, null::timestamptz, null::text; return;
  end if;

  select e.company_id, e.name, e.remote_punch_enabled into v_company_id, v_emp_name, v_emp_remote_ok
    from employees e where e.id = v_emp;
  if v_company_id is null then
    return query select false, 'unauthorized'::text, null::uuid, null::double precision, false, null::text[], false, null::timestamptz, null::text; return;
  end if;

  select c.remote_punch_enabled into v_remote_enabled from companies c where c.id = v_company_id;
  if not coalesce(v_remote_enabled, false) then
    return query select false, 'remote_punch_disabled'::text, null::uuid, null::double precision, false, null::text[], false, null::timestamptz, null::text; return;
  end if;

  if not coalesce(v_emp_remote_ok, false) then
    return query select false, 'employee_not_authorized'::text, null::uuid, null::double precision, false, null::text[], false, null::timestamptz, null::text; return;
  end if;

  select s.id, s.name, s.geo_lat, s.geo_lng, s.geo_radius_m, s.geo_strict
    into v_site_id, v_site_name, v_geo_lat, v_geo_lng, v_geo_radius_m, v_geo_strict
    from sites s
    where s.id = p_site_id and s.company_id = v_company_id;
  if v_site_id is null then
    return query select false, 'invalid_site'::text, null::uuid, null::double precision, false, null::text[], false, null::timestamptz, null::text; return;
  end if;
  v_geo_set_up := (v_geo_lat is not null and v_geo_lng is not null);

  -- ---- When did this punch happen, and can the phone's clock be trusted? ----
  if p_client_time is null then
    v_punched_at := now();
  elsif p_client_time > now() + interval '5 minutes' then
    v_punched_at := now();
    v_synced_late := true;
    v_verified := false;
    v_flags := v_flags || 'future_time'::text;
  elsif p_client_time < now() - interval '72 hours' then
    v_punched_at := now();
    v_synced_late := true;
    v_verified := false;
    v_flags := v_flags || 'stale_offline'::text;
  else
    v_punched_at := p_client_time;
    v_synced_late := (now() - p_client_time) > interval '2 minutes';
    if abs(extract(epoch from (now() - p_client_time))) <= 120 then
      v_skew := round(extract(epoch from (p_client_time - now())))::integer;
    elsif p_anchor_ms is not null and p_anchor_sig is not null and p_anchor_elapsed_ms is not null
          and p_anchor_elapsed_ms >= 0 and p_anchor_elapsed_ms <= 2592000000
          and p_anchor_sig = public._portal_anchor_sig(v_emp, p_anchor_ms)
          and to_timestamp(p_anchor_ms / 1000.0) <= now() + interval '1 minute' then
      v_expected := to_timestamp(p_anchor_ms / 1000.0) + (p_anchor_elapsed_ms * interval '1 millisecond');
      v_skew := round(extract(epoch from (p_client_time - v_expected)))::integer;
      if abs(v_skew) > 300 then
        v_verified := false;
        v_flags := v_flags || 'clock_skew'::text;
      end if;
    else
      v_verified := false;
      v_flags := v_flags || 'clock_unverified'::text;
    end if;
  end if;

  -- Local date and time come from the instant, in the company's timezone, never from the phone's strings.
  begin
    select coalesce(nullif(c.digest_timezone, ''), 'America/Toronto') into v_tz from companies c where c.id = v_company_id;
    v_local := v_punched_at at time zone v_tz;
  exception when others then
    v_tz := 'America/Toronto';
    v_local := v_punched_at at time zone v_tz;
  end;
  v_date := v_local::date;
  v_time := to_char(v_local, 'HH24:MI:SS');
  begin
    v_claimed := (p_punch_date::text || ' ' || p_punch_time)::timestamp;
    if abs(extract(epoch from (v_claimed - v_local))) > 300 then
      v_flags := v_flags || 'time_mismatch'::text;
    end if;
  exception when others then
    v_flags := v_flags || 'time_mismatch'::text;
  end;

  -- ---- Location ----
  if v_lat is not null and (v_lng is null or v_lat not between -90 and 90 or v_lng not between -180 and 180) then
    v_lat := null; v_lng := null;
  end if;
  if v_lat is null then v_lng := null; end if;
  v_acc := greatest(coalesce(p_accuracy_m, 0), 0);
  v_reason := case when p_geo_reason is null then null
                   else coalesce(nullif(regexp_replace(lower(left(p_geo_reason, 24)), '[^a-z_]', '', 'g'), ''), 'other') end;

  if v_geo_lat is not null and v_geo_lng is not null and v_lat is not null and v_lng is not null then
    v_distance := 6371000 * acos(
      least(1.0, greatest(-1.0,
        cos(radians(v_geo_lat)) * cos(radians(v_lat)) * cos(radians(v_lng) - radians(v_geo_lng))
        + sin(radians(v_geo_lat)) * sin(radians(v_lat))
      ))
    );
    v_geo_status := 'ok';
  elsif v_lat is not null and v_lng is not null then
    v_geo_status := 'ok';
  else
    v_geo_status := 'skipped';
  end if;

  if v_lat is null then
    if coalesce(v_geo_strict, false) then
      if v_reason is not null or v_synced_late then
        v_flags := v_flags || ('no_location' || coalesce(':' || v_reason, ''))::text;
      else
        return query select false, 'location_required'::text, null::uuid, null::double precision, false, null::text[], false, null::timestamptz, null::text; return;
      end if;
    elsif v_geo_set_up then
      v_flags := v_flags || ('no_location' || coalesce(':' || v_reason, ''))::text;
    end if;
  elsif coalesce(v_geo_strict, false) and v_distance is not null and v_geo_radius_m is not null and v_distance > v_geo_radius_m then
    if v_distance - v_acc > v_geo_radius_m then
      if v_synced_late then
        v_flags := v_flags || 'outside_geofence'::text;
      else
        return query select false, 'too_far'::text, null::uuid, v_distance, false, null::text[], false, null::timestamptz, null::text; return;
      end if;
    else
      v_flags := v_flags || 'low_accuracy'::text;
    end if;
  end if;

  -- The employee's justification: only for a punch without location, at a site where geolocation is set up.
  v_note := nullif(btrim(regexp_replace(regexp_replace(left(coalesce(p_geo_note, ''), 600), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), '');
  v_note := left(v_note, 300);
  if v_lat is not null or not v_geo_set_up then
    v_note := null;
  end if;

  -- ---- Sequence, looking at the punches around this moment ----
  select p.id, p.type, p.punched_at, p.source into v_prev
    from punches p where p.emp_id = v_emp and p.punched_at <= v_punched_at
    order by p.punched_at desc limit 1;
  select p.id, p.type, p.punched_at, p.source into v_next
    from punches p where p.emp_id = v_emp and p.punched_at > v_punched_at
    order by p.punched_at asc limit 1;

  -- A late sync may repeat what the manager already entered by hand (or an earlier copy of itself).
  if v_synced_late then
    select p.id, p.punched_at, p.source into v_dup
      from punches p
     where p.emp_id = v_emp and p.type = p_type
       and ( abs(extract(epoch from (p.punched_at - v_punched_at))) <= 600
          or (p.punch_time ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$'
              and abs(extract(epoch from (((p.punch_date::text || ' ' || p.punch_time)::timestamp at time zone v_tz) - v_punched_at))) <= 600) )
       and not exists (select 1 from punches o
                        where o.emp_id = v_emp and o.type <> p_type
                          and o.punched_at between least(p.punched_at, v_punched_at) and greatest(p.punched_at, v_punched_at))
     order by abs(extract(epoch from (p.punched_at - v_punched_at)))
     limit 1;
    if v_dup.id is not null then
      return query select false, 'already_recorded'::text, v_dup.id, v_distance, true, null::text[], true, v_dup.punched_at, v_dup.source; return;
    end if;
  end if;

  if p_type = 'IN' then
    if v_prev.type = 'IN' then
      return query select false, 'already_in'::text, null::uuid, v_distance, false, null::text[], false, v_prev.punched_at, v_prev.source; return;
    end if;
    if v_synced_late and v_next.type = 'IN' then
      return query select false, 'sequence_conflict'::text, null::uuid, v_distance, true, null::text[], false, v_next.punched_at, v_next.source; return;
    end if;
  else
    if v_prev.id is null or v_prev.type = 'OUT' then
      return query select false, 'not_in'::text, null::uuid, v_distance, false, null::text[], false, v_prev.punched_at, v_prev.source; return;
    end if;
    if v_synced_late and v_next.type = 'OUT' then
      return query select false, 'sequence_conflict'::text, null::uuid, v_distance, true, null::text[], false, v_next.punched_at, v_next.source; return;
    end if;
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
        return query select false, 'invalid_label'::text, null::uuid, v_distance, false, null::text[], false, null::timestamptz, null::text; return;
      end if;
      select l.id into v_label_id
        from work_labels l
       where l.id = p_label_id and l.company_id = v_company_id and l.active;
      if v_label_id is null then
        return query select false, 'invalid_label'::text, null::uuid, v_distance, false, null::text[], false, null::timestamptz, null::text; return;
      end if;
    elsif coalesce(v_label_mode, 'off') = 'required' and coalesce(v_label_addon, false)
          and exists (select 1 from work_labels l where l.company_id = v_company_id and l.active) then
      return query select false, 'label_required'::text, null::uuid, v_distance, false, null::text[], false, null::timestamptz, null::text; return;
    end if;
  end if;

  begin
    insert into punches (
      emp_id, emp_name, company_id, type, punch_date, punch_time, punched_at,
      site_id, site_name, is_manual, source, synced_late,
      geo_lat, geo_lng, geo_accuracy_m, geo_distance_m, geo_status, label_id,
      client_op_id, clock_skew_s, time_verified, review_flags, geo_note
    ) values (
      v_emp, v_emp_name, v_company_id, p_type, v_date, v_time, v_punched_at,
      v_site_id, v_site_name, false, 'mobile', v_synced_late,
      v_lat, v_lng, p_accuracy_m, v_distance, v_geo_status, v_label_id,
      p_client_op_id, v_skew, v_verified, case when cardinality(v_flags) = 0 then null else v_flags end, v_note
    ) returning id into v_new_id;
  exception when unique_violation then
    select p.id, p.geo_distance_m, p.synced_late, p.review_flags into v_old
      from punches p where p.emp_id = v_emp and p.client_op_id = p_client_op_id;
    if found then
      return query select true, null::text, v_old.id, v_old.geo_distance_m, v_old.synced_late, v_old.review_flags, true, null::timestamptz, null::text; return;
    end if;
    raise;
  end;

  return query select true, null::text, v_new_id, v_distance, v_synced_late,
                      case when cardinality(v_flags) = 0 then null else v_flags end, false, null::timestamptz, null::text;
end;
$function$;

revoke all on function public.portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision, uuid, uuid, bigint, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision, uuid, uuid, bigint, text, bigint, text, text) to anon, service_role;

-- ---- the employee adds or changes the note afterwards ----
drop function if exists public.portal_set_punch_note(text, uuid, text);
create function public.portal_set_punch_note(p_session text, p_punch_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_note text;
  v_n integer;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null or p_punch_id is null then
    return false;
  end if;
  v_note := nullif(btrim(regexp_replace(regexp_replace(left(coalesce(p_note, ''), 600), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), '');
  v_note := left(v_note, 300);
  -- Own punch, made by the app without location, within the last 14 days.
  update punches p
     set geo_note = v_note
   where p.id = p_punch_id
     and p.emp_id = v_emp
     and p.source = 'mobile'
     and p.punched_at > now() - interval '14 days'
     and exists (select 1 from unnest(coalesce(p.review_flags, '{}'::text[])) f where f like 'no_location%');
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$function$;
revoke all on function public.portal_set_punch_note(text, uuid, text) from public, anon, authenticated;
grant execute on function public.portal_set_punch_note(text, uuid, text) to anon, service_role;

-- ---- the employee's own punches, with their state ----
drop function if exists public.portal_get_punches(text, date, date);
create function public.portal_get_punches(p_session text, p_from date, p_to date)
returns table(id uuid, type text, punch_date date, punch_time text, punched_at timestamptz,
              site_name text, label_id uuid, label_name text, label_color text,
              source text, review_flags text[], geo_note text, time_verified boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_emp uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;
  return query
  select p.id, p.type, p.punch_date, p.punch_time, p.punched_at, p.site_name,
         w.id, w.name, w.color,
         p.source, p.review_flags, p.geo_note, p.time_verified
  from punches p
  left join work_labels w on w.id = p.label_id and w.company_id = p.company_id
  where p.emp_id = v_emp
    and p.punch_date >= p_from
    and p.punch_date <= p_to
  order by p.punched_at asc;
end;
$function$;
revoke all on function public.portal_get_punches(text, date, date) from public, anon, authenticated;
grant execute on function public.portal_get_punches(text, date, date) to anon, service_role;

notify pgrst, 'reload schema';
