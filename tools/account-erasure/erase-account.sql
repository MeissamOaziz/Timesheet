-- Erase one PunchClock Pro account and everything tied to it (Law 25 / customer deletion request).
-- Run it in the Supabase dashboard > SQL editor, project uziwymrwaeojhqaagqcm.
--
--   1. Set v_admin and v_email below (the account owner's admin id and sign-in email).
--   2. Run it as is: v_dry is true, so it shows what WOULD be deleted, checks that nothing would be
--      left behind, and then rolls everything back. Read the message it prints.
--   3. Change v_dry to false and run it again to delete for real. It is one transaction: if any check
--      fails nothing is deleted.
--   4. Delete the company logo from Storage by hand (Storage > logos): SQL cannot remove the file.
--
-- It refuses to run when the account has Stripe billing (cancel the subscription first), co-admins or
-- managers under it, or is not an account owner. The app's own "Delete admin" button is NOT enough for a
-- data request: it keeps the employees as orphaned rows.
do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-000000000000';   -- <- admins.id of the account owner
  v_email text := 'owner@example.com';                       -- <- their sign-in email
  v_dry   boolean := true;                                   -- <- false = really delete
  a admins%rowtype;
  co uuid[]; em uuid[];
  n_punch int; n_arch int; n_vis int; n_emp int; n_co int; n_left int;
  summary text;
begin
  select * into a from admins where id = v_admin;
  if not found then raise exception 'No admin with that id'; end if;
  if lower(a.email) <> lower(v_email) then raise exception 'The email on that admin (%) does not match %', a.email, v_email; end if;
  if a.parent_admin_id is not null then raise exception 'This is a co-admin/manager, not an account owner'; end if;
  if a.stripe_customer_id is not null or a.stripe_subscription_id is not null then
    raise exception 'This account has Stripe billing. Cancel the subscription and delete the customer in Stripe first';
  end if;
  if exists (select 1 from admins where parent_admin_id = v_admin) then
    raise exception 'This account has co-admins or managers under it. Decide what happens to them first';
  end if;

  select coalesce(array_agg(id), '{}') into co from companies where admin_id = v_admin;
  select coalesce(array_agg(id), '{}') into em from employees where company_id = any(co);

  select count(*) into n_punch from punches where company_id = any(co);
  select count(*) into n_arch  from punches_archive where company_id = any(co);
  select count(*) into n_vis   from visitors where company_id = any(co);
  n_emp := coalesce(array_length(em, 1), 0);
  n_co  := coalesce(array_length(co, 1), 0);

  -- Tables with no foreign key, or a "no action" one, are cleared explicitly first.
  delete from punches            where company_id = any(co) or emp_id = any(em);
  delete from punches_archive    where company_id = any(co) or emp_id = any(em);
  delete from visitors_archive   where company_id = any(co);
  delete from sent_alerts        where company_id = any(co) or emp_id = any(em);
  delete from join_requests      where requester_id = v_admin or target_admin_id = v_admin;
  delete from survey_responses   where admin_id = v_admin or lower(email) = lower(v_email);
  delete from survey_invites     where admin_id = v_admin or lower(email) = lower(v_email);
  delete from email_codes        where lower(email) = lower(v_email);
  delete from audit_log          where admin_id = v_admin;
  -- Everything else hangs off the company / employee / admin and goes with them (ON DELETE CASCADE):
  -- sites, employees, portal accounts and sessions, push tokens, shifts, time off, availability, holidays,
  -- work labels, kiosk devices, missed-punch requests, report recipients, visitors, invitations, sessions.
  delete from companies where id = any(co);
  delete from admins    where id = v_admin;

  -- Proof that nothing is left.
  select (select count(*) from admins where id = v_admin)
       + (select count(*) from companies where admin_id = v_admin)
       + (select count(*) from employees where id = any(em))
       + (select count(*) from punches where company_id = any(co))
       + (select count(*) from sites where company_id = any(co))
       + (select count(*) from shifts where company_id = any(co) or admin_id = v_admin)
       + (select count(*) from employee_portal where employee_id = any(em))
       + (select count(*) from kiosk_devices where company_id = any(co))
       + (select count(*) from admin_sessions where admin_id = v_admin)
       + (select count(*) from audit_log where admin_id = v_admin)
       + (select count(*) from email_codes where lower(email) = lower(v_email))
    into n_left;
  if n_left <> 0 then raise exception 'Safety stop: % rows would remain. Nothing was deleted.', n_left; end if;

  summary := format('%s: %s company, %s employees, %s punches, %s archived punches, %s visitor rows, plus the admin account and its sessions and logs. Rows left behind: 0.',
                    case when v_dry then 'DRY RUN, rolled back' else 'DELETED' end, n_co, n_emp, n_punch, n_arch, n_vis);
  if v_dry then
    raise exception '%', summary;     -- an error on purpose: it undoes everything above
  else
    raise notice '%', summary;
  end if;
end $$;
