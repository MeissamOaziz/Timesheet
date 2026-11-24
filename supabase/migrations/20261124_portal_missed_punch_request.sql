-- Employees can report a missed punch themselves, from the phone app or the employee portal.
--
-- Until now a missed-punch request could only be filed on the shared tablet, with the employee's PIN. An employee who
-- forgot to clock out at a job site had to wait for a manager to add the OUT by hand, usually with a guessed time
-- (owner's report, 2026-11-24). The forgot-to-clock-out alert now tells the employee, and this is what they answer
-- with. The manager still approves every request; nothing here writes a punch.
--
-- Identity comes only from the portal session token (never an employee id sent by the phone). Guards: a real time
-- in the last 14 days and not in the future (company time zone), no second pending request for the same day and
-- type, at most 5 pending and 10 filed in 24 hours per employee, a short note only.

alter table public.missed_punch_requests add column if not exists requested_by text;
comment on column public.missed_punch_requests.requested_by is
  'employee = filed by the employee from the app or portal (portal_request_missed_punch); null = filed on a tablet with the PIN';

create index if not exists missed_punch_requests_emp_created_idx
  on public.missed_punch_requests (emp_id, created_at desc);

create or replace function public.portal_request_missed_punch(
  p_session text, p_type text, p_date date, p_time text, p_reason text
)
returns table(id uuid, err text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_emp uuid; v_co uuid; v_site uuid; v_name text; v_tz text; v_at timestamptz; v_new uuid; v_reason text;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return query select null::uuid, 'not_authenticated'; return; end if;

  if p_type is null or p_type not in ('IN', 'OUT') then return query select null::uuid, 'invalid_type'; return; end if;
  if p_date is null or p_time is null or p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return query select null::uuid, 'invalid_time'; return;
  end if;

  select e.company_id, e.site_id, e.name into v_co, v_site, v_name from employees e where e.id = v_emp;
  if v_co is null then return query select null::uuid, 'no_company'; return; end if;
  select coalesce(nullif(c.digest_timezone, ''), 'America/Toronto') into v_tz from companies c where c.id = v_co;
  begin
    v_at := (p_date + p_time::time) at time zone v_tz;
  exception when others then
    v_at := (p_date + p_time::time) at time zone 'America/Toronto';
  end;
  if v_at > now() + interval '5 minutes' then return query select null::uuid, 'in_future'; return; end if;
  if v_at < now() - interval '14 days' then return query select null::uuid, 'too_old'; return; end if;

  -- Count first, then judge: a burst of parallel calls cannot slip past the limits.
  if (select count(*) from missed_punch_requests r where r.emp_id = v_emp and r.status = 'pending') >= 5 then
    return query select null::uuid, 'too_many_pending'; return;
  end if;
  if (select count(*) from missed_punch_requests r where r.emp_id = v_emp and r.created_at > now() - interval '24 hours') >= 10 then
    return query select null::uuid, 'too_many'; return;
  end if;
  if exists (select 1 from missed_punch_requests r where r.emp_id = v_emp and r.status = 'pending'
             and r.requested_date = p_date and r.type = p_type) then
    return query select null::uuid, 'already_requested'; return;
  end if;

  -- The site of that day's punches when there are any (so the right site's manager approves it), else the
  -- employee's home site.
  select p.site_id into v_site from punches p
   where p.emp_id = v_emp and p.punch_date = p_date and p.site_id is not null
   order by p.punched_at desc limit 1;
  if v_site is null then select e.site_id into v_site from employees e where e.id = v_emp; end if;

  v_reason := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 300), '');

  insert into missed_punch_requests(company_id, site_id, emp_id, emp_name, type, requested_date, requested_time,
                                    reason, status, requested_by)
  values (v_co, v_site, v_emp, v_name, p_type, p_date, (p_time || ':00')::time, v_reason, 'pending', 'employee')
  returning missed_punch_requests.id into v_new;

  return query select v_new, null::text;
end;
$$;

revoke all on function public.portal_request_missed_punch(text, text, date, text, text) from public;
revoke all on function public.portal_request_missed_punch(text, text, date, text, text) from authenticated;
grant execute on function public.portal_request_missed_punch(text, text, date, text, text) to anon, service_role;

-- The employee's own requests, newest first, for the app and the portal (what they asked, and the answer).
create or replace function public.portal_get_missed_punches(p_session text)
returns table(id uuid, type text, requested_date date, requested_time time, reason text, status text, created_at timestamptz)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare v_emp uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;
  return query
    select r.id, r.type, r.requested_date, r.requested_time, r.reason, r.status, r.created_at
      from missed_punch_requests r
     where r.emp_id = v_emp and r.created_at > now() - interval '60 days'
     order by r.created_at desc
     limit 50;
end;
$$;

revoke all on function public.portal_get_missed_punches(text) from public;
revoke all on function public.portal_get_missed_punches(text) from authenticated;
grant execute on function public.portal_get_missed_punches(text) to anon, service_role;
