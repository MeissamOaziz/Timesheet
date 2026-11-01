-- The original kiosk bootstrap now returns the PIN-free shape (security audit 2026-11-01).
--
-- Every terminal has moved to get_kiosk_bootstrap_v2 (20261101_kiosk_bootstrap_v2.sql). The original
-- function stays callable, so a terminal that has not reloaded yet still gets its employee list, but it
-- no longer returns PINs, employee emails, the company's admin_id or the site's access_code.
create or replace function public.get_kiosk_bootstrap(p_site_id uuid)
returns json
language sql
security definer
set search_path to 'public', 'extensions'
as $function$
  select public.get_kiosk_bootstrap_v2(p_site_id);
$function$;

revoke all on function public.get_kiosk_bootstrap(uuid) from public;
grant execute on function public.get_kiosk_bootstrap(uuid) to anon, authenticated, service_role;
