-- What a punch terminal needs from the punches table: who is clocked in right now, and a little recent
-- context. It used to download the latest 1000 punches of its site every 30 seconds (up to ~580 KB per
-- refresh, per tablet, around the clock), which on 2026-10-22 pushed the whole organization over the
-- Supabase Free plan's bandwidth and function quotas.
--
-- Returns every punch of the site from the last p_hours hours (default 36, max 168), plus each employee's
-- latest punch whatever its age, so a shift left open for days (the "ghost clock-in" case) still shows.
-- Same columns as punches, newest first, capped at 1000 rows. Called only by secure-db with the service key.
create or replace function public.kiosk_recent_punches(p_site_id uuid, p_hours int default 36)
returns setof public.punches
language sql
stable
set search_path = public
as $$
  select p.*
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
$$;

revoke all on function public.kiosk_recent_punches(uuid, int) from public, anon, authenticated;
grant execute on function public.kiosk_recent_punches(uuid, int) to service_role;
