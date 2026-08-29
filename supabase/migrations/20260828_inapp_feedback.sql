-- The email churn survey drew one response from thirteen invites, and that response was the
-- owner's own test. Voice-of-customer is effectively zero. An in-app prompt asks at the moment
-- someone actually is in the product, which is the only moment they are demonstrably reachable.
alter table survey_responses add column if not exists source text;

-- survey_responses is RLS-on with no policies, so the app cannot insert directly. This resolves
-- the admin from their own session token — the caller supplies no identity — and rate-limits
-- itself so a prompt cannot be turned into a way to spam the table.
create or replace function submit_inapp_feedback(p_session text, p_reason text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin  uuid;
  v_email  text;
  v_co     text;
  v_recent int;
begin
  select s.admin_id into v_admin
    from admin_sessions s
   where s.token = p_session
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
$$;

grant execute on function submit_inapp_feedback(text, text, text) to anon, authenticated, service_role;
