-- The employee portal's "does my company have scheduling?" answer must count the free 14-day trial too.
-- The trial is only an end date on the owner's account (admins.scheduling_trial_ends_at, set once by
-- secure-db's start_scheduling_trial); scheduling_addon stays true only for a paying account.
create or replace function portal_get_schedule_status(p_session text)
returns table(scheduling_addon boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
  v_company_id uuid;
  v_addon boolean;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;

  select e.company_id into v_company_id from employees e where e.id = v_emp;
  if v_company_id is null then return; end if;

  select (a.scheduling_addon or coalesce(a.scheduling_trial_ends_at > now(), false)) into v_addon
  from companies c join admins a on a.id = c.admin_id
  where c.id = v_company_id;

  return query select coalesce(v_addon, false);
end;
$function$;

grant execute on function portal_get_schedule_status(text) to anon, authenticated, service_role;
