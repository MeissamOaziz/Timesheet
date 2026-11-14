-- Calendar feed: "Add my shifts to my calendar" (employee portal, part of Scheduling).
--
-- An employee creates a private calendar link in the portal and adds it once to Google Calendar, Apple Calendar or
-- Outlook. The link carries a secret; only its sha-256 hash is stored here. The edge function `calendar-feed`
-- (service key) turns the secret into a hash and calls calendar_feed_read, which returns that employee's own
-- shifts and nothing else.
--
-- Who may do what
--   * Browser roles (anon, authenticated): nothing on the table. anon (the public key the portal uses) may call the
--     three portal_calendar_feed_* functions, which act only for the employee the portal session token resolves to
--     (no employee id is accepted). authenticated may call nothing, as everywhere else in this project.
--   * service_role: the table and calendar_feed_read (used by the edge functions only).
--   * calendar_feed_read and _calendar_feed_block are closed to browser roles.
--
-- Checked on every read: the employee is active, has an active portal account, the company has the paid portal
-- (Starter and up) and Scheduling (add-on or a running trial). A link that fails for a plan reason comes back when
-- the plan does; a link whose employee or portal account is gone is deleted on that read.
--
-- Limits: 60 reads an hour per link (counted before the shifts are fetched); 5 new links an hour per employee;
-- wrong links are counted per address and logged once at 30 in 15 minutes (they always answer "not found").
--
-- Rollback:
--   drop function if exists public.portal_calendar_feed_status(text), public.portal_calendar_feed_create(text, text),
--     public.portal_calendar_feed_revoke(text), public.calendar_feed_read(text, text), public._calendar_feed_block(uuid);
--   drop table if exists public.calendar_feeds;

create table public.calendar_feeds (
  employee_id  uuid primary key references public.employees(id) on delete cascade,   -- one live link per employee
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),           -- sha-256 of the secret, never the secret
  lang         text not null default 'en' check (lang in ('en', 'fr')),
  created_at   timestamptz not null default now(),
  last_read_at timestamptz,
  read_count   integer not null default 0,
  window_start timestamptz,                                                           -- start of the current one-hour read window
  window_count integer not null default 0
);

alter table public.calendar_feeds enable row level security;      -- no policies: closed to every browser role
revoke all on public.calendar_feeds from public, anon, authenticated;
grant select, insert, update, delete on public.calendar_feeds to service_role;

-- Why an employee may not have a working link right now (null = allowed).
create function public._calendar_feed_block(p_emp uuid)
 returns text
 language sql
 stable security definer
 set search_path to 'public', 'extensions'
as $$
  select case
    when e.id is null then 'unknown'
    when not coalesce(e.active, true) then 'inactive'
    when not exists (select 1 from public.employee_portal p where p.employee_id = e.id and p.status = 'active') then 'no_portal'
    when not coalesce(public.company_has_paid_features(e.company_id), false) then 'plan'
    when not coalesce((select a.scheduling_addon or coalesce(a.scheduling_trial_ends_at > now(), false)
                         from public.companies c join public.admins a on a.id = c.admin_id
                        where c.id = e.company_id), false) then 'scheduling'
    else null
  end
  from (select p_emp as want) w
  left join public.employees e on e.id = w.want;
$$;

-- Portal: is there a link, and may this employee have one? No rows = the session is not valid.
create function public.portal_calendar_feed_status(p_session text)
 returns table(allowed boolean, active boolean, created_at timestamptz, last_read_at timestamptz)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $$
declare v_emp uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;
  return query
  select public._calendar_feed_block(v_emp) is null, f.employee_id is not null, f.created_at, f.last_read_at
    from (select v_emp as id) me
    left join public.calendar_feeds f on f.employee_id = me.id;
end;
$$;

-- Portal: make a link (replacing any earlier one, which stops working at once). The secret is returned this one
-- time and is not stored. status: ok | locked (no Scheduling or plan) | too_many. No rows = the session is not valid.
create function public.portal_calendar_feed_create(p_session text, p_lang text)
 returns table(status text, token text)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $$
declare
  v_emp uuid;
  v_key text;
  v_token text;
  v_had boolean;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;
  if public._calendar_feed_block(v_emp) is not null then
    return query select 'locked'::text, null::text; return;
  end if;
  v_key := 'calfeed_new:' || v_emp::text;
  if (select count(*) from public.auth_attempts a where a.key = v_key and a.at > now() - interval '1 hour') >= 5 then
    return query select 'too_many'::text, null::text; return;
  end if;
  insert into public.auth_attempts(key) values (v_key);

  v_token := 'pcf_' || translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  v_had := exists (select 1 from public.calendar_feeds f where f.employee_id = v_emp);
  insert into public.calendar_feeds as f (employee_id, token_hash, lang)
  values (v_emp, encode(extensions.digest(v_token, 'sha256'), 'hex'), case when p_lang = 'fr' then 'fr' else 'en' end)
  on conflict (employee_id) do update
    set token_hash = excluded.token_hash, lang = excluded.lang, created_at = now(),
        last_read_at = null, read_count = 0, window_start = null, window_count = 0;
  begin
    insert into public.audit_log(admin_id, event, table_name, detail)
    select c.admin_id, case when v_had then 'calendar_feed_replaced' else 'calendar_feed_created' end, 'calendar_feeds',
           jsonb_build_object('employee_id', v_emp, 'by', 'employee')
      from public.employees e join public.companies c on c.id = e.company_id where e.id = v_emp;
  exception when others then null;
  end;
  return query select 'ok'::text, v_token;
end;
$$;

