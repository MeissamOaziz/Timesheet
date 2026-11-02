-- Employee portal: show which job (work label) was chosen at clock-in.
-- Lumi Conseil's technicians pick a label when they clock in from the phone (20261031_portal_punch_label.sql),
-- but My Hours never showed it, so they could not check what they had selected.
--
-- portal_get_punches gains label_id, label_name, label_color (last, so older cached portal pages that read
-- the columns by name keep working). The label comes from the employee's OWN punch and is looked up only
-- among the punch's own company's labels. It is shown whenever the punch carries one, also if the company
-- has since switched labels off or lost the Scheduling add-on: it is the employee's own history.
-- The return type changes, so the old function is dropped in the same transaction. Same grants as before
-- (anon, service_role; the anon allowlist already contains portal_get_punches).
drop function if exists public.portal_get_punches(text, date, date);

create function public.portal_get_punches(p_session text, p_from date, p_to date)
returns table(id uuid, type text, punch_date date, punch_time text, punched_at timestamptz, site_name text,
              label_id uuid, label_name text, label_color text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_emp uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;
  return query
  select p.id, p.type, p.punch_date, p.punch_time, p.punched_at, p.site_name,
         w.id, w.name, w.color
  from punches p
  left join work_labels w on w.id = p.label_id and w.company_id = p.company_id
  where p.emp_id = v_emp
    and p.punch_date >= p_from
    and p.punch_date <= p_to
  order by p.punched_at asc;
end;
$function$;

revoke all on function public.portal_get_punches(text, date, date) from public;
revoke all on function public.portal_get_punches(text, date, date) from authenticated;
grant execute on function public.portal_get_punches(text, date, date) to anon, service_role;
