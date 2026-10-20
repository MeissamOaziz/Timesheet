-- activate_invited_admin(p_id, p_newpass) let anyone holding the public key set the password of a
-- pending-invite account knowing only its id (and then sign in as it). The new version also needs the
-- temporary password the invite was created with, i.e. the same proof the sign-in screen already asks for
-- (verify_admin_login). The old two-argument version is dropped in the follow-up migration, once the app
-- that calls the new one is live.

create or replace function public.activate_invited_admin(p_id uuid, p_curpass text, p_newpass text)
returns json
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_status text; v_stored text; v_exp timestamptz;
begin
  if p_newpass is null or length(p_newpass) < 6 then
    return json_build_object('ok', false, 'error', 'weak_password');
  end if;
  select status, password, expires_at into v_status, v_stored, v_exp from admins where id = p_id for update;
  if v_status is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  -- Same answer for "wrong password" and "not pending": nothing to probe with.
  if v_status <> 'pending_invite' or p_curpass is null or extensions.crypt(p_curpass, v_stored) <> v_stored
     or (v_exp is not null and v_exp <= now()) then
    return json_build_object('ok', false, 'error', 'not_pending');
  end if;
  update admins
     set password = extensions.crypt(p_newpass, extensions.gen_salt('bf', 10)), status = 'active', verified = true
   where id = p_id;
  return json_build_object('ok', true);
end;
$function$;

revoke all on function public.activate_invited_admin(uuid, text, text) from public;
grant execute on function public.activate_invited_admin(uuid, text, text) to anon, authenticated, service_role;
