-- AI connector (Claude / ChatGPT), step 4: cancel connections automatically. 2026-11-12.
--
-- What this adds
--   One trigger on public.admins. When a person's password changes (changed by them, reset by e-mail code, set on
--   invitation), when a person stops being active (suspended, demoted), or when the account owner's
--   "Allow AI apps" switch goes from on to off, their AI connections are cancelled on the spot:
--     mcp_grants    marked revoked, with the reason
--     mcp_tokens    deleted (so the very next call from Claude or ChatGPT is refused)
--     mcp_auth_codes deleted (a sign-in that was half way through cannot finish)
--   Switching "Allow AI apps" off cancels the connections of everyone on the account (owner, co-admins, managers).
--
-- Why a trigger and not code in secure-db
--   Passwords are changed by database functions the pages call directly (change_own_password, verify_code_and_reset,
--   activate_invited_admin, ...), never through secure-db. A trigger covers every one of them, and anything done by
--   hand in the SQL editor too.
--
-- What it must never do
--   Break a password change. The body is wrapped: if cancelling fails for any reason, the password change (or the
--   suspension) still goes through and a row `mcp_revoke_failed` is written to audit_log. The mcp function also
--   re-checks the person and the owner's switch on every call, so a missed cancel is not a way in after a
--   suspension or a switch-off.
--
-- It fires only when a statement sets password, status or ai_apps_enabled, and only when the value really changed
-- in one of the three ways above. The login that updates last_login does not touch it.
--
-- ROLLBACK
--   drop trigger if exists mcp_revoke_on_admin_change on public.admins;
--   drop function if exists public.trg_mcp_revoke_on_admin_change();

create or replace function public.trg_mcp_revoke_on_admin_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_reason text;
  v_ids uuid[];
begin
  if new.password is distinct from old.password then
    v_reason := 'password_change';
    v_ids := array[new.id];
  elsif new.status is distinct from old.status and new.status is distinct from 'active' then
    v_reason := 'deactivated';
    v_ids := array[new.id];
  elsif old.ai_apps_enabled and not new.ai_apps_enabled then
    v_reason := 'ai_apps_off';
    select array_agg(a.id) into v_ids from public.admins a where a.id = new.id or a.parent_admin_id = new.id;
  else
    return null;
  end if;

  begin
    update public.mcp_grants
       set revoked_at = now(), revoked_reason = v_reason
     where admin_id = any(v_ids) and revoked_at is null;
    delete from public.mcp_tokens t using public.mcp_grants gr
     where t.grant_id = gr.id and gr.admin_id = any(v_ids);
    delete from public.mcp_auth_codes where admin_id = any(v_ids);
  exception when others then
    begin
      insert into public.audit_log(admin_id, event, table_name, filter)
      values (new.id, 'mcp_revoke_failed', 'mcp_grants', v_reason);
    exception when others then null;
    end;
  end;
  return null;
end;
$fn$;

comment on function public.trg_mcp_revoke_on_admin_change() is
  'AI connector: cancels a person''s Claude / ChatGPT connections when their password changes or they stop being active, and a whole account''s when the owner switches "Allow AI apps" off. Never blocks the change itself.';

-- A trigger function is not callable through the API, but the house rule is explicit: nothing for the browser roles.
revoke all on function public.trg_mcp_revoke_on_admin_change() from public, anon, authenticated;

drop trigger if exists mcp_revoke_on_admin_change on public.admins;
create trigger mcp_revoke_on_admin_change
  after update of password, status, ai_apps_enabled on public.admins
  for each row
  when (old.password is distinct from new.password
     or old.status is distinct from new.status
     or old.ai_apps_enabled is distinct from new.ai_apps_enabled)
  execute function public.trg_mcp_revoke_on_admin_change();
