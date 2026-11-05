-- Employee mobile app, backend step 1: punch integrity for offline and remote punching.
--
-- What this changes (all backwards compatible with employee.html, which keeps calling portal_punch by name):
--  1. punches gets client_op_id (idempotent retries), clock_skew_s, time_verified, review_flags.
--  2. portal_time_anchor(): the server hands out a signed "server time now" proof. A phone that later punches
--     offline sends the proof back with the time elapsed on its monotonic clock, so a changed phone clock shows up.
--  3. portal_punch v2:
--       * replaying the same client_op_id returns the first result and never inserts a second punch;
--       * punch_date / punch_time are DERIVED from the instant in the company timezone. Before this, the phone's own
--         strings were stored unchecked and hours are computed from them. A mismatch with what the phone claimed is
--         only flagged (time_mismatch);
--       * offline window is 72 h (was 48 h); older or future times are stored at the arrival time and flagged;
--       * geofence on strict sites no longer loses a punch because location was poor or missing:
--           - confidently outside, punch made live     -> refused (too_far), as before;
--           - confidently outside, synced late         -> kept, flagged outside_geofence (the employee cannot be told in time);
--           - uncertainty circle overlaps the radius   -> kept, flagged low_accuracy (was refused);
--           - no location at all                       -> kept and flagged no_location when the app says why
--                                                         (p_geo_reason) or the punch is a late sync, otherwise
--                                                         location_required, as before.
--       Nothing is excluded from hours: flags are information for the owner, who can edit or delete the punch.
-- Not done here (follow-up): a per-employee punch rate limit.

alter table public.punches
  add column if not exists client_op_id uuid,
  add column if not exists clock_skew_s integer,
  add column if not exists time_verified boolean not null default true,
  add column if not exists review_flags text[];

create unique index if not exists punches_emp_client_op_uidx
  on public.punches (emp_id, client_op_id) where client_op_id is not null;