-- Portal: turn the link off. True when there was one.
create function public.portal_calendar_feed_revoke(p_session text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $$
declare v_emp uuid; v_n integer;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return false; end if;
  delete from public.calendar_feeds where employee_id = v_emp;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    begin
      insert into public.audit_log(admin_id, event, table_name, detail)
      select c.admin_id, 'calendar_feed_removed', 'calendar_feeds', jsonb_build_object('employee_id', v_emp, 'by', 'employee')
        from public.employees e join public.companies c on c.id = e.company_id where e.id = v_emp;
    exception when others then null;
    end;
  end if;
  return v_n > 0;
end;
$$;

-- Edge function `calendar-feed` only (service key): the hash of the secret from the link -> that employee's shifts.
-- Answers {status: 'ok', ...} or {status: 'not_found' | 'throttled', reason}. The reason is for tests and logs; the
-- edge function gives every non-ok answer the same "not found" (throttled: "too many requests").
create function public.calendar_feed_read(p_hash text, p_ip text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $$
declare
  v_emp uuid;
  v_count integer;
  v_lang text;
  v_block text;
  v_company uuid;
  v_name text;
  v_tz text;
  v_today date;
  v_events jsonb;
  v_key text;
  v_misses integer;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'not_found', 'reason', 'shape');
  end if;

  -- Count the read first, in the same statement that finds the link.
  update public.calendar_feeds f
     set window_count = case when f.window_start is null or f.window_start < now() - interval '1 hour' then 1 else f.window_count + 1 end,
         window_start = case when f.window_start is null or f.window_start < now() - interval '1 hour' then now() else f.window_start end,
         read_count = f.read_count + 1,
         last_read_at = now()
   where f.token_hash = p_hash
  returning f.employee_id, f.window_count, f.lang into v_emp, v_count, v_lang;

  if v_emp is null then
    -- A well-formed secret that matches nothing: count it per address, log once when an address reaches 30 in 15 min.
    v_key := 'calfeed_miss:' || left(coalesce(nullif(p_ip, ''), 'unknown'), 100);
    select count(*) into v_misses from public.auth_attempts a where a.key = v_key and a.at > now() - interval '15 minutes';
    if v_misses < 30 then
      insert into public.auth_attempts(key) values (v_key);
      if v_misses = 29 then
        begin
          insert into public.audit_log(event, table_name, detail)
          values ('calendar_feed_flood', 'calendar_feeds', jsonb_build_object('ip', left(coalesce(p_ip, ''), 100)));
        exception when others then null;
        end;
      end if;
    end if;
    return jsonb_build_object('status', 'not_found', 'reason', 'unknown');
  end if;

  if v_count > 60 then
    if v_count = 61 then
      begin
        insert into public.audit_log(admin_id, event, table_name, detail)
        select c.admin_id, 'calendar_feed_throttled', 'calendar_feeds', jsonb_build_object('employee_id', v_emp)
          from public.employees e join public.companies c on c.id = e.company_id where e.id = v_emp;
      exception when others then null;
      end;
    end if;
    return jsonb_build_object('status', 'throttled', 'reason', 'rate');
  end if;

  v_block := public._calendar_feed_block(v_emp);
  if v_block is not null then
    if v_block in ('unknown', 'inactive', 'no_portal') then
      delete from public.calendar_feeds where employee_id = v_emp;     -- the person or their portal account is gone: the link dies for good
    end if;
    return jsonb_build_object('status', 'not_found', 'reason', v_block);
  end if;

  select c.id, c.name, coalesce(nullif(c.digest_timezone, ''), 'America/Toronto')
    into v_company, v_name, v_tz
    from public.employees e join public.companies c on c.id = e.company_id
   where e.id = v_emp;
  begin
    v_today := (now() at time zone v_tz)::date;
  exception when others then
    v_tz := 'America/Toronto';
    v_today := (now() at time zone v_tz)::date;
  end;

  select coalesce(jsonb_agg(x.ev order by x.shift_date, x.start_time, x.id), '[]'::jsonb) into v_events
    from (
      select s.shift_date, s.start_time, s.id,
             jsonb_build_object('id', s.id, 'date', s.shift_date, 'start', s.start_time, 'end', s.end_time,
                                'label', l.name, 'site', si.name, 'note', s.note) as ev
        from public.shifts s
        left join public.work_labels l on l.id = s.label_id
        left join public.sites si on si.id = s.site_id
       where s.employee_id = v_emp
         and s.shift_date >= v_today - 30
         and s.shift_date <= v_today + 90
       order by s.shift_date, s.start_time, s.id
       limit 500
    ) x;

  return jsonb_build_object('status', 'ok', 'company', v_name, 'tz', v_tz, 'lang', v_lang, 'events', v_events);
end;
$$;

revoke all on function public._calendar_feed_block(uuid) from public, anon, authenticated;
revoke all on function public.calendar_feed_read(text, text) from public, anon, authenticated;
revoke all on function public.portal_calendar_feed_status(text) from public, anon, authenticated;
revoke all on function public.portal_calendar_feed_create(text, text) from public, anon, authenticated;
revoke all on function public.portal_calendar_feed_revoke(text) from public, anon, authenticated;

grant execute on function public._calendar_feed_block(uuid) to service_role;
grant execute on function public.calendar_feed_read(text, text) to service_role;
-- The employee portal (and the phone app) call these three with the public key; each checks the session token itself.
grant execute on function public.portal_calendar_feed_status(text) to anon, service_role;
grant execute on function public.portal_calendar_feed_create(text, text) to anon, service_role;
grant execute on function public.portal_calendar_feed_revoke(text) to anon, service_role;
