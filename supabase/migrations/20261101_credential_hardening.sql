-- 2026-11-01  Credential-handling hardening (security audit findings 2, 3, 4, 8, 10, 11, 16, 18, 19, 21)
--
-- ADDITIVE half. Same-signature functions are replaced in place (response shapes unchanged, grants kept);
-- the two functions whose signature changes (superadmin_create_admin, change_own_password) get NEW
-- token-keyed overloads and the old uuid-keyed ones stay until 20261101_credential_hardening_drop_old.sql,
-- applied after the browser code that calls the new ones is live.
--
--  * auth_attempts + _auth_locked/_auth_fail/_auth_clear: 10 failures per key per 15 min, then refuse.
--    Keys: 'a:<lower email>' (admin), 'p:<lower email>' (portal), 'id:<admin uuid>' (change/activate).
--    A refusal keeps the function's normal bad-password shape; only verify_admin_login and portal_login
--    (which return a row set and cannot carry a flag) raise the message 'too_many_attempts', which the
--    browser now turns into a friendly English/French message.
--  * unknown emails still run one bcrypt so timing does not reveal registered emails.
--  * failures are written to audit_log as event 'login_failed' (kind + key only, never a password).
--  * minimum password length 8, never empty/blank, never equal to the account email, in every function
--    edited here (_password_ok).
--  * bcrypt cost 10 for new portal accounts; legacy cost-6/8 hashes are upgraded on a successful
--    mint_admin_session / portal_login.

-- ---------------------------------------------------------------------------------------------
-- Table (RLS on, no policies, service_role only) + helpers
-- ---------------------------------------------------------------------------------------------
create table if not exists public.auth_attempts (
  key text not null,
  at  timestamptz not null default now()
);
create index if not exists auth_attempts_key_at_idx on public.auth_attempts (key, at);
create index if not exists auth_attempts_at_idx on public.auth_attempts (at);
alter table public.auth_attempts enable row level security;
revoke all on public.auth_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.auth_attempts to service_role;

