-- The archiver must never touch records younger than 18 months, whatever it is called with: the
-- product promise is that every account can always report on its last 18 months. Raising the
-- safety floor from 12 to 18 makes that structural instead of dependent on the cron argument.
-- (Body identical to 20261002_punch_indexes_and_18_month_archive.sql apart from the guard.)
create or replace function public.archive_old_records(p_months int default 18)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cut timestamptz := now() - make_interval(months => p_months);
  v_punches int := 0;
  v_visitors int := 0;
begin
  if p_months < 18 then
    raise exception 'refusing to archive records younger than 18 months';
  end if;

  update missed_punch_requests set punch_id = null
   where punch_id in (select id from punches where punched_at < v_cut);

  with moved as (delete from punches where punched_at < v_cut returning *)
  insert into punches_archive select m.*, now() from moved m;
  get diagnostics v_punches = row_count;

  with moved as (delete from visitors where checked_in_at < v_cut returning *)
  insert into visitors_archive select m.*, now() from moved m;
  get diagnostics v_visitors = row_count;

  return jsonb_build_object('cutoff', v_cut, 'punches_archived', v_punches, 'visitors_archived', v_visitors);
end;
$function$;

revoke all on function public.archive_old_records(int) from public, anon, authenticated;
grant execute on function public.archive_old_records(int) to service_role;
