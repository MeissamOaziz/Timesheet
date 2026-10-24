-- Plan entitlements, one definition for the server side.
-- The pricing page promises certain things per plan; the browser already hides them, but the server jobs
-- (automated email reports) and the data itself must agree. Rules:
--   * Paid plans (starter, growth, business, unlimited) and the super admin: everything their tier lists.
--   * Free accounts get a preview of the paid features: until 14 days after the account was created, and
--     in any case until 2026-11-06 (the announced end of the preview for accounts that already exist).
--   * Lunch breaks and visitor check-in are Growth and up, and have no preview.
--   * Companies named in the grandfather list are unlimited, like the app does.
-- The same rule lives in index.html (featureEntitled): change both together.

create or replace function public.admin_plan_rank(p_admin uuid) returns int
language sql stable security definer set search_path = public as $$
  select case
    when a.role = 'super_admin' then 4
    else case coalesce(p.plan, a.plan, 'free')
      when 'unlimited' then 4 when 'business' then 3 when 'growth' then 2 when 'starter' then 1 else 0 end
  end
  from public.admins a
  left join public.admins p on p.id = a.parent_admin_id      -- a co-admin inherits the owner's plan
  where a.id = p_admin
$$;

create or replace function public.has_paid_features(p_admin uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select public.admin_plan_rank(a.id) >= 1
         or now() < greatest(coalesce(p.created_at, a.created_at) + interval '14 days', timestamptz '2026-11-06 00:00-05')
     from public.admins a
     left join public.admins p on p.id = a.parent_admin_id
     where a.id = p_admin),
    false)
$$;

create or replace function public.company_plan_rank(p_company uuid) returns int
language sql stable security definer set search_path = public as $$
  select case when c.name in ('Oaziz Extracts', 'Connoisseur Culture') then 4
              else coalesce(public.admin_plan_rank(c.admin_id), 0) end
  from public.companies c where c.id = p_company
$$;

create or replace function public.company_has_paid_features(p_company uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select c.name in ('Oaziz Extracts', 'Connoisseur Culture') or public.has_paid_features(c.admin_id)
     from public.companies c where c.id = p_company),
    false)
$$;

-- Switch off what an account is no longer entitled to. Safe to run any time; before 2026-11-06 it finds
-- nothing for Free accounts. Only settings are cleared, never data. Run daily.
create or replace function public.enforce_plan_features() returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_ot int; n_lunch int; n_visitor int; n_evening int;
begin
  update public.companies c set track_overtime = false
   where c.track_overtime and not public.company_has_paid_features(c.id);
  get diagnostics n_ot = row_count;

  update public.companies c set track_lunch_breaks = false
   where c.track_lunch_breaks and public.company_plan_rank(c.id) < 2;
  get diagnostics n_lunch = row_count;

  update public.companies c set visitor_checkin_enabled = false
   where c.visitor_checkin_enabled and public.company_plan_rank(c.id) < 2;
  get diagnostics n_visitor = row_count;

  update public.companies c set evening_start = null, evening_end = null, evening_days = null
   where c.evening_start is not null and not public.company_has_paid_features(c.id);
  get diagnostics n_evening = row_count;

  return jsonb_build_object('overtime_off', n_ot, 'lunch_off', n_lunch, 'visitor_off', n_visitor, 'evening_off', n_evening);
end $$;

revoke all on function public.admin_plan_rank(uuid), public.has_paid_features(uuid),
  public.company_plan_rank(uuid), public.company_has_paid_features(uuid), public.enforce_plan_features()
  from public, anon, authenticated;
grant execute on function public.admin_plan_rank(uuid), public.has_paid_features(uuid),
  public.company_plan_rank(uuid), public.company_has_paid_features(uuid), public.enforce_plan_features()
  to service_role;

select cron.schedule('enforce-plan-features-daily', '10 5 * * *', 'select public.enforce_plan_features()');
