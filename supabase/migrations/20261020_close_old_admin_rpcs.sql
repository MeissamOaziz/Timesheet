-- Follow-up to 20261020_activate_invited_admin_needs_temp_password and the secure-db demote_manager action.
-- The app that calls the new paths is live, so the old open ones can go.
--
-- activate_invited_admin(uuid, text): set a pending-invite admin's password knowing only its id.
-- demote_manager_to_employee(uuid, uuid): trusted a caller id sent by the browser. It is now reached only
-- through secure-db, which takes the caller from the admin session and calls it with the service key.

drop function if exists public.activate_invited_admin(uuid, text);

revoke all on function public.demote_manager_to_employee(uuid, uuid) from public, anon, authenticated;
grant execute on function public.demote_manager_to_employee(uuid, uuid) to service_role;
