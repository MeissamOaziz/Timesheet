-- Growth, Business and Unlimited include Scheduling (decision 2026-11-26). Starter keeps the paid add-on
-- (admins.scheduling_addon) and the free 14-day trial (admins.scheduling_trial_ends_at) exactly as before.
--
-- One helper holds the rule for the database. secure-db's schedulingActive and the website's
-- hasSchedulingAddon say the same thing: change all three together (pricing page = app = server).
create or replace function public.admin_scheduling_active(p_admin uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(public.admin_plan_rank(a.id) >= 2, false)          -- growth, business, unlimited
      or coalesce(a.scheduling_addon, false)                          -- paid add-on (Starter)
      or coalesce(a.scheduling_trial_ends_at > now(), false)          -- free 14-day trial (Starter)
  from public.admins a
  where a.id = p_admin
$function$;

-- Only the database's own functions call it (they run as their owner). No page calls it directly.
revoke all on function public.admin_scheduling_active(uuid) from public, anon, authenticated;
grant execute on function public.admin_scheduling_active(uuid) to service_role;

-- The four functions that asked "add-on or trial?" now ask the helper. Each live definition holds the old
-- expression exactly once; the block refuses to run if that is no longer true, so nothing is half-changed.
--   portal_get_schedule_status  employee portal and employee app: is the schedule open?
--   portal_get_punch_labels     portal: work labels offered at clock-in
--   portal_punch                portal: accepts a work label on a clock-in
--   _calendar_feed_block        private calendar link: refused with 'scheduling' when off
do $mig$
declare
  v_old constant text := 'a.scheduling_addon or coalesce(a.scheduling_trial_ends_at > now(), false)';
  v_new constant text := 'public.admin_scheduling_active(a.id)';
  v_fn  text;
  v_oid oid;
  v_def text;
  v_n   int;
begin
  foreach v_fn in array array['portal_get_schedule_status', 'portal_get_punch_labels', 'portal_punch', '_calendar_feed_block'] loop
    select p.oid into strict v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    v_def := pg_get_functiondef(v_oid);
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception 'growth_includes_scheduling: % holds the add-on check % times, expected 1', v_fn, v_n;
    end if;

    -- create or replace keeps the owner, grants, security definer and search_path of the function.
    execute replace(v_def, v_old, v_new);
  end loop;
end
$mig$;
