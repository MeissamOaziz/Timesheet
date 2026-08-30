-- 14-day free trial of the scheduling add-on.
--
-- Zero customers have ever created a shift. The add-on has only ever been sellable as a $14.95
-- charge against a feature nobody has used, so the trial exists to move the decision from "buy a
-- description" to "buy something you already ran for a week".
--
-- One column carries the whole state:
--   NULL                     never started — eligible
--   > now()                  trial running
--   <= now()                 trial used and finished — not eligible again
-- There is deliberately no "trial_started_at": the end date alone answers every question the
-- product asks, and one column cannot disagree with itself.
--
-- The end date is set by the server (start_scheduling_trial in secure-db), never by the client.
alter table admins add column if not exists scheduling_trial_ends_at timestamptz;

comment on column admins.scheduling_trial_ends_at is
  'End of the 14-day scheduling add-on trial. NULL = never started; past = used up. Server-set only.';

-- verify_admin_login returns an explicit column list precisely so that ALTER TABLE on admins
-- cannot break login again (see 20260829_fix_verify_admin_login.sql). Adding a column to admins
-- therefore does NOT require touching it — but the client needs this value at sign-in to know
-- whether the schedule page is unlocked, so it is added to the list deliberately.
drop function if exists verify_admin_login(text, text);

create function verify_admin_login(p_email text, p_pass text)
returns table (
  id uuid, name text, email text, password text, verified boolean,
  created_at timestamptz, role text, plan text, status text, lang text,
  parent_admin_id uuid, invited_by text, expires_at timestamptz,
  stripe_customer_id text, stripe_subscription_id text, extra_seats integer,
  scheduling_addon boolean, last_login timestamptz, onboarding_emails_sent jsonb,
  first_name text, last_name text, invite_token text, invite_expires_at timestamptz,
  invite_used_at timestamptz, invite_site_ids uuid[], weekly_digest boolean,
  scheduling_trial_ends_at timestamptz
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
         a.invite_expires_at, a.invite_used_at, a.invite_site_ids, a.weekly_digest,
         a.scheduling_trial_ends_at
  FROM admins a
  WHERE a.email = p_email
    AND a.password = crypt(p_pass, a.password)
    AND a.verified = true
    AND a.status IS DISTINCT FROM 'suspended';
END;
$function$;

grant execute on function verify_admin_login(text, text) to anon, authenticated, service_role;