insert into public.internal_secrets (key, value)
values ('portal_anchor_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

create or replace function public._portal_anchor_sig(p_emp uuid, p_ms bigint)
returns text
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
  select encode(
    extensions.hmac(p_emp::text || '|' || p_ms::text,
                    (select s.value from public.internal_secrets s where s.key = 'portal_anchor_secret'),
                    'sha256'),
    'hex')
$function$;
revoke all on function public._portal_anchor_sig(uuid, bigint) from public, anon, authenticated;
grant execute on function public._portal_anchor_sig(uuid, bigint) to service_role;

drop function if exists public.portal_time_anchor(text);
create function public.portal_time_anchor(p_session text)
returns table(server_time timestamptz, anchor_ms bigint, sig text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_ms bigint;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return;
  end if;
  v_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  return query select to_timestamp(v_ms / 1000.0), v_ms, public._portal_anchor_sig(v_emp, v_ms);
end;
$function$;
revoke all on function public.portal_time_anchor(text) from public, anon, authenticated;
grant execute on function public.portal_time_anchor(text) to anon, service_role;

drop function if exists public.portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision, uuid);

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
  p_geo_reason text default null
)
returns table(ok boolean, error_code text, punch_id uuid, distance_m double precision,
              synced_late boolean, flags text[], duplicate boolean)
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
  v_lat double precision := p_lat;
  v_lng double precision := p_lng;
  v_acc double precision;
  v_reason text;
  v_distance double precision := null;
  v_geo_status text;
  v_last_type text;
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
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return query select false, 'unauthorized'::text, null::uuid, null::double precision, false, null::text[], false; return;
  end if;

  -- Retry of a punch the server already stored: answer with the first result, insert nothing.
  if p_client_op_id is not null then
    select p.id, p.geo_distance_m, p.synced_late, p.review_flags into v_old
      from punches p where p.emp_id = v_emp and p.client_op_id = p_client_op_id;
    if found then
      return query select true, null::text, v_old.id, v_old.geo_distance_m, v_old.synced_late, v_old.review_flags, true; return;
    end if;
  end if;

  if p_type not in ('IN', 'OUT') then
    return query select false, 'bad_type'::text, null::uuid, null::double precision, false, null::text[], false; return;
  end if;

  select e.company_id, e.name, e.remote_punch_enabled into v_company_id, v_emp_name, v_emp_remote_ok
    from employees e where e.id = v_emp;
  if v_company_id is null then
    return query select false, 'unauthorized'::text, null::uuid, null::double precision, false, null::text[], false; return;
  end if;

  select c.remote_punch_enabled into v_remote_enabled from companies c where c.id = v_company_id;
  if not coalesce(v_remote_enabled, false) then
    return query select false, 'remote_punch_disabled'::text, null::uuid, null::double precision, false, null::text[], false; return;
  end if;

  if not coalesce(v_emp_remote_ok, false) then
    return query select false, 'employee_not_authorized'::text, null::uuid, null::double precision, false, null::text[], false; return;
  end if;

  select s.id, s.name, s.geo_lat, s.geo_lng, s.geo_radius_m, s.geo_strict
    into v_site_id, v_site_name, v_geo_lat, v_geo_lng, v_geo_radius_m, v_geo_strict
    from sites s
    where s.id = p_site_id and s.company_id = v_company_id;
  if v_site_id is null then
    return query select false, 'invalid_site'::text, null::uuid, null::double precision, false, null::text[], false; return;
  end if;

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
      -- A server-issued proof of "the time was X" plus the monotonic time elapsed since: where the clock should be.
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

  if coalesce(v_geo_strict, false) then
    if v_lat is null then
      if v_reason is not null or v_synced_late then
        v_flags := v_flags || ('no_location' || coalesce(':' || v_reason, ''))::text;
      else
        return query select false, 'location_required'::text, null::uuid, null::double precision, false, null::text[], false; return;
      end if;
    elsif v_distance is not null and v_geo_radius_m is not null and v_distance > v_geo_radius_m then
      if v_distance - v_acc > v_geo_radius_m then
        if v_synced_late then
          v_flags := v_flags || 'outside_geofence'::text;
        else
          return query select false, 'too_far'::text, null::uuid, v_distance, false, null::text[], false; return;
        end if;
      else
        v_flags := v_flags || 'low_accuracy'::text;
      end if;
    end if;
  end if;

  -- ---- Sequence ----
  select p.type into v_last_type
    from punches p where p.emp_id = v_emp order by p.punched_at desc limit 1;

  if p_type = 'IN' and v_last_type = 'IN' then
    return query select false, 'already_in'::text, null::uuid, v_distance, false, null::text[], false; return;
  end if;
  if p_type = 'OUT' and (v_last_type is null or v_last_type = 'OUT') then
    return query select false, 'not_in'::text, null::uuid, v_distance, false, null::text[], false; return;
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
        return query select false, 'invalid_label'::text, null::uuid, v_distance, false, null::text[], false; return;
      end if;
      select l.id into v_label_id
        from work_labels l
       where l.id = p_label_id and l.company_id = v_company_id and l.active;
      if v_label_id is null then
        return query select false, 'invalid_label'::text, null::uuid, v_distance, false, null::text[], false; return;
      end if;
    elsif coalesce(v_label_mode, 'off') = 'required' and coalesce(v_label_addon, false)
          and exists (select 1 from work_labels l where l.company_id = v_company_id and l.active) then
      return query select false, 'label_required'::text, null::uuid, v_distance, false, null::text[], false; return;
    end if;
  end if;

  begin
    insert into punches (
      emp_id, emp_name, company_id, type, punch_date, punch_time, punched_at,
      site_id, site_name, is_manual, source, synced_late,
      geo_lat, geo_lng, geo_accuracy_m, geo_distance_m, geo_status, label_id,
      client_op_id, clock_skew_s, time_verified, review_flags
    ) values (
      v_emp, v_emp_name, v_company_id, p_type, v_date, v_time, v_punched_at,
      v_site_id, v_site_name, false, 'mobile', v_synced_late,
      v_lat, v_lng, p_accuracy_m, v_distance, v_geo_status, v_label_id,
      p_client_op_id, v_skew, v_verified, case when cardinality(v_flags) = 0 then null else v_flags end
    ) returning id into v_new_id;
  exception when unique_violation then
    -- Two copies of the same punch arrived at the same moment: the second one gets the first one's answer.
    select p.id, p.geo_distance_m, p.synced_late, p.review_flags into v_old
      from punches p where p.emp_id = v_emp and p.client_op_id = p_client_op_id;
    if found then
      return query select true, null::text, v_old.id, v_old.geo_distance_m, v_old.synced_late, v_old.review_flags, true; return;
    end if;
    raise;
  end;

  return query select true, null::text, v_new_id, v_distance, v_synced_late,
                      case when cardinality(v_flags) = 0 then null else v_flags end, false;
end;
$function$;

revoke all on function public.portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision, uuid, uuid, bigint, text, bigint, text) from public, anon, authenticated;
grant execute on function public.portal_punch(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision, uuid, uuid, bigint, text, bigint, text) to anon, service_role;

notify pgrst, 'reload schema';
