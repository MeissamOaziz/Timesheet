-- 2026-11-20: store only a SHA-256 of every admin and employee-portal session token.
--
-- Until now admin_sessions.token and portal_sessions.token held the live bearer tokens. Anyone who could read either
-- table (a read bug like the 2026-10-19 admin_sessions exposure, a leaked backup, a log of a query) could sign in as
-- anyone with a session. From now on the column holds encode(sha256(token), 'hex'); the browser and the phone apps keep
-- the raw token exactly as before, and every lookup hashes what it is given. Tokens are 32 random bytes, so a plain
-- SHA-256 is enough (no salt or slow hash needed: there is nothing to guess).
--
-- Order of release (no one is signed out, no window): 20261120_login_leak_grandfathered_session_lookup.sql created
-- _admin_session_lookup; secure-db, storage-upload and stripe-handler were deployed to use it; THIS migration then turns
-- every stored token into its hash and switches every lookup in one transaction.
--
-- Never run twice: a second run would hash the hashes and sign everyone out. The guard below refuses that.

CREATE OR REPLACE FUNCTION public._session_hash(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$function$;
REVOKE ALL ON FUNCTION public._session_hash(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._session_hash(text) TO service_role;

-- Marker so the conversion can never run twice.
CREATE TABLE IF NOT EXISTS public._migration_markers (name text PRIMARY KEY, done_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public._migration_markers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._migration_markers FROM PUBLIC, anon, authenticated;
GRANT ALL ON public._migration_markers TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public._migration_markers WHERE name = 'session_tokens_hashed') THEN
    RAISE EXCEPTION 'session tokens are already hashed; refusing to hash them again';
  END IF;
  UPDATE public.admin_sessions SET token = public._session_hash(token);
  UPDATE public.portal_sessions SET token = public._session_hash(token);
  INSERT INTO public._migration_markers(name) VALUES ('session_tokens_hashed');
END $$;

-- Issuing: the caller gets the raw token, the table keeps its hash.
CREATE OR REPLACE FUNCTION public._issue_admin_session(p_admin_id uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_token text;
BEGIN
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO admin_sessions(token, admin_id, expires_at)
  VALUES (public._session_hash(v_token), p_admin_id, now() + interval '30 days');
  RETURN v_token;
END;
$function$;

CREATE OR REPLACE FUNCTION public._issue_portal_session(p_portal_id uuid, p_employee_id uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_token text;
BEGIN
  v_token := encode(gen_random_bytes(32), 'hex');
  INSERT INTO portal_sessions(token, employee_id, portal_id, expires_at)
  VALUES (public._session_hash(v_token), p_employee_id, p_portal_id, now() + interval '30 days');
  RETURN v_token;
END;
$function$;

-- Lookups: hash what was given, compare with the stored hash.
CREATE OR REPLACE FUNCTION public._admin_session_lookup(p_token text)
 RETURNS TABLE(admin_id uuid, expires_at timestamp with time zone)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
  select s.admin_id, s.expires_at from public.admin_sessions s
   where p_token is not null and p_token <> '' and s.token = public._session_hash(p_token)
   limit 1
$function$;

CREATE OR REPLACE FUNCTION public._resolve_admin_push_session(p_session text)
 RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_admin uuid;
begin
  if p_session is null or btrim(p_session) = '' or p_session !~ '^[A-Za-z0-9_-]{16,128}$' then
    return null;
  end if;
  select s.admin_id into v_admin
    from admin_sessions s
    join admins a on a.id = s.admin_id
   where s.token = public._session_hash(p_session)
     and s.expires_at > now()
     and a.status = 'active'
     and (a.expires_at is null or a.expires_at > now());
  return v_admin;
end;
$function$;

CREATE OR REPLACE FUNCTION public._resolve_portal_session(p_token text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare v_emp uuid; v_hash text;
begin
  if p_token is null then return null; end if;
  v_hash := public._session_hash(p_token);
  select employee_id into v_emp from portal_sessions where token = v_hash and expires_at > now();
  if v_emp is null then return null; end if;
  if not exists (select 1 from employees e where e.id = v_emp and coalesce(e.active, true)) then
    return null;
  end if;
  if not coalesce((select public.company_has_paid_features(e.company_id) from employees e where e.id = v_emp), true) then
    return null;
  end if;
  update portal_sessions set last_seen_at = now() where token = v_hash;
  return v_emp;
end;
$function$;

CREATE OR REPLACE FUNCTION public._super_admin_id(p_token text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_admin_id uuid; v_exp timestamptz; v_role text; v_status text;
BEGIN
  IF p_token IS NULL THEN RETURN NULL; END IF;
  SELECT admin_id, expires_at INTO v_admin_id, v_exp FROM admin_sessions WHERE token = public._session_hash(p_token);
  IF v_admin_id IS NULL OR v_exp <= now() THEN RETURN NULL; END IF;
  SELECT role, status INTO v_role, v_status FROM admins WHERE id = v_admin_id;
  IF v_role = 'super_admin' AND v_status = 'active' THEN RETURN v_admin_id; END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_logout(p_token text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_admin_id uuid;
BEGIN
  IF p_token IS NOT NULL THEN
    SELECT admin_id INTO v_admin_id FROM admin_sessions WHERE token = public._session_hash(p_token);
    DELETE FROM admin_sessions WHERE token = public._session_hash(p_token);
    IF v_admin_id IS NOT NULL THEN
      BEGIN INSERT INTO audit_log(admin_id, event) VALUES (v_admin_id, 'logout'); EXCEPTION WHEN others THEN NULL; END;
    END IF;
  END IF;
  DELETE FROM admin_sessions WHERE expires_at < now();
  RETURN json_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.change_own_password(p_token text, p_curpass text, p_newpass text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_admin uuid; v_stored text; v_email text; v_key text;
BEGIN
  IF p_token IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'no_session');
  END IF;
  SELECT s.admin_id INTO v_admin FROM admin_sessions s WHERE s.token = public._session_hash(p_token) AND s.expires_at > now();
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

CREATE OR REPLACE FUNCTION public.portal_change_password(p_session text, p_curpass text, p_newpass text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
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
  delete from portal_sessions where portal_id = v_portal and token <> public._session_hash(p_session);
  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.portal_list_sessions(p_session text)
 RETURNS TABLE(session_id uuid, device_label text, platform text, app_version text, created_at timestamp with time zone, last_seen_at timestamp with time zone, is_current boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_emp uuid;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return;
  end if;
  return query
    select s.id, s.device_label, s.platform, s.app_version, s.created_at, s.last_seen_at, (s.token = public._session_hash(p_session))
      from portal_sessions s
     where s.employee_id = v_emp and s.expires_at > now()
     order by s.last_seen_at desc nulls last, s.created_at desc;
end;
$function$;

CREATE OR REPLACE FUNCTION public.portal_logout(p_session text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  DELETE FROM portal_sessions WHERE token = public._session_hash(p_session);
END;
$function$;

CREATE OR REPLACE FUNCTION public.portal_revoke_session(p_session text, p_session_id uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_emp uuid;
  v_n integer;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null or p_session_id is null then
    return false;
  end if;
  -- Only the caller's own other devices; signing out of this one is portal_logout.
  delete from portal_sessions s
   where s.id = p_session_id and s.employee_id = v_emp and s.token <> public._session_hash(p_session);
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$function$;

CREATE OR REPLACE FUNCTION public.portal_set_session_device(p_session text, p_label text, p_platform text, p_app_version text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_emp uuid;
  v_n integer;
begin
  v_emp := public._resolve_portal_session(p_session);
  if v_emp is null then
    return false;
  end if;
  update portal_sessions s
     set device_label = nullif(btrim(regexp_replace(left(coalesce(p_label, ''), 60), '[[:cntrl:]]', '', 'g')), ''),
         platform = case when p_platform in ('ios', 'android', 'web') then p_platform else null end,
         app_version = nullif(regexp_replace(left(coalesce(p_app_version, ''), 20), '[^0-9A-Za-z.\-]', '', 'g'), '')
   where s.token = public._session_hash(p_session) and s.employee_id = v_emp;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_inapp_feedback(p_session text, p_reason text, p_note text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_admin  uuid;
  v_email  text;
  v_co     text;
  v_recent int;
begin
  select s.admin_id into v_admin
    from admin_sessions s
   where s.token = public._session_hash(p_session)
     and (s.expires_at is null or s.expires_at > now());
  if v_admin is null then
    return jsonb_build_object('ok', false, 'error', 'no_session');
  end if;

  -- One stored answer per admin per 30 days, whatever the client does.
  select count(*) into v_recent from survey_responses
   where admin_id = v_admin and created_at > now() - interval '30 days';
  if v_recent > 0 then
    return jsonb_build_object('ok', true, 'skipped', 'already_answered');
  end if;

  select a.email into v_email from admins a where a.id = v_admin;
  select c.name  into v_co    from companies c where c.admin_id = v_admin order by c.created_at limit 1;

  insert into survey_responses (admin_id, email, company_name, reason, disliked, source)
  values (v_admin, v_email, v_co, left(coalesce(p_reason,''), 120), left(coalesce(p_note,''), 2000), 'in_app');

  return jsonb_build_object('ok', true);
end;
$function$;
