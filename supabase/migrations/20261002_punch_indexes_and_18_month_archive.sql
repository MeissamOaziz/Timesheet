-- 1. Indexes. punches only had its primary key, so every company/site/employee query was a full
-- table scan; that is fine at 2k rows and a problem at 200k.
create index if not exists punches_company_punched_at_idx on public.punches (company_id, punched_at desc);
create index if not exists punches_site_punched_at_idx    on public.punches (site_id, punched_at desc);
create index if not exists punches_emp_punched_at_idx     on public.punches (emp_id, punched_at desc);
create index if not exists visitors_company_checked_in_idx on public.visitors (company_id, checked_in_at desc);
create index if not exists visitors_site_checked_in_idx    on public.visitors (site_id, checked_in_at desc);

-- 2. Archive tables: same columns as the live tables plus when the row was archived. Not exposed
-- to the app. RLS is enabled with no policies, which denies the public anon key entirely (the
-- service role used by secure-db and by the archive job bypasses RLS).
create table if not exists public.punches_archive  (like public.punches  including defaults including constraints);
create table if not exists public.visitors_archive (like public.visitors including defaults including constraints);
alter table public.punches_archive  add column if not exists archived_at timestamptz not null default now();
alter table public.visitors_archive add column if not exists archived_at timestamptz not null default now();
alter table public.punches_archive  add primary key (id);
alter table public.visitors_archive add primary key (id);
create index if not exists punches_archive_company_punched_at_idx on public.punches_archive (company_id, punched_at);
create index if not exists punches_archive_emp_idx on public.punches_archive (emp_id);
alter table public.punches_archive  enable row level security;
alter table public.visitors_archive enable row level security;

-- 3. The archiver. Moves rows older than p_months out of the live tables in one atomic statement
-- each (delete ... returning feeding the insert), so a row is never in both places or neither.
-- missed_punch_requests.punch_id is a plain foreign key into punches, so the link is cleared first
-- for punches about to be archived; the request keeps its own date/time/type, and the archived
-- punch keeps its id.
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
  if p_months < 12 then
    raise exception 'refusing to archive records younger than 12 months';
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

-- Callable by the scheduled job only. A security-definer function is otherwise reachable through
-- the public API by anyone holding the anon key.
revoke all on function public.archive_old_records(int) from public, anon, authenticated;
grant execute on function public.archive_old_records(int) to service_role;

-- Scheduled monthly, 03:15 UTC on the 1st, after the archiver was tested end to end against a
-- synthetic 2020 punch with a linked missed-punch request (moved, FK cleared, test rows removed).
select cron.schedule('archive-old-records', '15 3 1 * *', $$select public.archive_old_records(18)$$);
