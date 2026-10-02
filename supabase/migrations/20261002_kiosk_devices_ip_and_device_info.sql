-- Richer device identification for the "connected tablets" list: the public IP the check-in
-- arrived from, plus whatever the browser will tell us about the hardware (platform, model,
-- screen, touch). A user-agent alone cannot tell an Android tablet in "desktop site" mode from a
-- Linux PC -- both say "X11; Linux x86_64".
alter table kiosk_devices
  add column if not exists ip_address text,
  add column if not exists device_info jsonb;

-- Replace (not overload) the old 3-arg signature: two overloads that both accept 3 named args make
-- PostgREST reject the call as ambiguous. Old cached clients still work -- p_info defaults to null.
drop function if exists public.kiosk_device_checkin(uuid, text, text);

create or replace function public.kiosk_device_checkin(
  p_site_id uuid, p_device_id text, p_user_agent text default null, p_info jsonb default null
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company uuid;
  v_hdr json;
  v_ip text;
begin
  select company_id into v_company from sites where id = p_site_id;
  if v_company is null then return; end if;
  if p_device_id is null or length(p_device_id) < 8 or length(p_device_id) > 64 then return; end if;

  -- PostgREST exposes the inbound request headers; the first x-forwarded-for hop is the client.
  begin
    v_hdr := current_setting('request.headers', true)::json;
  exception when others then
    v_hdr := null;
  end;
  v_ip := nullif(trim(split_part(coalesce(v_hdr->>'cf-connecting-ip', v_hdr->>'x-forwarded-for', ''), ',', 1)), '');
  if v_ip is not null then v_ip := left(v_ip, 64); end if;

  insert into kiosk_devices (company_id, site_id, device_id, user_agent, ip_address, device_info)
  values (v_company, p_site_id, p_device_id, left(coalesce(p_user_agent,''), 200), v_ip,
          case when p_info is not null and pg_column_size(p_info) < 2000 then p_info else null end)
  on conflict (site_id, device_id) do update
    set last_seen   = now(),
        user_agent  = excluded.user_agent,
        ip_address  = coalesce(excluded.ip_address, kiosk_devices.ip_address),
        device_info = coalesce(excluded.device_info, kiosk_devices.device_info),
        -- "Unlink" promises the tablet reappears once it opens the kiosk link again; without
        -- this an unlinked tablet kept checking in forever while staying hidden from the list.
        revoked     = false;
end;
$function$;

grant execute on function public.kiosk_device_checkin(uuid, text, text, jsonb) to anon, authenticated, service_role;
