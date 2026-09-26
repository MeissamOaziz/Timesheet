-- A flat "is the break paid, yes/no" setting can't express how real companies actually handle
-- breaks: some pay a fixed number of minutes of a longer break and leave the rest unpaid (e.g.
-- 30 of a 60-minute break), some pay all of it, some none. Replace the boolean with an integer
-- minutes cap -- 0 (default) preserves today's fully-unpaid behaviour; a value like 30 pays the
-- first 30 minutes of any break actually taken (a shorter break only pays for its real length).
-- No live company had lunch_break_paid = true yet, so this is a clean swap, not a data migration.
alter table companies add column lunch_break_paid_minutes integer not null default 0;
alter table companies drop column lunch_break_paid;

drop function portal_get_company_payroll(text);

create function portal_get_company_payroll(p_session text)
returns table(
  company_id uuid, payroll_frequency text, week_start text, payroll_anchor_date date,
  track_overtime boolean, remote_punch_enabled boolean,
  ot_daily_hours integer, ot_weekly_hours integer, punch_rounding integer, lunch_break_paid_minutes integer
)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_emp uuid; v_co uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;
  select e.company_id into v_co from employees e where e.id = v_emp;
  if v_co is null then return; end if;
  return query
  select c.id, c.payroll_frequency, c.week_start, c.payroll_anchor_date, c.track_overtime, c.remote_punch_enabled,
         c.ot_daily_hours, c.ot_weekly_hours, c.punch_rounding, c.lunch_break_paid_minutes
  from companies c where c.id = v_co;
end;
$function$;

grant execute on function portal_get_company_payroll(text) to anon, authenticated, service_role;
