-- Employees had no way to recover a forgotten portal password. The only route was asking a
-- manager to re-invite them, which means an employee cannot check their own hours without
-- involving the person whose records they might be checking.
--
-- issue_email_code already carries the throttling that matters (60s resend cooldown, 5/hour
-- cap, 15-minute expiry, bcrypt-hashed codes), so it gains a 'portal_reset' purpose rather
-- than being copied into a parallel function that would drift out of step with those limits.
-- The purpose string is the whole boundary between the two account types: a portal code
-- cannot reset an admin, and an admin code cannot reset a portal login.
--
-- See the applied migration `portal_password_reset` for the full body of issue_email_code;
-- only the portal_reset branch below is new.

create or replace function portal_reset_password(p_email text, p_code text, p_newpass text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_row    record;
  v_portal uuid;
begin
  if length(coalesce(p_newpass,'')) < 6 then
    return jsonb_build_object('ok', false, 'error', 'weak_password');
  end if;

  select * into v_row from email_codes
   where lower(email) = lower(p_email) and purpose = 'portal_reset'
   order by created_at desc limit 1;

  -- One error for every failure mode: a wrong code, an expired code and an address with no
  -- portal account are indistinguishable to the caller.
  if v_row is null or v_row.expires_at < now()
     or v_row.code_hash <> extensions.crypt(p_code, v_row.code_hash) then
    return jsonb_build_object('ok', false, 'error', 'bad_code');
  end if;

  select id into v_portal from employee_portal
   where lower(email) = lower(p_email) and status = 'active' limit 1;
  if v_portal is null then
    return jsonb_build_object('ok', false, 'error', 'bad_code');
  end if;

  update employee_portal
     set password_hash = extensions.crypt(p_newpass, extensions.gen_salt('bf', 10))
   where id = v_portal;

  -- Consumed, so the code cannot be replayed to set a second password.
  delete from email_codes where lower(email) = lower(p_email) and purpose = 'portal_reset';

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function portal_reset_password(text, text, text) to anon, authenticated, service_role;
