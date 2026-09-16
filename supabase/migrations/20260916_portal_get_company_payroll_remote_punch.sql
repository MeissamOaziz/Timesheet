-- Add remote_punch_enabled to the one RPC the portal already calls for company-level settings
-- (renderReports/initPunchBar), rather than adding a new round-trip just for this flag.
drop function portal_get_company_payroll(text);

create function portal_get_company_payroll(p_session text)
returns table(company_id uuid, payroll_frequency text, week_start text, payroll_anchor_date date, track_overtime boolean, remote_punch_enabled boolean)
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
  select c.id, c.payroll_frequency, c.week_start, c.payroll_anchor_date, c.track_overtime, c.remote_punch_enabled
  from companies c where c.id = v_co;
end;
$function$;

grant execute on function portal_get_company_payroll(text) to anon, authenticated, service_role;
