-- Minimum-version gate for the PunchClock Crew Admin phone app (the employee app has had portal_app_config since
-- 2026-11-04). The app asks before it shows anything; when its version is below the minimum it shows "Update
-- needed" and nothing else. This lets a build with a security problem be retired without waiting for people to
-- update by themselves.
--
-- No session: the answer holds nothing private (a version string and a yes/no). The minimum lives in
-- internal_secrets under 'min_admin_app_version'; with no row the minimum is 0.0.0 and nobody is blocked.
-- A missing or malformed version never locks anyone out (see _app_version_lt).
--
-- To retire builds below 1.0.1 later:
--   insert into internal_secrets(key, value) values ('min_admin_app_version', '1.0.1')
--   on conflict (key) do update set value = excluded.value;

create or replace function public.admin_app_config(p_platform text, p_version text)
returns table(min_version text, update_required boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_min text;
begin
  select s.value into v_min from internal_secrets s where s.key = 'min_admin_app_version';
  v_min := coalesce(nullif(v_min, ''), '0.0.0');
  return query select v_min, public._app_version_lt(left(p_version, 20), v_min);
end;
$$;

revoke all on function public.admin_app_config(text, text) from public;
revoke all on function public.admin_app_config(text, text) from authenticated;
grant execute on function public.admin_app_config(text, text) to anon, service_role;
