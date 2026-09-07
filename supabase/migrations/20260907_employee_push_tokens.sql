-- Push notification subsystem, Phase 7. Modelled on the existing email pattern (Resend today;
-- Expo's hosted push API is the equivalent zero-infra choice for an Expo-managed app -- matches
-- "I have Expo Go" rather than standing up Firebase/APNs directly).
--
-- An employee can have more than one device (phone + a spare, a replaced phone whose old token
-- never got cleaned up, etc.) -- token is the natural primary key: re-registering the same token
-- (app reinstall, token rotation) just updates who it belongs to and when it was last seen,
-- rather than accumulating duplicates.
create table if not exists employee_push_tokens (
  token          text primary key,
  employee_id    uuid not null references employees(id) on delete cascade,
  platform       text not null check (platform in ('ios', 'android')),
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

create index if not exists employee_push_tokens_employee_id_idx
  on employee_push_tokens(employee_id);

comment on table employee_push_tokens is
  'Expo push tokens registered by the mobile app, one row per device. send-push (edge function) reads this to notify an employee.';

-- portal_register_push_token: the app calls this once per session (or whenever Expo issues a new
-- token) to register/refresh its own device. Session-authenticated like every other portal RPC --
-- an employee can only ever register a token for themselves, resolved server-side exactly like
-- portal_punch.
create or replace function portal_register_push_token(p_session text, p_token text, p_platform text)
returns table(ok boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return query select false; return;
  end if;
  if p_platform not in ('ios', 'android') then
    return query select false; return;
  end if;

  insert into employee_push_tokens (token, employee_id, platform, last_seen_at)
  values (p_token, v_emp, p_platform, now())
  on conflict (token) do update
    set employee_id = excluded.employee_id,
        platform = excluded.platform,
        last_seen_at = now();

  return query select true;
end;
$function$;

grant execute on function portal_register_push_token(text, text, text) to anon, authenticated, service_role;
