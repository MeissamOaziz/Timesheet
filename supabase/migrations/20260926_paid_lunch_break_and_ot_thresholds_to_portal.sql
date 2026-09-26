-- Paid vs. unpaid lunch breaks (default false = preserves existing behaviour: a break's OUT/IN
-- gap is excluded from worked hours, as it always has been). When true, break punches are
-- filtered out before pairing everywhere hours are calculated, so the gap merges into one
-- continuous session and counts as worked time.
alter table companies add column if not exists lunch_break_paid boolean not null default false;

-- Extend portal_get_company_payroll with the OT-threshold and rounding settings that were already
-- being used inconsistently: the admin Activity/Reports view read companies.ot_daily_hours/
-- ot_weekly_hours/punch_rounding directly, but the employee portal ("My Hours") and the
-- send-period-summary email both had these hardcoded (8h/40h OT, no rounding) -- a real
-- discrepancy from a customer's actual configured thresholds. This RPC is the one round-trip the
-- portal already calls for company-level settings; both callers now read from here instead.
drop function portal_get_company_payroll(text);

create function portal_get_company_payroll(p_session text)
returns table(
  company_id uuid, payroll_frequency text, week_start text, payroll_anchor_date date,
  track_overtime boolean, remote_punch_enabled boolean,
  ot_daily_hours integer, ot_weekly_hours integer, punch_rounding integer, lunch_break_paid boolean
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
         c.ot_daily_hours, c.ot_weekly_hours, c.punch_rounding, c.lunch_break_paid
  from companies c where c.id = v_co;
end;
$function$;

grant execute on function portal_get_company_payroll(text) to anon, authenticated, service_role;
