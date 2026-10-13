-- Work labels on punches. A punch can say what the person was working on (set on the IN that starts
-- a stretch of work; the stretch inherits it until the matching OUT). A task switch is recorded as
-- an OUT immediately followed by an IN at the same moment, both flagged is_switch, so daily totals
-- and overtime are unaffected (zero gap) while hours can still be split by label.
alter table public.punches add column label_id uuid references public.work_labels(id) on delete set null;
alter table public.punches add column is_switch boolean not null default false;
create index punches_label_idx on public.punches (label_id) where label_id is not null;

-- The archive must carry the same columns. No foreign key there: history must survive a label
-- being deleted later.
alter table public.punches_archive add column label_id uuid;
alter table public.punches_archive add column is_switch boolean not null default false;

-- Company setting: whether the kiosk/portal asks for a label when someone clocks in.
alter table public.companies
  add column punch_label_mode text not null default 'off'
  check (punch_label_mode in ('off','optional','required'));

-- The archiver copied rows by position (select m.*, now()), which silently breaks the moment the
-- live table gains a column the archive lacks or orders differently. Copy by column NAME instead.
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
  insert into punches_archive
  select (jsonb_populate_record(null::punches_archive, to_jsonb(m) || jsonb_build_object('archived_at', now()))).*
  from moved m;
  get diagnostics v_punches = row_count;

  with moved as (delete from visitors where checked_in_at < v_cut returning *)
  insert into visitors_archive
  select (jsonb_populate_record(null::visitors_archive, to_jsonb(m) || jsonb_build_object('archived_at', now()))).*
  from moved m;
  get diagnostics v_visitors = row_count;

  return jsonb_build_object('cutoff', v_cut, 'punches_archived', v_punches, 'visitors_archived', v_visitors);
end;
$function$;

revoke all on function public.archive_old_records(int) from public, anon, authenticated;
grant execute on function public.archive_old_records(int) to service_role;