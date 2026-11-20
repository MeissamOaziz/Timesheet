-- Employee portal password change: wrong "current password" guesses are now limited and logged, like the admin
-- change_own_password and every login (shared helpers: 10 failures per key per 15 minutes, audit_log login_failed).
-- Key 'pcp:<employee id>', so a stolen session cannot be used to guess the current password without limit.
-- Also fixed: after a change, only the OTHER devices are signed out (the hashed-token comparison signed out all of them).
create or replace function public.portal_change_password(p_session text, p_curpass text, p_newpass text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid; v_portal uuid; v_hash text; v_key text;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return jsonb_build_object('ok', false, 'error', 'no_session');
  end if;
  if length(coalesce(p_newpass, '')) < 8 then
    return jsonb_build_object('ok', false, 'error', 'weak_password');
  end if;
  v_key := 'pcp:' || v_emp::text;
  if public._auth_locked(v_key) then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;
  select id, password_hash into v_portal, v_hash
    from employee_portal where employee_id = v_emp and status = 'active' limit 1;
  if v_portal is null or v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'wrong_current');
  end if;
  if extensions.crypt(coalesce(p_curpass, ''), v_hash) is distinct from v_hash then
    perform public._auth_fail(v_key, null, 'portal_change_password');
    return jsonb_build_object('ok', false, 'error', 'wrong_current');
  end if;
  perform public._auth_clear(v_key);
  update employee_portal set password_hash = extensions.crypt(p_newpass, extensions.gen_salt('bf', 10)) where id = v_portal;
  -- tokens are stored hashed: compare with the hash, or the device making the change is signed out too
  delete from portal_sessions where portal_id = v_portal and token <> public._session_hash(p_session);
  return jsonb_build_object('ok', true);
end;
$function$;
