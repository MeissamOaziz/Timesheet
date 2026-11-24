-- Apple Watch sign-in, handed over by the phone.
--
-- Nobody types a password on a watch. The employee's phone app, already signed in, asks for a separate session for its
-- paired watch and passes it over Apple's phone-to-watch link (WatchConnectivity, encrypted between the paired devices).
-- The watch then uses the same portal_* functions as the phone, with the same checks (remote punching allowed, site,
-- geofence, labels): nothing new is reachable from the watch.
--
-- The watch session is a child of the phone session (parent_token, on delete cascade), so it can never outlive it:
-- signing out on the phone, changing the password (which removes the other sessions) or revoking the phone in
-- "my devices" ends the watch too. It expires with the parent at the latest. One watch per phone session: asking again
-- replaces it. A watch session cannot issue another one.

alter table public.portal_sessions add column if not exists parent_token text
  references public.portal_sessions(token) on delete cascade;
create index if not exists portal_sessions_parent_idx on public.portal_sessions (parent_token) where parent_token is not null;
comment on column public.portal_sessions.parent_token is
  'Set for a watch session: the (hashed) phone session it was issued from. Deleting the phone session deletes this one.';

create or replace function public.portal_issue_watch_session(p_session text, p_label text)
returns table(session_token text, expires_at timestamptz)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_emp uuid; v_hash text; v_parent portal_sessions%rowtype; v_token text; v_recent int;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then return; end if;
  v_hash := public._session_hash(p_session);
  select * into v_parent from portal_sessions s where s.token = v_hash and s.employee_id = v_emp;
  -- Only a phone (or web) session may hand out a watch session; never a watch session itself.
  if v_parent.token is null or v_parent.parent_token is not null then return; end if;

  -- At most 10 hand-overs an hour per employee (each one replaces the last, so this only stops a runaway loop).
  select count(*) into v_recent from audit_log a
   where a.event = 'watch_session_issued' and a.detail->>'emp' = v_emp::text and a.at > now() - interval '1 hour';
  if v_recent >= 10 then return; end if;

  delete from portal_sessions s where s.parent_token = v_hash;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into portal_sessions(token, employee_id, portal_id, expires_at, parent_token, device_label, platform)
  values (public._session_hash(v_token), v_emp, v_parent.portal_id, v_parent.expires_at, v_hash,
          coalesce(nullif(btrim(regexp_replace(left(coalesce(p_label, ''), 60), '[[:cntrl:]]', '', 'g')), ''), 'Apple Watch'),
          'watchos');
  insert into audit_log(event, detail) values ('watch_session_issued', jsonb_build_object('emp', v_emp));

  return query select v_token, v_parent.expires_at;
end;
$$;

revoke all on function public.portal_issue_watch_session(text, text) from public;
revoke all on function public.portal_issue_watch_session(text, text) from authenticated;
grant execute on function public.portal_issue_watch_session(text, text) to anon, service_role;
