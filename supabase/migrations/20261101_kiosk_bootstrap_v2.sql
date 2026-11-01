-- Kiosk bootstrap without secrets (security audit 2026-11-01).
--
-- get_kiosk_bootstrap(p_site_id) is callable by anyone with the public key and returned whole rows:
-- every active employee's plaintext PIN and email, the company's admin_id, and the site's
-- access_code. The site id alone (printed in kiosk URLs and visible to the site's own staff) was
-- therefore enough to read every PIN at the site.
--
-- v2 returns the same shape with those columns removed; each employee carries has_pin / has_email
-- flags instead (the PIN itself is now checked by secure-db's kiosk_verify_pin action).
-- The old function stays in place, unchanged, until every terminal runs the new page; a later
-- migration (20261101_kiosk_bootstrap_v1_stripped) replaces its body with a call to v2.
create or replace function public.get_kiosk_bootstrap_v2(p_site_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_site sites%rowtype;
  v_co companies%rowtype;
  v_emps json;
begin
  select * into v_site from sites where id = p_site_id;
  if v_site.id is null then
    return json_build_object('ok', false, 'error', 'site_not_found');
  end if;
  select * into v_co from companies where id = v_site.company_id;
  select coalesce(json_agg(
           ((to_jsonb(e) - 'pin' - 'email')
            || jsonb_build_object('has_pin', coalesce(e.pin, '') <> '', 'has_email', coalesce(e.email, '') <> ''))
           order by e.name), '[]'::json)
    into v_emps
    from employees e
   where e.site_id = p_site_id and e.active = true;
  return json_build_object(
    'ok', true,
    'site', (to_jsonb(v_site) - 'access_code')::json,
    'company', (to_jsonb(v_co) - 'admin_id')::json,
    'employees', v_emps);
end;
$function$;

revoke all on function public.get_kiosk_bootstrap_v2(uuid) from public;
grant execute on function public.get_kiosk_bootstrap_v2(uuid) to anon, authenticated, service_role;
