-- 2026-11-01  Second half of the credential hardening: retire the old, uuid-keyed entry points.
-- Apply ONLY after the index.html that calls the token-keyed overloads is live
-- (20261101_credential_hardening.sql added them).
--
--  * superadmin_create_admin(uuid, ...) trusted a bare admin uuid as the credential.
--  * change_own_password(uuid, text, text) trusted a bare admin uuid and let a NULL current password through.
--  * verify_employee_login(text, text) has no caller anywhere (portal_login is the live path) and was an
--    unthrottled password oracle reachable with the anon key.

DROP FUNCTION IF EXISTS public.superadmin_create_admin(uuid, text, text, text, text, text, timestamp with time zone);
DROP FUNCTION IF EXISTS public.change_own_password(uuid, text, text);
REVOKE ALL ON FUNCTION public.verify_employee_login(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_employee_login(text, text) TO service_role;
