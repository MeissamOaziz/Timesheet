-- 2026-11-20, three security fixes that need no client change.
--
-- 1. verify_admin_login still returned the account's invite_token to whoever signed in (the password column was
--    already blanked). Same columns, invite_token now always NULL: no page reads it from the login answer.
--
-- 2. "Grandfathered" companies were recognised by NAME (two names hard-coded here, in secure-db, index.html and mcp).
--    Anyone could name a company the same and get every feature, and the names sat in the public repo. Their owners
--    now carry the 'unlimited' plan instead (rank 4, no caps: exactly what the name check gave them), and the name
--    check is gone from the database. The edge functions and the website drop their lists in the same release.
--
-- 3. _admin_session_lookup: the one place edge functions (secure-db, storage-upload, stripe-handler) resolve an admin
--    session token. Today it compares the raw token, like their old REST query did. The follow-up migration
--    (20261120_hash_session_tokens.sql) stores only a SHA-256 of each token and switches this function, and every
--    other session lookup, to compare hashes, in one transaction, so nobody is signed out and no window opens.

-- 1 ------------------------------------------------------------------------------------------------------------
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
         a.last_login, a.onboarding_emails_sent, a.first_name, a.last_name, NULL::text AS invite_token,
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

-- 2 ------------------------------------------------------------------------------------------------------------
-- The two grandfathered owners (both comped, no Stripe subscription) were moved to plan 'unlimited' with a guarded
-- UPDATE (only rows still on 'business', no subscription, no parent). Their account ids are customer data and are kept
-- out of this public repo; the exact statement as applied is in supabase_migrations.schema_migrations (version 20261120203939).

CREATE OR REPLACE FUNCTION public.company_has_paid_features(p_company uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select public.has_paid_features(c.admin_id) from public.companies c where c.id = p_company),
    false)
$function$;

CREATE OR REPLACE FUNCTION public.company_plan_rank(p_company uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public.admin_plan_rank(c.admin_id), 0)
  from public.companies c where c.id = p_company
$function$;

-- 3 ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._admin_session_lookup(p_token text)
 RETURNS TABLE(admin_id uuid, expires_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  select s.admin_id, s.expires_at from public.admin_sessions s
   where p_token is not null and p_token <> '' and s.token = p_token
   limit 1
$function$;
REVOKE ALL ON FUNCTION public._admin_session_lookup(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_session_lookup(text) TO service_role;
