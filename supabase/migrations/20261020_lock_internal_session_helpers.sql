-- Internal helpers were callable through the public API with the anon key.
--
-- _issue_admin_session(p_admin_id) inserts a 30-day admin session for any admin id and returns the
-- token, with no check of who is asking. With the public anon key (it is in index.html) and an admin's
-- id, anyone could have signed in as that admin. _super_admin_id and generate_invite_token are the same
-- kind of internal helper. Nothing in the app or in the edge functions calls any of them: only other
-- SECURITY DEFINER functions (mint_admin_session, admin_*_survey) do, and those run as the table owner,
-- so they keep working without any grant to anon / authenticated.
--
-- Found during the Supabase "new public tables need grants from Oct 30" audit (2026-10-20).

revoke all on function public._issue_admin_session(uuid) from public, anon, authenticated;
revoke all on function public._super_admin_id(text)      from public, anon, authenticated;
revoke all on function public.generate_invite_token()    from public, anon, authenticated;

grant execute on function public._issue_admin_session(uuid) to service_role;
grant execute on function public._super_admin_id(text)      to service_role;
grant execute on function public.generate_invite_token()    to service_role;