create or replace function public._auth_locked(p_key text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'extensions'
as $$
  select count(*) >= 10 from public.auth_attempts
   where key = left(coalesce(p_key, ''), 200) and at > now() - interval '15 minutes';
$$;

create or replace function public._auth_fail(p_key text, p_admin uuid, p_kind text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $$
begin
  insert into public.auth_attempts(key) values (left(coalesce(p_key, ''), 200));
  begin
    insert into public.audit_log(admin_id, event, detail)
    values (p_admin, 'login_failed', jsonb_build_object('kind', p_kind, 'key', left(coalesce(p_key, ''), 200)));
  exception when others then null;
  end;
end;
$$;

create or replace function public._auth_clear(p_key text)
 returns void
 language sql
 security definer
 set search_path to 'public', 'extensions'
as $$
  delete from public.auth_attempts where key = left(coalesce(p_key, ''), 200);
$$;

create or replace function public._password_ok(p_pass text, p_email text)
 returns boolean
 language sql
 immutable
 set search_path to 'public', 'extensions'
as $$
  select p_pass is not null
     and length(p_pass) >= 8
     and length(p_pass) <= 128
     and btrim(p_pass) <> ''
     and lower(btrim(p_pass)) <> lower(btrim(coalesce(p_email, '')));
$$;

revoke all on function public._auth_locked(text) from public, anon, authenticated;
revoke all on function public._auth_fail(text, uuid, text) from public, anon, authenticated;
revoke all on function public._auth_clear(text) from public, anon, authenticated;
revoke all on function public._password_ok(text, text) from public, anon, authenticated;
grant execute on function public._auth_locked(text) to service_role;
grant execute on function public._auth_fail(text, uuid, text) to service_role;
grant execute on function public._auth_clear(text) to service_role;
grant execute on function public._password_ok(text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- mint_admin_session: throttle, dummy bcrypt, rehash to cost 10
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mint_admin_session(p_email text, p_pass text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_admin admins%ROWTYPE; v_token text; v_key text;
BEGIN
  v_key := 'a:' || lower(coalesce(p_email, ''));
  IF public._auth_locked(v_key) THEN
    RETURN json_build_object('ok', false);
  END IF;
  SELECT * INTO v_admin FROM admins a
  WHERE a.email = p_email
    AND a.password = extensions.crypt(p_pass, a.password)
    AND a.verified = true
    AND a.status IS DISTINCT FROM 'suspended';
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.email = p_email) THEN
      PERFORM extensions.crypt(coalesce(p_pass, ''), extensions.gen_salt('bf', 10));
    END IF;
    PERFORM public._auth_fail(v_key, (SELECT a.id FROM admins a WHERE a.email = p_email LIMIT 1), 'admin');
    RETURN json_build_object('ok', false);
  END IF;
  PERFORM public._auth_clear(v_key);
  IF v_admin.password ~ '^\$2[abxy]\$0' THEN
    UPDATE admins SET password = extensions.crypt(p_pass, extensions.gen_salt('bf', 10)) WHERE id = v_admin.id;
  END IF;
  v_token := _issue_admin_session(v_admin.id);
  BEGIN
    INSERT INTO audit_log(admin_id, event) VALUES (v_admin.id, 'login');
  EXCEPTION WHEN others THEN NULL;
  END;
  RETURN json_build_object('ok', true, 'session_token', v_token, 'admin_id', v_admin.id);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- verify_admin_login: throttle (raises 'too_many_attempts' when locked), dummy bcrypt
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_admin_login(p_email text, p_pass text)
 RETURNS TABLE(id uuid, name text, email text, password text, verified boolean, created_at timestamp with time zone, role text, plan text, status text, lang text, parent_admin_id uuid, invited_by text, expires_at timestamp with time zone, stripe_customer_id text, stripe_subscription_id text, extra_seats integer, scheduling_addon boolean, last_login timestamp with time zone, onboarding_emails_sent jsonb, first_name text, last_name text, invite_token text, invite_expires_at timestamp with time zone, invite_used_at timestamp with time zone, invite_site_ids uuid[], weekly_digest boolean, scheduling_trial_ends_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_key text;
BEGIN
  v_key := 'a:' || lower(coalesce(p_email, ''));
  IF public._auth_locked(v_key) THEN
    RAISE EXCEPTION 'too_many_attempts';
  END IF;
  RETURN QUERY
  SELECT a.id, a.name, a.email, NULL::text AS password, a.verified, a.created_at, a.role,
         a.plan, a.status, a.lang, a.parent_admin_id, a.invited_by, a.expires_at,
         a.stripe_customer_id, a.stripe_subscription_id, a.extra_seats, a.scheduling_addon,
         a.last_login, a.onboarding_emails_sent, a.first_name, a.last_name, a.invite_token,
         a.invite_expires_at, a.invite_used_at, a.invite_site_ids, a.weekly_digest,
         a.scheduling_trial_ends_at
  FROM admins a
  WHERE a.email = p_email
    AND a.password = crypt(p_pass, a.password)
    AND a.verified = true
    AND a.status IS DISTINCT FROM 'suspended';
  IF FOUND THEN
    PERFORM public._auth_clear(v_key);
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM admins a2 WHERE a2.email = p_email) THEN
    PERFORM extensions.crypt(coalesce(p_pass, ''), extensions.gen_salt('bf', 10));
  END IF;
  PERFORM public._auth_fail(v_key, (SELECT a3.id FROM admins a3 WHERE a3.email = p_email LIMIT 1), 'admin');
  RETURN;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- portal_login: throttle (raises 'too_many_attempts' when locked), dummy bcrypt, rehash to cost 10
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_login(p_email text, p_pass text)
 RETURNS TABLE(portal_id uuid, employee_id uuid, email text, session_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_row employee_portal%rowtype; v_session text; v_key text;
begin
  v_key := 'p:' || lower(coalesce(p_email, ''));
  if public._auth_locked(v_key) then
    raise exception 'too_many_attempts';
  end if;
  select ep.* into v_row from employee_portal ep
  where lower(ep.email) = lower(p_email)
    and ep.password_hash is not null
    and ep.status = 'active'
    and crypt(p_pass, ep.password_hash) = ep.password_hash;
  if not found then
    if not exists (select 1 from employee_portal ep2
                    where lower(ep2.email) = lower(p_email) and ep2.password_hash is not null and ep2.status = 'active') then
      perform extensions.crypt(coalesce(p_pass, ''), extensions.gen_salt('bf', 10));
    end if;
    perform public._auth_fail(v_key, null, 'portal');
    return;
  end if;
  if not coalesce((select public.company_has_paid_features(e.company_id) from employees e where e.id = v_row.employee_id), false) then
    raise exception 'portal_plan_locked';
  end if;
  perform public._auth_clear(v_key);
  if v_row.password_hash ~ '^\$2[abxy]\$0' then
    update employee_portal ep set password_hash = extensions.crypt(p_pass, extensions.gen_salt('bf', 10)) where ep.id = v_row.id;
  end if;
  update employee_portal ep set last_login = now() where ep.id = v_row.id;
  v_session := public._issue_portal_session(v_row.id, v_row.employee_id);
  return query select v_row.id, v_row.employee_id, v_row.email, v_session;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- activate_employee_portal: bcrypt cost 10, minimum 8, not the email
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activate_employee_portal(p_token text, p_pass text)
 RETURNS TABLE(portal_id uuid, employee_id uuid, email text, session_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_row employee_portal%rowtype; v_session text;
begin
  select * into v_row from employee_portal
  where invite_token = p_token and invite_token is not null
    and status = 'invited' and (token_expires_at is null or token_expires_at > now());
  if not found then return; end if;
  if not coalesce((select public.company_has_paid_features(e.company_id) from employees e where e.id = v_row.employee_id), false) then
    raise exception 'portal_plan_locked';
  end if;
  if not public._password_ok(p_pass, v_row.email) then raise exception 'password_too_short'; end if;
  update employee_portal
  set password_hash = crypt(p_pass, gen_salt('bf', 10)),
      invite_token = null, token_expires_at = null, status = 'active', last_login = now()
  where id = v_row.id;
  v_session := public._issue_portal_session(v_row.id, v_row.employee_id);
  return query select v_row.id, v_row.employee_id, v_row.email, v_session;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- portal_reset_password: attempt cap (5 per code), consume the code, revoke portal sessions
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_reset_password(p_email text, p_code text, p_newpass text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_row    email_codes%rowtype;
  v_portal uuid;
begin
  if not public._password_ok(p_newpass, p_email) then
    return jsonb_build_object('ok', false, 'error', 'weak_password');
  end if;

  select * into v_row from email_codes
   where lower(email) = lower(p_email) and purpose = 'portal_reset'
     and consumed_at is null
   order by created_at desc limit 1
   for update;

  if v_row.id is null or v_row.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'bad_code');
  end if;
  if v_row.attempts >= 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;
  if extensions.crypt(coalesce(p_code, ''), v_row.code_hash) <> v_row.code_hash then
    update email_codes set attempts = attempts + 1 where id = v_row.id;
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

  update email_codes set consumed_at = now()
   where lower(email) = lower(p_email) and purpose = 'portal_reset' and consumed_at is null;

  delete from portal_sessions where portal_id = v_portal;
  perform public._auth_clear('p:' || lower(p_email));

  return jsonb_build_object('ok', true);
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- verify_code_and_reset: minimum 8, revoke admin sessions after a reset
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_code_and_reset(p_email text, p_code text, p_newpass text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_rec email_codes%ROWTYPE;
  v_admin_id uuid;
BEGIN
  IF NOT public._password_ok(p_newpass, p_email) THEN
    RETURN json_build_object('ok', false, 'error', 'weak_password');
  END IF;

  SELECT * INTO v_rec
  FROM email_codes
  WHERE lower(email) = lower(p_email) AND purpose = 'password_reset'
    AND consumed_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_rec.id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'no_code');
  END IF;
  IF v_rec.expires_at < now() THEN
    RETURN json_build_object('ok', false, 'error', 'expired');
  END IF;
  IF v_rec.attempts >= 5 THEN
    RETURN json_build_object('ok', false, 'error', 'too_many_attempts');
  END IF;

  IF extensions.crypt(coalesce(p_code, ''), v_rec.code_hash) <> v_rec.code_hash THEN
    UPDATE email_codes SET attempts = attempts + 1 WHERE id = v_rec.id;
    RETURN json_build_object('ok', false, 'error', 'bad_code');
  END IF;

  SELECT id INTO v_admin_id FROM admins WHERE lower(email)=lower(p_email) AND verified=true LIMIT 1;
  IF v_admin_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'no_account');
  END IF;

  UPDATE admins
     SET password = extensions.crypt(p_newpass, extensions.gen_salt('bf', 10))
   WHERE id = v_admin_id;

  UPDATE email_codes SET consumed_at = now() WHERE id = v_rec.id;

  DELETE FROM admin_sessions WHERE admin_id = v_admin_id;
  PERFORM public._auth_clear('a:' || lower(p_email));
  PERFORM public._auth_clear('id:' || v_admin_id::text);

  RETURN json_build_object('ok', true);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- activate_invited_admin: throttled by admin id, pending_invite only, minimum 8
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activate_invited_admin(p_id uuid, p_curpass text, p_newpass text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_status text; v_stored text; v_exp timestamptz; v_email text; v_key text;
begin
  if p_newpass is null or length(p_newpass) < 8 or length(p_newpass) > 128 or btrim(p_newpass) = '' then
    return json_build_object('ok', false, 'error', 'weak_password');
  end if;
  select a.status, a.password, a.expires_at, a.email into v_status, v_stored, v_exp, v_email
    from admins a where a.id = p_id for update;
  if v_status is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  -- Not pending: nothing to probe with, so no password check and nothing to throttle.
  if v_status <> 'pending_invite' then
    return json_build_object('ok', false, 'error', 'not_pending');
  end if;
  v_key := 'id:' || p_id::text;
  if public._auth_locked(v_key) then
    return json_build_object('ok', false, 'error', 'too_many_attempts');
  end if;
  -- Same answer for "wrong password" and "not pending".
  if p_curpass is null or extensions.crypt(p_curpass, v_stored) <> v_stored
     or (v_exp is not null and v_exp <= now()) then
    perform public._auth_fail(v_key, p_id, 'activate_invite');
    return json_build_object('ok', false, 'error', 'not_pending');
  end if;
  if not public._password_ok(p_newpass, v_email) then
    return json_build_object('ok', false, 'error', 'weak_password');
  end if;
  update admins
     set password = extensions.crypt(p_newpass, extensions.gen_salt('bf', 10)), status = 'active', verified = true
   where id = p_id;
  perform public._auth_clear(v_key);
  return json_build_object('ok', true);
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- change_own_password (NEW overload): session token + current password, throttled, minimum 8.
-- The old (uuid, text, text) overload is dropped by the follow-up migration.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_own_password(p_token text, p_curpass text, p_newpass text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_admin uuid; v_stored text; v_email text; v_key text;
BEGIN
  IF p_token IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'no_session');
  END IF;
  SELECT s.admin_id INTO v_admin FROM admin_sessions s WHERE s.token = p_token AND s.expires_at > now();
  IF v_admin IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'no_session');
  END IF;
  SELECT a.password, a.email INTO v_stored, v_email FROM admins a
   WHERE a.id = v_admin AND a.status IN ('active','pending_invite') FOR UPDATE;
  IF v_stored IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'no_session');
  END IF;
  IF NOT public._password_ok(p_newpass, v_email) THEN
    RETURN json_build_object('ok', false, 'error', 'weak_password');
  END IF;
  v_key := 'id:' || v_admin::text;
  IF public._auth_locked(v_key) THEN
    RETURN json_build_object('ok', false, 'error', 'too_many_attempts');
  END IF;
  -- A NULL current password must fail (crypt(NULL, ...) is NULL, which a plain <> lets through).
  IF extensions.crypt(coalesce(p_curpass, ''), v_stored) IS DISTINCT FROM v_stored THEN
    PERFORM public._auth_fail(v_key, v_admin, 'change_password');
    RETURN json_build_object('ok', false, 'error', 'wrong_current');
  END IF;
  PERFORM public._auth_clear(v_key);

  UPDATE admins SET password = extensions.crypt(p_newpass, extensions.gen_salt('bf', 10))
   WHERE id = v_admin;

  RETURN json_build_object('ok', true);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- superadmin_create_admin (NEW overload): authenticated by the super-admin SESSION TOKEN, role and
-- plan validated. Roles are the two the Super Admin screen offers; the old uuid overload is dropped
-- by the follow-up migration.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.superadmin_create_admin(p_token text, p_name text, p_email text, p_pass text, p_plan text, p_role text, p_expires timestamp with time zone)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_caller uuid; v_new_id uuid;
BEGIN
  v_caller := public._super_admin_id(p_token);
  IF v_caller IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'not_authorized');
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 OR p_email IS NULL OR length(trim(p_email)) = 0
     OR length(p_name) > 200 THEN
    RETURN json_build_object('ok', false, 'error', 'missing_fields');
  END IF;
  IF length(trim(p_email)) > 254 OR trim(p_email) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_email');
  END IF;
  IF NOT public._password_ok(p_pass, p_email) THEN
    RETURN json_build_object('ok', false, 'error', 'weak_password');
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'super_admin') THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_role');
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('free', 'starter', 'growth', 'business', 'unlimited') THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_plan');
  END IF;

  IF EXISTS (SELECT 1 FROM admins WHERE lower(email)=lower(trim(p_email))) THEN
    RETURN json_build_object('ok', false, 'error', 'email_taken');
  END IF;

  INSERT INTO admins (name, email, password, verified, role, plan, status, expires_at)
  VALUES (trim(p_name), lower(trim(p_email)),
          extensions.crypt(p_pass, extensions.gen_salt('bf', 10)),
          true, p_role, p_plan, 'active',
          CASE WHEN p_role = 'super_admin' THEN p_expires ELSE NULL END)
  RETURNING id INTO v_new_id;

  BEGIN
    INSERT INTO audit_log(admin_id, event, detail)
    VALUES (v_caller, 'admin_created', jsonb_build_object('new_admin_id', v_new_id, 'role', p_role, 'plan', p_plan));
  EXCEPTION WHEN others THEN NULL;
  END;

  RETURN json_build_object('ok', true, 'id', v_new_id);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- kiosk_device_checkin: validated device id, at most 50 devices per site, never un-revokes
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kiosk_device_checkin(p_site_id uuid, p_device_id text, p_user_agent text DEFAULT NULL::text, p_info jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_hdr json;
  v_ip text;
begin
  select s.company_id into v_company from sites s where s.id = p_site_id;
  if v_company is null then return; end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9_.:-]{8,64}$' then return; end if;

  -- A new device is refused once the site already lists 50; known devices keep checking in.
  if not exists (select 1 from kiosk_devices d where d.site_id = p_site_id and d.device_id = p_device_id)
     and (select count(*) from kiosk_devices d where d.site_id = p_site_id) >= 50 then
    return;
  end if;

  -- PostgREST exposes the inbound request headers; the first x-forwarded-for hop is the client.
  begin
    v_hdr := current_setting('request.headers', true)::json;
  exception when others then
    v_hdr := null;
  end;
  v_ip := nullif(trim(split_part(coalesce(v_hdr->>'cf-connecting-ip', v_hdr->>'x-forwarded-for', ''), ',', 1)), '');
  if v_ip is not null then v_ip := left(v_ip, 64); end if;

  insert into kiosk_devices (company_id, site_id, device_id, user_agent, ip_address, device_info)
  values (v_company, p_site_id, p_device_id, left(coalesce(p_user_agent,''), 200), v_ip,
          case when p_info is not null and jsonb_typeof(p_info) = 'object' and pg_column_size(p_info) < 2000 then p_info else null end)
  on conflict (site_id, device_id) do update
    set last_seen   = now(),
        user_agent  = excluded.user_agent,
        ip_address  = coalesce(excluded.ip_address, kiosk_devices.ip_address),
        device_info = coalesce(excluded.device_info, kiosk_devices.device_info);
        -- revoked is deliberately NOT touched: anyone holding the site id could otherwise un-revoke a
        -- device the owner removed.
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- portal_register_push_token: an existing token is never reassigned to another employee
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_register_push_token(p_session text, p_token text, p_platform text)
 RETURNS TABLE(ok boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_emp uuid;
  v_n integer;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return query select false; return;
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    return query select false; return;
  end if;
  if p_token is null or length(p_token) < 10 or length(p_token) > 300 then
    return query select false; return;
  end if;

  insert into employee_push_tokens (token, employee_id, platform, last_seen_at)
  values (p_token, v_emp, p_platform, now())
  on conflict (token) do update
    set platform = excluded.platform,
        last_seen_at = now()
    where employee_push_tokens.employee_id = excluded.employee_id;
  get diagnostics v_n = row_count;

  if v_n = 0 then
    return query select false; return;
  end if;
  return query select true;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Purge old attempt rows (they only matter for 15 minutes)
-- ---------------------------------------------------------------------------------------------
do $cron$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'purge-auth-attempts';
  perform cron.schedule('purge-auth-attempts', '*/30 * * * *',
    'delete from public.auth_attempts where at < now() - interval ''1 hour''');
end
$cron$;
