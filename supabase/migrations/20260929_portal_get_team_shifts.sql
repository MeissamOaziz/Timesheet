-- Employee-portal "Team Schedule" tab (customer request, Connoisseur Culture): lets an employee
-- see everyone's shifts at their own site for a given week, not just their own. Scoped to site
-- rather than the whole company -- matches how kiosk/punch data is already scoped elsewhere in
-- the portal, and an employee at one site has no reason to see another site's roster.
create function portal_get_team_shifts(p_session text, p_from date, p_to date)
returns table(id uuid, employee_id uuid, employee_name text, shift_date date, start_time time, end_time time, note text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_emp uuid; v_site uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;
  select e.site_id into v_site from employees e where e.id = v_emp;
  if v_site is null then return; end if;
  return query
  select s.id, s.employee_id, e2.name, s.shift_date, s.start_time, s.end_time, s.note
  from shifts s
  join employees e2 on e2.id = s.employee_id
  where e2.site_id = v_site
    and e2.active = true
    and s.shift_date >= p_from
    and s.shift_date <= p_to
  order by s.shift_date asc, s.start_time asc;
end;
$function$;

grant execute on function portal_get_team_shifts(text, date, date) to anon, authenticated, service_role;
