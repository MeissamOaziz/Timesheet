-- Employee portal: changing your own password now needs 8 characters, like reset and invite (was 6).
-- Same function otherwise; CREATE OR REPLACE keeps its grants (anon may execute: employee.html calls it with a session token).
create or replace function public.portal_change_password(p_session text, p_curpass text, p_newpass text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_emp uuid; v_portal uuid; v_hash text;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return jsonb_build_object('ok', false, 'error', 'no_session');
  end if;
  if length(coalesce(p_newpass, '')) < 8 then
    return jsonb_build_object('ok', false, 'error', 'weak_password');
  end if;
  select id, password_hash into v_portal, v_hash
    from employee_portal where employee_id = v_emp and status = 'active' limit 1;
  if v_portal is null or v_hash is null or extensions.crypt(coalesce(p_curpass, ''), v_hash) <> v_hash then
    return jsonb_build_object('ok', false, 'error', 'wrong_current');
  end if;
  update employee_portal set password_hash = extensions.crypt(p_newpass, extensions.gen_salt('bf', 10)) where id = v_portal;
  delete from portal_sessions where portal_id = v_portal and token <> p_session;
  return jsonb_build_object('ok', true);
end;
$function$;
