-- Strict location means strict for the phone app too.
--
-- Before: at a site with geo_strict, portal_punch refused a punch without a location only when the client gave no
-- reason. The employee app always sends one (denied | unavailable | timeout), so an employee who switched location
-- off could still clock in, flagged no_location. The web portal sends no reason and was already refused.
--
-- Now: at a strict site a LIVE punch without a location is refused (location_required) whatever the reason. The
-- employee is there and can fix it (allow location, step outside, retry). Only a late sync (an offline punch that
-- arrives more than 2 minutes after it was made) is still kept and flagged no_location[:reason], because the work
-- already happened and the punch cannot be asked again.
--
-- Nothing else changes: lenient sites, sites without geolocation, the distance rule, labels, duplicates.
--
-- The function is 280 lines; rather than repeat it, this replaces the one condition in the stored definition, and
-- refuses to run unless the definition is exactly the one created by 20261104_punch_duplicate_guard_and_geo_note.sql.
-- CREATE OR REPLACE keeps the grants (anon + service_role only).

do $mig$
declare
  v_proc regprocedure := 'public.portal_punch(text,text,uuid,date,text,timestamptz,double precision,double precision,double precision,uuid,uuid,bigint,text,bigint,text,text)'::regprocedure;
  v_def text;
  v_old_txt text := 'if v_reason is not null or v_synced_late then';
  v_new_txt text := 'if v_synced_late then  -- strict: a live punch needs a location whatever the reason given; only a late (offline) sync is kept, flagged';
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = v_proc) <> 'ebf508a028d57ef7f47b288e4229817b' then
    raise exception 'portal_punch is not the 20261104 version; rewrite this migration against the current definition';
  end if;
  v_def := pg_get_functiondef(v_proc);
  if (length(v_def) - length(replace(v_def, v_old_txt, ''))) / length(v_old_txt) <> 1 then
    raise exception 'expected the strict no-location condition exactly once';
  end if;
  execute replace(v_def, v_old_txt, v_new_txt);
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = v_proc) <> '0e573bae921b1ea551dfc56fcd71de64' then
    raise exception 'portal_punch after the change is not the expected definition';
  end if;
  if has_function_privilege('authenticated', v_proc, 'execute') or not has_function_privilege('anon', v_proc, 'execute') then
    raise exception 'portal_punch grants changed';
  end if;
end
$mig$;
