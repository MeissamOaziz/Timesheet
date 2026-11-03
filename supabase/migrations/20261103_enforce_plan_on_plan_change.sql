-- Plan changes now take effect at once.
-- enforce_plan_features() (hourly cron, minute 10) switches off geofences, remote clock-in, overtime and evening hours
-- of accounts without paid features and restores the saved geofence / remote settings of accounts that have them
-- again. After a Stripe upgrade the customer used to wait for the next :10. This trigger runs the same function
-- whenever admins.plan changes (upgrade restores at once, a cancellation locks at once).
-- A failure inside enforce_plan_features must never block the plan update itself (the billing webhook), so the
-- call is wrapped and only logs a warning. The hourly cron remains the safety net.
create or replace function public.trg_enforce_after_plan_change() returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  begin
    perform public.enforce_plan_features();
  exception when others then
    raise warning 'enforce_plan_features after plan change failed: %', sqlerrm;
  end;
  return null;
end
$function$;

revoke all on function public.trg_enforce_after_plan_change() from public, anon, authenticated;

drop trigger if exists enforce_after_plan_change on public.admins;
create trigger enforce_after_plan_change
  after update of plan on public.admins
  for each row when (old.plan is distinct from new.plan)
  execute function public.trg_enforce_after_plan_change();
