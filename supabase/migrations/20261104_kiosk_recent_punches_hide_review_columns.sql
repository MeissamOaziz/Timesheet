-- Kiosk terminals read their site's punches through kiosk_recent_punches, which returns SETOF punches (p.*).
-- The employee-app columns added on 2026-11-04 (geo_note = the employee's free-text justification, review_flags,
-- client_op_id, clock_skew_s) would therefore reach every tablet that holds the site id. A terminal only needs to
-- know who is clocked in, so those four columns are blanked here; every other column is returned exactly as stored.
-- Simulated before applying: same rows, same order, all other columns identical, note/flags come back NULL.
-- (secure-db's fallback read, used only when this function errors, still does select *: strip it there in the next
-- secure-db deploy.)
create or replace function public.kiosk_recent_punches(p_site_id uuid, p_hours integer default 36)
returns setof public.punches
language sql
stable
set search_path to 'public'
as $function$
  select (jsonb_populate_record(null::public.punches,
            to_jsonb(p) - 'geo_note' - 'review_flags' - 'client_op_id' - 'clock_skew_s')).*
  from public.punches p
  where p.site_id = p_site_id
    and (
      p.punched_at >= now() - make_interval(hours => least(greatest(coalesce(p_hours, 36), 1), 168))
      or p.id in (
        select distinct on (q.emp_id) q.id
        from public.punches q
        where q.site_id = p_site_id
        order by q.emp_id, q.punched_at desc
      )
    )
  order by p.punched_at desc
  limit 1000;
$function$;
