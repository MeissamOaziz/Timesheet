-- The employee portal's schedule and Team Schedule now carry each shift's work label (name + colour),
-- so an employee sees what the shift is for. Return types change, so the functions are replaced;
-- done in one transaction so there is no moment when they don't exist. Extra columns are ignored by
-- any cached older portal page. Same security posture as before: SECURITY DEFINER, session-resolved
-- employee, execute granted to the roles the portal uses.
drop function if exists public.portal_get_shifts(text, date, date);
create function public.portal_get_shifts(p_session text, p_from date, p_to date)
returns table(id uuid, shift_date date, start_time time without time zone, end_time time without time zone,
              note text, site_id uuid, label_name text, label_color text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_emp uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;
  return query
  select s.id, s.shift_date, s.start_time, s.end_time, s.note, s.site_id, l.name, l.color
  from shifts s
  left join work_labels l on l.id = s.label_id
  where s.employee_id = v_emp
    and s.shift_date >= p_from
    and s.shift_date <= p_to
  order by s.shift_date asc, s.start_time asc;
end;
$function$;
grant execute on function public.portal_get_shifts(text, date, date) to anon, authenticated, service_role;

drop function if exists public.portal_get_team_shifts(text, date, date);
create function public.portal_get_team_shifts(p_session text, p_from date, p_to date)
returns table(id uuid, employee_id uuid, employee_name text, shift_date date, start_time time without time zone,
              end_time time without time zone, note text, label_name text, label_color text)
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
  select s.id, s.employee_id, e2.name, s.shift_date, s.start_time, s.end_time, s.note, l.name, l.color
  from shifts s
  join employees e2 on e2.id = s.employee_id
  left join work_labels l on l.id = s.label_id
  where e2.site_id = v_site
    and e2.active = true
    and s.shift_date >= p_from
    and s.shift_date <= p_to
  order by s.shift_date asc, s.start_time asc;
end;
$function$;
grant execute on function public.portal_get_team_shifts(text, date, date) to anon, authenticated, service_role;
