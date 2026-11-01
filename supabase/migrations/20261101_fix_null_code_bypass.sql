-- 2026-11-01  CRITICAL hotfix: a NULL code skipped the code check in four anon-callable functions.
--
-- `crypt(p_code, hash) <> hash` is NULL (not true) when p_code is NULL, and `IF NULL` falls through, so
-- `{"p_code": null}` was accepted as a valid code. Anyone could request a reset/registration code for
-- any email (the request itself is public and only rate limited) and then call
-- verify_code_and_reset(email, null, newpass) to set that admin's password without ever seeing the code.
-- The same hole existed in check_email_code, verify_code_and_register and portal_reset_password.
--
-- Fix: compare with coalesce(p_code,'') so a missing code is just a wrong code (and counts as an attempt).
-- Bodies are the live ones (pg_get_functiondef) with only the comparison changed; response shapes
-- are identical. portal_reset_password also keeps its old behaviour otherwise; its attempt cap and the
-- rest follow in 20261101_credential_hardening.sql.

CREATE OR REPLACE FUNCTION public.check_email_code(p_email text, p_code text, p_purpose text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_rec email_codes%ROWTYPE;
BEGIN
  IF p_purpose NOT IN ('password_reset','registration') THEN
    RETURN json_build_object('ok', false, 'error', 'bad_purpose');
  END IF;

  SELECT * INTO v_rec
  FROM email_codes
  WHERE lower(email) = lower(p_email) AND purpose = p_purpose
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

  -- Valid, but DO NOT consume — the actual reset/registration step consumes it.
  RETURN json_build_object('ok', true);
END;
$function$;

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
  IF p_newpass IS NULL OR length(p_newpass) < 6 THEN
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

  RETURN json_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_code_and_register(p_email text, p_code text, p_newpass text, p_first_name text, p_last_name text, p_company_name text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_industry text DEFAULT NULL::text, p_week_start text DEFAULT 'monday'::text, p_payroll_frequency text DEFAULT 'biweekly'::text, p_payroll_anchor_date date DEFAULT NULL::date, p_track_overtime boolean DEFAULT false, p_logo_url text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_rec email_codes%ROWTYPE;
  v_new_id uuid;
  v_name text;
  v_company companies%ROWTYPE;
BEGIN
  IF p_newpass IS NULL OR length(p_newpass) < 6 THEN
    RETURN json_build_object('ok', false, 'error', 'weak_password');
  END IF;
  IF p_first_name IS NULL OR length(trim(p_first_name)) = 0
     OR p_last_name IS NULL OR length(trim(p_last_name)) = 0 THEN
    RETURN json_build_object('ok', false, 'error', 'missing_name');
  END IF;

  -- Validate the registration code (hashed, unexpired, unconsumed, attempt-limited)
  SELECT * INTO v_rec
  FROM email_codes
  WHERE lower(email) = lower(p_email) AND purpose = 'registration'
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

  -- Race/duplicate guard: email must not already be a registered admin
  IF EXISTS (SELECT 1 FROM admins WHERE lower(email) = lower(p_email)) THEN
    UPDATE email_codes SET consumed_at = now() WHERE id = v_rec.id;
    RETURN json_build_object('ok', false, 'error', 'email_taken');
  END IF;

  v_name := trim(p_first_name) || ' ' || trim(p_last_name);

  INSERT INTO admins (name, first_name, last_name, email, password, verified, role, plan, status)
  VALUES (
    v_name, trim(p_first_name), trim(p_last_name), lower(p_email),
    extensions.crypt(p_newpass, extensions.gen_salt('bf', 10)),
    true, 'admin', 'free', 'active'
  )
  RETURNING id INTO v_new_id;

  -- Create the company atomically (replaces the former anonymous client-side insert).
  IF p_company_name IS NOT NULL AND length(trim(p_company_name)) > 0 THEN
    INSERT INTO companies (name, address, phone, industry, week_start,
                           payroll_frequency, payroll_anchor_date, track_overtime, logo_url, admin_id)
    VALUES (trim(p_company_name), p_address, p_phone, p_industry,
            coalesce(p_week_start, 'monday'), coalesce(p_payroll_frequency, 'biweekly'),
            p_payroll_anchor_date, coalesce(p_track_overtime, false), p_logo_url, v_new_id)
    RETURNING * INTO v_company;
  END IF;

  UPDATE email_codes SET consumed_at = now() WHERE id = v_rec.id;

  RETURN json_build_object(
    'ok', true, 'id', v_new_id, 'name', v_name, 'email', lower(p_email),
    'company', CASE WHEN v_company.id IS NOT NULL THEN row_to_json(v_company) ELSE NULL END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.portal_reset_password(p_email text, p_code text, p_newpass text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_row   record;
  v_portal uuid;
begin
  if length(coalesce(p_newpass,'')) < 6 then
    return jsonb_build_object('ok', false, 'error', 'weak_password');
  end if;

  select * into v_row from email_codes
   where lower(email) = lower(p_email) and purpose = 'portal_reset'
   order by created_at desc limit 1;

  if v_row is null or v_row.expires_at < now()
     or v_row.code_hash <> extensions.crypt(coalesce(p_code, ''), v_row.code_hash) then
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

  delete from email_codes where lower(email) = lower(p_email) and purpose = 'portal_reset';

  return jsonb_build_object('ok', true);
end;
$function$;
