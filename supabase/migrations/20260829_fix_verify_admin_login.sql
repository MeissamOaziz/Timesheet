-- Login was broken for ~21 hours by a column added two migrations earlier.
--
-- verify_admin_login declared `RETURNS SETOF admins`, so its result shape was the admins row
-- type. 20260828_owner_weekly_digest added weekly_digest and unsub_token, taking the table
-- from 25 columns to 27 while the function's explicit SELECT list still returned 25. Postgres
-- rejected every call with 42804 "structure of query does not match function result type",
-- and since this function IS the login check, nobody could sign in. The app surfaced the raw
-- database error on the sign-in screen.
--
-- Returning a named composite type is the trap here: the function compiles fine, the migration
-- that breaks it succeeds, and the failure only appears at call time — at the single worst
-- place in the product. The signature is now an explicit column list, so a future ALTER TABLE
-- on admins cannot break login.
--
-- Column types are read from information_schema, not assumed: invited_by is text (not uuid)
-- and invite_site_ids is uuid[] (not jsonb). Guessing those cost a second round trip.
--
-- password is still returned as NULL, and unsub_token is deliberately not returned at all —
-- the client has no use for it and it authorises an unauthenticated unsubscribe.
drop function if exists verify_admin_login(text, text);

create function verify_admin_login(p_email text, p_pass text)
returns table (
  id uuid, name text, email text, password text, verified boolean,
  created_at timestamptz, role text, plan text, status text, lang text,
  parent_admin_id uuid, invited_by text, expires_at timestamptz,
  stripe_customer_id text, stripe_subscription_id text, extra_seats integer,
  scheduling_addon boolean, last_login timestamptz, onboarding_emails_sent jsonb,
  first_name text, last_name text, invite_token text, invite_expires_at timestamptz,
  invite_used_at timestamptz, invite_site_ids uuid[], weekly_digest boolean
)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
BEGIN
  RETURN QUERY
  SELECT a.id, a.name, a.email, NULL::text AS password, a.verified, a.created_at, a.role,
         a.plan, a.status, a.lang, a.parent_admin_id, a.invited_by, a.expires_at,
         a.stripe_customer_id, a.stripe_subscription_id, a.extra_seats, a.scheduling_addon,
         a.last_login, a.onboarding_emails_sent, a.first_name, a.last_name, a.invite_token,
         a.invite_expires_at, a.invite_used_at, a.invite_site_ids, a.weekly_digest
  FROM admins a
  WHERE a.email = p_email
    AND a.password = crypt(p_pass, a.password)
    AND a.verified = true
    AND a.status IS DISTINCT FROM 'suspended';
END;
$function$;

grant execute on function verify_admin_login(text, text) to anon, authenticated, service_role;
