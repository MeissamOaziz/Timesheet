-- Tighten the trusted window for a phone's own punch time (set to 72h in
-- 20261015_portal_punch_late_sync_window_72h.sql) down to 48 hours. 48h still covers the 22-hour
-- offline stretch that caused the Thrive Medical overcount on 2026-10-14, while limiting how far
-- back a phone clock can place a punch. Only the interval literal in portal_punch changes.
do $mig$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'portal_punch';
  if v_def is null or position('interval ''72 hours''' in v_def) = 0 then
    raise exception 'portal_punch not in the expected 72h state';
  end if;
  execute replace(v_def, 'interval ''72 hours''', 'interval ''48 hours''');
end
$mig$;
