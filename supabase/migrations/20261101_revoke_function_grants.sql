-- Finding 7 (database audit 2026-11-01): narrow EXECUTE on public functions to what the browser calls.
-- The ONLY public functions the apps call with the anon key are the ones in tools/secure-db-regression/anon-function-allowlist.txt
-- (grep of index.html and employee.html for rpc('...')). Everything else (internal helpers, cron-only functions,
-- trigger functions, set_*_password, issue_email_code, ...) is executable by service_role and postgres only.
-- authenticated gets nothing: GoTrue is unused and every browser call carries the anon key.
-- Not allowlisted any more (no caller anywhere in the repo): accept_invite, lookup_invite, portal_get_sites,
-- portal_register_push_token. The last two belong to the planned mobile app: when it ships, grant them on purpose
-- (grant execute on function public.portal_get_sites(text) to anon; ...) and add them to the allowlist file.
--
-- ROLLBACK (restores the exact previous anon/authenticated grants; the 4 above plus the trigger function were anon-executable):
--   do $r$ declare n text; begin
--     foreach n in array array['accept_invitation','accept_invite','activate_employee_portal','activate_invited_admin','admin_delete_survey','admin_list_surveys','admin_logout','admin_set_survey_status','change_own_password','check_email_code','employee_portal_lowercase_email','get_invitation','get_kiosk_bootstrap','get_kiosk_bootstrap_v2','get_portal_invite','get_survey_invite','kiosk_device_checkin','lookup_invite','mint_admin_session','portal_add_availability','portal_cancel_time_off','portal_change_password','portal_delete_availability','portal_get_availability','portal_get_company_payroll','portal_get_me','portal_get_punch_labels','portal_get_punches','portal_get_schedule_status','portal_get_shifts','portal_get_sites','portal_get_team_shifts','portal_get_time_off','portal_login','portal_logout','portal_punch','portal_register_push_token','portal_request_time_off','portal_reset_password','submit_inapp_feedback','submit_survey_response','superadmin_create_admin','unsubscribe_weekly_digest','verify_admin_login','verify_code_and_register','verify_code_and_reset'] loop
--       execute (select string_agg(format('grant execute on function %s to anon, authenticated', p.oid::regprocedure), '; ') from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=n);
--     end loop; end $r$;
--   alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;
--   alter default privileges for role postgres grant execute on functions to public;

do $mig$
declare
  allow text[] := array[
    'accept_invitation','activate_employee_portal','activate_invited_admin','admin_delete_survey','admin_list_surveys',
    'admin_logout','admin_set_survey_status','change_own_password','check_email_code','get_invitation',
    'get_kiosk_bootstrap','get_kiosk_bootstrap_v2','get_portal_invite','get_survey_invite','kiosk_device_checkin',
    'mint_admin_session','portal_add_availability','portal_cancel_time_off','portal_change_password',
    'portal_delete_availability','portal_get_availability','portal_get_company_payroll','portal_get_me',
    'portal_get_punch_labels','portal_get_punches','portal_get_schedule_status','portal_get_shifts',
    'portal_get_team_shifts','portal_get_time_off','portal_login','portal_logout','portal_punch',
    'portal_request_time_off','portal_reset_password','submit_inapp_feedback','submit_survey_response',
    'superadmin_create_admin','unsubscribe_weekly_digest','verify_admin_login','verify_code_and_register',
    'verify_code_and_reset'];
  r record;
  n_allowed int := 0;
begin
  revoke all on all functions in schema public from public, anon, authenticated;
  grant execute on all functions in schema public to service_role, postgres;
  for r in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any(allow) loop
    execute format('grant execute on function %s to anon', r.oid::regprocedure);
    n_allowed := n_allowed + 1;
  end loop;
  raise notice 'anon keeps execute on % functions (allowlist has % names)', n_allowed, array_length(allow, 1);
end
$mig$;

-- Future functions created by postgres are closed by default (no PUBLIC, anon or authenticated execute); service_role
-- keeps the default grant. Grant a new browser-callable function to anon on purpose and add it to the allowlist file.
-- The global form (no IN SCHEMA) is required to remove the implicit PUBLIC execute that Postgres gives every new function.
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;
