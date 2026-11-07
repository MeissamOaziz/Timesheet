-- Signup source (marketing attribution), 2026-11-06.
-- Records how a new account found us: the utm_* tags of the link the visitor arrived with, the
-- domain (host only, never a path) of the site that referred them, and an optional answer to
-- "How did you hear about us?". Written once, at registration, by verify_code_and_register.
-- No new table, no new grant: browsers still cannot read or write admins directly, and secure-db's
-- SELF_ADMIN_FIELDS allowlist does not include these columns, so nobody can rewrite them later.
--
-- Rollout order: this migration first (the new parameters have defaults, so the current page keeps
-- working unchanged), then the page. The page also retries without the new parameters if the
-- database ever answers that the function signature is unknown.

ALTER TABLE public.admins
  ADD COLUMN IF NOT EXISTS signup_utm_source    text,
  ADD COLUMN IF NOT EXISTS signup_utm_medium    text,
  ADD COLUMN IF NOT EXISTS signup_utm_campaign  text,
  ADD COLUMN IF NOT EXISTS signup_utm_content   text,
  ADD COLUMN IF NOT EXISTS signup_referrer_host text,
  ADD COLUMN IF NOT EXISTS signup_heard         text;

-- Defence in depth: even a hand-made write can only store short, plain tokens.
ALTER TABLE public.admins
  ADD CONSTRAINT admins_signup_utm_shape CHECK (
        (signup_utm_source   IS NULL OR signup_utm_source   ~ '^[a-z0-9._-]{1,60}$')
    AND (signup_utm_medium   IS NULL OR signup_utm_medium   ~ '^[a-z0-9._-]{1,60}$')
    AND (signup_utm_campaign IS NULL OR signup_utm_campaign ~ '^[a-z0-9._-]{1,60}$')
    AND (signup_utm_content  IS NULL OR signup_utm_content  ~ '^[a-z0-9._-]{1,60}$')),
  ADD CONSTRAINT admins_signup_referrer_shape CHECK (
    signup_referrer_host IS NULL OR signup_referrer_host ~ '^[a-z0-9.-]{1,100}$'),
  ADD CONSTRAINT admins_signup_heard_values CHECK (
    signup_heard IS NULL OR signup_heard IN ('facebook','instagram','linkedin','google','friend','accountant','other'));

-- New parameters change the signature, so CREATE OR REPLACE cannot be used (42P13): drop and
-- recreate in the same transaction, then restore exactly the grants it had (anon, service_role).
DROP FUNCTION public.verify_code_and_register(text, text, text, text, text, text, text, text, text, text, text, date, boolean, text);

CREATE FUNCTION public.verify_code_and_register(
  p_email text, p_code text, p_newpass text, p_first_name text, p_last_name text,
  p_company_name text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_phone text DEFAULT NULL::text,
  p_industry text DEFAULT NULL::text, p_week_start text DEFAULT 'monday'::text,
  p_payroll_frequency text DEFAULT 'biweekly'::text, p_payroll_anchor_date date DEFAULT NULL::date,
  p_track_overtime boolean DEFAULT false, p_logo_url text DEFAULT NULL::text,
  p_signup_utm_source text DEFAULT NULL::text, p_signup_utm_medium text DEFAULT NULL::text,
  p_signup_utm_campaign text DEFAULT NULL::text, p_signup_utm_content text DEFAULT NULL::text,
  p_signup_referrer_host text DEFAULT NULL::text, p_signup_heard text DEFAULT NULL::text)
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

  -- Where the sign-up came from. Values are reduced to plain tokens here (whatever the page sent),
  -- and the write runs in its own sub-block: if it ever fails, the account is still created.
  IF coalesce(p_signup_utm_source, p_signup_utm_medium, p_signup_utm_campaign, p_signup_utm_content,
              p_signup_referrer_host, p_signup_heard) IS NOT NULL THEN
    BEGIN
      UPDATE admins SET
        signup_utm_source    = nullif(left(regexp_replace(lower(coalesce(p_signup_utm_source,   '')), '[^a-z0-9._-]', '', 'g'), 60), ''),
        signup_utm_medium    = nullif(left(regexp_replace(lower(coalesce(p_signup_utm_medium,   '')), '[^a-z0-9._-]', '', 'g'), 60), ''),
        signup_utm_campaign  = nullif(left(regexp_replace(lower(coalesce(p_signup_utm_campaign, '')), '[^a-z0-9._-]', '', 'g'), 60), ''),
        signup_utm_content   = nullif(left(regexp_replace(lower(coalesce(p_signup_utm_content,  '')), '[^a-z0-9._-]', '', 'g'), 60), ''),
        signup_referrer_host = nullif(left(regexp_replace(lower(coalesce(p_signup_referrer_host,'')), '[^a-z0-9.-]',  '', 'g'), 100), ''),
        signup_heard = CASE WHEN lower(p_signup_heard) IN ('facebook','instagram','linkedin','google','friend','accountant','other')
                            THEN lower(p_signup_heard) END
      WHERE id = v_new_id;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'signup source not recorded: %', SQLSTATE;
    END;
  END IF;

  UPDATE email_codes SET consumed_at = now() WHERE id = v_rec.id;

  RETURN json_build_object(
    'ok', true, 'id', v_new_id, 'name', v_name, 'email', lower(p_email),
    'company', CASE WHEN v_company.id IS NOT NULL THEN row_to_json(v_company) ELSE NULL END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_code_and_register(text, text, text, text, text, text, text, text, text, text, text, date, boolean, text, text, text, text, text, text, text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_code_and_register(text, text, text, text, text, text, text, text, text, text, text, date, boolean, text, text, text, text, text, text, text) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
