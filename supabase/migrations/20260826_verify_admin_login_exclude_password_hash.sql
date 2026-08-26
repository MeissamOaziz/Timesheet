-- verify_admin_login previously did `SELECT * FROM admins`, which sent the bcrypt
-- password hash to the browser on every successful login. The client never used that
-- field. This nulls it out in the returned row instead of removing it from the RETURNS
-- SETOF admins type, so no client-side shape changes are needed.
CREATE OR REPLACE FUNCTION public.verify_admin_login(p_email text, p_pass text)
RETURNS SETOF admins
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  RETURN QUERY
  SELECT id, name, email, NULL::text AS password, verified, created_at, role, plan, status, lang,
         parent_admin_id, invited_by, expires_at, stripe_customer_id, stripe_subscription_id,
         extra_seats, scheduling_addon, last_login, onboarding_emails_sent, first_name, last_name,
         invite_token, invite_expires_at, invite_used_at, invite_site_ids
  FROM admins
  WHERE email = p_email
    AND password = crypt(p_pass, password)
    AND verified = true
    AND status IS DISTINCT FROM 'suspended';
END;
$function$;
